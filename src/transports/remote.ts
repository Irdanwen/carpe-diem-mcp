/**
 * Remote (hosted, multi-user) Streamable HTTP transport: `carpe-mcp --remote`.
 *
 * The server is an OAuth 2.1 protected resource (MCP authorization spec):
 *   - `/.well-known/oauth-protected-resource` (RFC 9728, also under `/mcp`)
 *     names the authorization server; a request without a valid token gets
 *     `401` + `WWW-Authenticate: Bearer resource_metadata="…"`, which starts
 *     the OAuth flow in ChatGPT / claude.ai;
 *   - every request is re-validated (signature, iss, aud, exp, scopes);
 *   - a session belongs to the `sub` that opened it: another user presenting
 *     its id gets `403`;
 *   - the user's token is relayed to the operator, which resolves it to the
 *     connector's own key; this process holds no credential;
 *   - per-user spend guard, rate limit and session cap;
 *   - logs carry metadata only (see remote/log.ts); `/health` says nothing about users.
 */
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js'
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { InsufficientScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { CarpeClient } from '../carpe-client.js'
import { loadConfig, type Config } from '../config.js'
import { loadRemoteConfig, SUPPORTED_SCOPES, type RemoteConfig } from '../remote/config.js'
import { safeName, stderrLogger, subHasher, type RemoteLogger } from '../remote/log.js'
import { REMOTE_REMOVED_TOOLS } from '../remote/policy.js'
import { buildRemoteServer, remoteToolScopes, type RemoteMcp } from '../remote/session.js'
import { JwtAccessTokenVerifier } from '../remote/token.js'
import { UserRegistry } from '../remote/users.js'
import { DeadTokens } from '../remote/dead-tokens.js'
import { Estimator } from '../spend-guard.js'
import { TOOL_ANNOTATIONS } from '../tools/annotations.js'

const SESSION_TTL_MS = 30 * 60 * 1000

interface RemoteSession {
  transport: StreamableHTTPServerTransport
  mcp: RemoteMcp
  sub: string
  /** Latest validated access token of this session's user: what the operator receives. */
  token: string
  lastSeen: number
}

export interface RemoteAppOptions {
  cfg?: Config
  remote?: RemoteConfig
  /** Token verifier (default: JWT + JWKS of the configured issuer). */
  verifier?: OAuthTokenVerifier
  log?: RemoteLogger
  /** Operator fetch (tests). */
  fetchImpl?: typeof fetch
  allowedOrigins?: string[]
}

export interface RemoteApp {
  app: express.Express
  /** Live sessions (tests and health). */
  sessions: Map<string, RemoteSession>
  users: UserRegistry
  close: () => Promise<void>
}

const rpcError = (res: Response, status: number, message: string, headers: Record<string, string> = {}) => {
  res.status(status).set(headers).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })
}

const messagesOf = (body: unknown): Record<string, any>[] => (Array.isArray(body) ? body : body && typeof body === 'object' ? [body as Record<string, any>] : [])

