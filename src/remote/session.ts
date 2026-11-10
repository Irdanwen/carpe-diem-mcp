/**
 * One MCP server per remote session, bound to one user (`sub`).
 *
 * - Its CarpeClient relays the user's latest validated access token, never a key.
 * - Its spend guard is the user's own (per `sub`), shared by that user's sessions only.
 * - Tools the token's scopes do not cover are hidden (and refused if called).
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CarpeClient } from '../carpe-client.js'
import type { Config } from '../config.js'
import { LocalRefusal } from '../errors.js'
import { createMcpServer } from '../server.js'
import type { Estimator, SpendGuard } from '../spend-guard.js'
import { fail, type ToolContext, type ToolDef, type ToolExtra } from '../tools/context.js'
import { buildTools } from '../tools/index.js'
import { safeCode, type RemoteLogger } from './log.js'
import type { MediaStore } from './media-store.js'
import { REMOTE_REMOVED_TOOLS, requiredScope } from './policy.js'

export interface RemoteSessionOptions {
  cfg: Config
  /** Shared, credential-less: reads only public prices and quotes. */
  estimator: Estimator
  /** The user's guard (resolved at call time: it rolls over daily). */
  guard: () => SpendGuard
  /** The user's current access token. */
  token: () => string | undefined
  /** The operator refused a relayed token as invalid. */
  onTokenRejected?: (token: string) => void
  scopes: readonly string[]
  user: string
  log: RemoteLogger
  fetchImpl?: typeof fetch
  /** Shared temporary media store (GET /media/<id>). */
  store?: MediaStore
}

export interface RemoteMcp {
  server: McpServer
  client: CarpeClient
  tools: ToolDef[]
  /** Show exactly the tools the current token's scopes allow. */
  applyScopes: (scopes: readonly string[]) => void
}

export function buildRemoteServer(opts: RemoteSessionOptions): RemoteMcp {
  const { cfg } = opts
  const client = new CarpeClient(cfg, undefined, opts.fetchImpl, opts.token, opts.onTokenRejected)
  const ctx: ToolContext = {
    client,
    cfg,
    estimator: opts.estimator,
    get guard() {
      return opts.guard()
    },
    media: { allowLocalFiles: false, outputDir: undefined, maxInputBytes: cfg.maxMediaBytes, remote: true, store: opts.store },
  }
  const tools = buildTools(ctx).filter((t) => !REMOTE_REMOVED_TOOLS.has(t.name))

  const wrap = (t: ToolDef): ToolDef['handler'] => {
    const scope = requiredScope(t)
    return async (args, extra: ToolExtra & { authInfo?: { scopes?: string[] } }) => {
      const started = Date.now()
      let result: CallToolResult
      // Checked on the request's own token: the HTTP layer already answered 403 insufficient_scope; this is defense in depth.
      if (scope && !(extra.authInfo?.scopes ?? []).includes(scope)) {
        result = fail(new LocalRefusal('INSUFFICIENT_SCOPE', `${t.name} needs the ${scope} permission, which this connection was not granted.`, 'Reconnect the Carpe Diem connector and allow it.'))
      } else {
        try {
          result = await t.handler(args, extra)
        } catch (err) {
          result = fail(err)
        }
      }
      const code = result.isError ? safeCode((result.structuredContent as { error?: { code?: unknown } } | undefined)?.error?.code) ?? 'ERROR' : undefined
      opts.log({ event: 'tool', tool: t.name, outcome: result.isError ? 'error' : 'ok', ...(code ? { code } : {}), ms: Date.now() - started, user: opts.user })
      return result
    }
  }

  const { server, registered } = createMcpServer(cfg, tools, client, wrap)
  const scopeOf = new Map(tools.map((t) => [t.name, requiredScope(t)]))
  let current = ''
  const applyScopes = (scopes: readonly string[]) => {
    const key = [...scopes].sort().join(' ')
    if (key === current) return
    current = key
    for (const [name, reg] of registered as Map<string, RegisteredTool>) {
      const scope = scopeOf.get(name)
      const allowed = !scope || scopes.includes(scope)
      if (allowed && !reg.enabled) reg.enable()
      else if (!allowed && reg.enabled) reg.disable()
    }
  }
  applyScopes(opts.scopes)
  return { server, client, tools, applyScopes }
}

/** Tool name → required scope, for the HTTP layer's scope challenge (no session needed). */
export function remoteToolScopes(cfg: Config, estimator: Estimator): Map<string, string | undefined> {
  const client = new CarpeClient(cfg)
  const ctx: ToolContext = {
    client,
    cfg,
    estimator,
    get guard(): SpendGuard {
      throw new Error('not used')
    },
    media: { allowLocalFiles: false, outputDir: undefined, maxInputBytes: cfg.maxMediaBytes, remote: true },
  }
  return new Map(buildTools(ctx).filter((t) => !REMOTE_REMOVED_TOOLS.has(t.name)).map((t) => [t.name, requiredScope(t)]))
}
