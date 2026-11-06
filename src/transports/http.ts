/**
 * Streamable HTTP transport.
 *
 * The server spends the operator credentials it is configured with, so:
 *   - it binds to 127.0.0.1 by default;
 *   - any other host requires CARPE_MCP_AUTH_TOKEN (≥ 16 chars), checked in
 *     constant time on every request (Authorization: Bearer <token>);
 *   - browser Origins are refused unless listed in CARPE_MCP_ALLOWED_ORIGINS;
 *   - local file inputs and private-host URLs are disabled;
 *   - sessions are capped and expire when idle.
 */
import express from 'express'
import type { Request, Response } from 'express'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { buildServer } from '../server.js'

const MAX_SESSIONS = 100
const SESSION_TTL_MS = 30 * 60 * 1000
const MIN_TOKEN = 16

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (isIP(h) === 4) return h.startsWith('127.')
  if (isIP(h) === 6) return h === '::1'
  return false
}

export function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true
  const m = header ? /^Bearer\s+(.+)$/i.exec(header) : null
  if (!m) return false
  const a = Buffer.from(m[1].trim())
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validateHttpConfig(host: string, token: string | undefined, allowUnauthenticated = process.env.CARPE_MCP_ALLOW_UNAUTHENTICATED_HTTP === '1'): void {
  if (token !== undefined && token.length < MIN_TOKEN) throw new Error(`CARPE_MCP_AUTH_TOKEN must be at least ${MIN_TOKEN} characters.`)
  if (isLoopbackHost(host) || allowUnauthenticated) return
  if (!token) {
    throw new Error('CARPE_MCP_AUTH_TOKEN is required when the HTTP server binds beyond loopback. Set CARPE_MCP_ALLOW_UNAUTHENTICATED_HTTP=1 only behind a trusted authenticating proxy.')
  }
}

interface Session {
  transport: StreamableHTTPServerTransport
  lastSeen: number
}

export async function runHttp(opts: { port: number; host?: string }): Promise<void> {
  const host = opts.host ?? process.env.CARPE_MCP_HOST ?? '127.0.0.1'
  const token = process.env.CARPE_MCP_AUTH_TOKEN?.trim() || undefined
  validateHttpConfig(host, token)
  const allowedOrigins = new Set((process.env.CARPE_MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  const sessions = new Map<string, Session>()

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '40mb' }))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: sessions.size })
  })

  const guard = (req: Request, res: Response): boolean => {
    const origin = req.headers.origin
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: 'Origin not allowed' })
      return false
    }
    if (!isAuthorized(req.headers.authorization, token)) {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    return true
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > SESSION_TTL_MS) {
        sessions.delete(id)
        s.transport.close().catch(() => undefined)
      }
    }
  }, 60_000)
  sweep.unref()

  app.post('/mcp', async (req, res) => {
    if (!guard(req, res)) return
    const sid = req.header('mcp-session-id')
    let session = sid ? sessions.get(sid) : undefined
    if (!session) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session: send an initialize request first.' }, id: null })
        return
      }
      if (sessions.size >= MAX_SESSIONS) {
        res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions.' }, id: null })
        return
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastSeen: Date.now() })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      const { server } = buildServer({ allowLocalFiles: false })
      await server.connect(transport)
      session = { transport, lastSeen: Date.now() }
    }
    session.lastSeen = Date.now()
    await session.transport.handleRequest(req, res, req.body)
  })

  const forward = async (req: Request, res: Response) => {
    if (!guard(req, res)) return
    const sid = req.header('mcp-session-id')
    const session = sid ? sessions.get(sid) : undefined
    if (!session) {
      res.status(400).send('Unknown session')
      return
    }
    session.lastSeen = Date.now()
    await session.transport.handleRequest(req, res)
  }
  app.get('/mcp', forward)
  app.delete('/mcp', forward)

  await new Promise<void>((resolve) => app.listen(opts.port, host, () => resolve()))
  console.error(`[carpe-mcp] Streamable HTTP on http://${host}:${opts.port}/mcp${token ? ' (bearer token required)' : ' (no token: loopback only)'}`)
}