export function createRemoteApp(opts: RemoteAppOptions = {}): RemoteApp {
  const cfg = opts.cfg ?? loadConfig()
  if (!cfg.remote) throw new Error('createRemoteApp needs a remote-mode configuration (CARPE_MCP_REMOTE=1).')
  const rc = opts.remote ?? loadRemoteConfig()
  const signatureVerifier = opts.verifier ?? new JwtAccessTokenVerifier(rc)
  // A token the operator refused as invalid (connector revoked…) gets 401 here too, so the client signs in again.
  const dead = new DeadTokens()
  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token) => {
      const info = await signatureVerifier.verifyAccessToken(token)
      if (dead.has(token)) throw new InvalidTokenError('Token has been revoked')
      return info
    },
  }
  const onTokenRejected = (token: string) => {
    let expSec: unknown
    try {
      expSec = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))?.exp
    } catch {
      /* not a JWT: keep it for the longest access-token life */
    }
    const untilMs = typeof expSec === 'number' ? (expSec + rc.clockToleranceSec) * 1000 : Date.now() + 3600_000
    dead.add(token, untilMs)
  }
  const log = opts.log ?? stderrLogger
  const hashSub = subHasher(rc.logSalt)
  const allowedOrigins = new Set(opts.allowedOrigins ?? [])
  const sessions = new Map<string, RemoteSession>()
  const users = new UserRegistry(cfg, rc)
  // Shared by every user, and harmless: it only reads public prices and quotes, with no credential.
  const estimator = new Estimator(new CarpeClient(cfg, undefined, opts.fetchImpl))
  const known = (n: string) => n in TOOL_ANNOTATIONS && !REMOTE_REMOVED_TOOLS.has(n)

  const resourceUrl = new URL(rc.resource)
  const prmUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)
  const prm: OAuthProtectedResourceMetadata = {
    resource: rc.resource,
    authorization_servers: [rc.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Carpe Diem',
    resource_documentation: 'https://github.com/Irdanwen/carpe-diem-mcp#remote-mode-hosted',
  }

  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  // RFC 9728 metadata: at the root, under the resource path, and under /mcp (where MCP clients look first).
  const prmPaths = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', new URL(prmUrl).pathname])
  for (const p of prmPaths) app.use(p, metadataHandler(prm) as unknown as express.RequestHandler)

  const originCheck = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin
    if (origin && !allowedOrigins.has(origin)) return void res.status(403).json({ error: 'Origin not allowed' })
    next()
  }

  // Validates the token on every request and answers 401 / WWW-Authenticate (resource_metadata) on failure.
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: prmUrl, expectedResource: resourceUrl }) as unknown as express.RequestHandler

  const subOf = (req: Request) => String(req.auth?.extra?.sub ?? '')

  const rateLimit = (req: Request, res: Response, next: NextFunction) => {
    const wait = users.take(subOf(req))
    if (wait > 0) return void rpcError(res, 429, 'Too many requests for this account; slow down.', { 'Retry-After': String(wait) })
    next()
  }

  // Bodies are parsed only after authentication. A parse error is answered without echoing (or logging) the body.
  const json = express.json({ limit: '40mb' })

  // Request log: method, tool, status, duration, hashed user. Registered first so 401s are logged too.
  const access = (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now()
    res.on('finish', () => {
      const msgs = messagesOf(req.body)
      // A method name is client-chosen text: logged only when it has the shape of one.
      const rpc = msgs.map((m) => (typeof m.method === 'string' && /^[A-Za-z0-9_/.-]{1,64}$/.test(m.method) ? m.method : 'other'))
      const tools = msgs.filter((m) => m.method === 'tools/call').map((m) => safeName(m.params?.name, known))
      const sub = req.auth ? subOf(req) : ''
      log({
        event: 'request',
        http: req.method,
        ...(rpc.length ? { rpc: rpc.join(',') } : {}),
        ...(tools.length ? { tool: tools.join(',') } : {}),
        status: res.statusCode,
        ms: Date.now() - started,
        ...(sub ? { user: hashSub(sub) } : {}),
      })
    })
    next()
  }

  /** The session named by Mcp-Session-Id, checked against the caller's `sub`. Answers the error itself. */
  const sessionFor = (req: Request, res: Response): RemoteSession | undefined | null => {
    const sid = req.header('mcp-session-id')
    if (!sid) return undefined
    const s = sessions.get(sid)
    if (!s) {
      // Spec: an unknown or expired session is 404, and the client starts a new one.
      rpcError(res, 404, 'Session not found: send a new initialize request.')
      return null
    }
    if (s.sub !== subOf(req)) {
      rpcError(res, 403, 'This session belongs to another account.')
      return null
    }
    s.token = req.auth!.token
    s.lastSeen = Date.now()
    s.mcp.applyScopes(req.auth!.scopes)
    return s
  }

  /** Step-up (MCP authorization, scope challenge): a tool the token's scopes do not cover → 403 insufficient_scope. */
  const scopeChallenge = (req: Request, res: Response): boolean => {
    const granted = req.auth!.scopes
    for (const m of messagesOf(req.body)) {
      if (m.method !== 'tools/call' || typeof m.params?.name !== 'string' || !known(m.params.name)) continue
      const scope = toolScopes.get(m.params.name)
      if (scope && !granted.includes(scope)) {
        const wanted = [...new Set([...granted.filter((g) => (SUPPORTED_SCOPES as readonly string[]).includes(g)), scope])].join(' ')
        const err = new InsufficientScopeError(`This tool needs the ${scope} scope`)
        res
          .status(403)
          .set('WWW-Authenticate', `Bearer error="insufficient_scope", error_description="${err.message}", scope="${wanted}", resource_metadata="${prmUrl}"`)
          .json(err.toResponseObject())
        return false
      }
    }
    return true
  }

  const toolScopes = remoteToolScopes(cfg, estimator)

  const closeSession = (id: string) => {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    s.transport.close().catch(() => undefined)
  }

  app.post('/mcp', access, originCheck, bearer, rateLimit, json, async (req, res) => {
    const existing = sessionFor(req, res)
    if (existing === null) return
    if (!scopeChallenge(req, res)) return
    let session = existing
    if (!session) {
      if (!isInitializeRequest(req.body)) return void rpcError(res, 400, 'No valid session: send an initialize request first.')
      const sub = subOf(req)
      // Per-user cap: the user's least recently used session makes room.
      const mine = [...sessions.entries()].filter(([, s]) => s.sub === sub).sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (let i = 0; i <= mine.length - rc.maxSessionsPerUser; i++) closeSession(mine[i][0])
      if (sessions.size >= rc.maxSessions) return void rpcError(res, 503, 'Too many sessions.')
      let created!: RemoteSession
      const mcp = buildRemoteServer({
        cfg,
        estimator,
        guard: () => users.guard(sub),
        // Later requests of this session update `token` in place (sessionFor).
        token: () => created.token,
        onTokenRejected,
        scopes: req.auth!.scopes,
        user: hashSub(sub),
        log,
        fetchImpl: opts.fetchImpl,
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, created)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      created = { transport, mcp, sub, token: req.auth!.token, lastSeen: Date.now() }
      await mcp.server.connect(transport)
      session = created
    }
    await session.transport.handleRequest(req, res, req.body)
  })

  const forward = async (req: Request, res: Response) => {
    const session = sessionFor(req, res)
    if (session === null) return
    if (!session) return void rpcError(res, 400, 'Mcp-Session-Id header required.')
    await session.transport.handleRequest(req, res)
  }
  app.get('/mcp', access, originCheck, bearer, rateLimit, forward)
  app.delete('/mcp', access, originCheck, bearer, rateLimit, forward)

  // Last-resort error handler: a fixed answer, never the error message (a JSON parse error quotes the body).
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return
    if (err?.type === 'entity.too.large') return void rpcError(res, 413, 'Request body too large.')
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })
    rpcError(res, err?.status && err.status >= 400 && err.status < 500 ? err.status : 500, 'Request failed.')
  })

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) closeSession(id)
    users.sweep(now)
    dead.sweep(now)
  }, 60_000)
  sweep.unref()

  return {
    app,
    sessions,
    users,
    close: async () => {
      clearInterval(sweep)
      for (const id of [...sessions.keys()]) closeSession(id)
    },
  }
}

export async function runRemote(opts: { port: number; host?: string }): Promise<Server> {
  const host = opts.host ?? process.env.CARPE_MCP_HOST ?? '127.0.0.1'
  const cfg = loadConfig()
  const rc = loadRemoteConfig()
  const allowedOrigins = (process.env.CARPE_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const { app } = createRemoteApp({ cfg, remote: rc, allowedOrigins })
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(opts.port, host, () => resolve(s))
  })
  console.error(`[carpe-mcp] remote mode on http://${host}:${opts.port}/mcp — resource ${rc.resource}, issuer ${rc.issuer}`)
  return server
}
