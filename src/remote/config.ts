/**
 * Remote (hosted, multi-user) mode: OAuth resource-server settings.
 *
 * The MCP server is an OAuth 2.1 protected resource (RFC 9728). It does not
 * issue tokens: users sign in on the authorization server (compte.carpe-diem.xyz)
 * and every request carries an access token whose `aud` names this server.
 */
import { ConfigError } from '../config.js'

/** Paid tools (inference on the user's connector key). */
export const SCOPE_INFERENCE = 'carpe:inference'
/** Account reads (balance, usage, top-up link). */
export const SCOPE_ACCOUNT_READ = 'carpe:account.read'
export const SUPPORTED_SCOPES = [SCOPE_INFERENCE, SCOPE_ACCOUNT_READ] as const

export const DEFAULT_ISSUER = 'https://compte.carpe-diem.xyz'
export const DEFAULT_PUBLIC_URL = 'https://mcp.carpe-diem.xyz'

export interface RemoteConfig {
  /** Authorization server issuer (`iss` of every token). */
  issuer: string
  /** This server's resource identifier (RFC 8707): PRM `resource`, required in the token `aud`. */
  resource: string
  /** JWKS URL; when absent it is read from the issuer's metadata (RFC 8414, then OIDC discovery). */
  jwksUrl: string | undefined
  /** Accepted JWS algorithms (default ES256, the issuer's signing algorithm). */
  algorithms: string[]
  /** Clock skew tolerated on nbf / iat (a token from the future), in seconds. Never on exp. */
  clockToleranceSec: number
  /** Token bucket per user: sustained requests per minute and burst size. */
  ratePerMinute: number
  rateBurst: number
  /** Live MCP sessions per user (the oldest is closed beyond it) and in total. */
  maxSessionsPerUser: number
  maxSessions: number
  /** Salt of the hashed user id written to the logs (random per process when unset). */
  logSalt: string | undefined
  /** Byte budget of the temporary media store (outputs too large to return inline, and the room held for them). */
  mediaStoreBytes: number
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/** https, or http on a loopback host (tests and local development only). No query, no fragment. */
function httpsUrl(name: string, raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ConfigError(`${name} must be an absolute URL.`)
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) {
    throw new ConfigError(`${name} must use https (http is accepted only on a loopback host).`)
  }
  if (u.search || u.hash) throw new ConfigError(`${name} must not have a query or a fragment.`)
  // Keep the configured spelling (no trailing slash added): it is compared with `iss` / `aud` verbatim.
  return raw.trim().replace(/\/+$/, '')
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const v = env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer ≥ ${min}.`)
  return n
}

export function loadRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const algorithms = (env.CARPE_OAUTH_ALGORITHMS ?? 'ES256').split(',').map((s) => s.trim()).filter(Boolean)
  if (!algorithms.length || algorithms.some((a) => a === 'none' || a.startsWith('HS'))) {
    throw new ConfigError('CARPE_OAUTH_ALGORITHMS must list asymmetric JWS algorithms (e.g. ES256).')
  }
  return {
    issuer: httpsUrl('CARPE_OAUTH_ISSUER', env.CARPE_OAUTH_ISSUER?.trim() || DEFAULT_ISSUER),
    resource: httpsUrl('CARPE_MCP_PUBLIC_URL', env.CARPE_MCP_PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL),
    jwksUrl: env.CARPE_OAUTH_JWKS_URL?.trim() ? httpsUrl('CARPE_OAUTH_JWKS_URL', env.CARPE_OAUTH_JWKS_URL) : undefined,
    algorithms,
    clockToleranceSec: int(env, 'CARPE_OAUTH_CLOCK_SKEW_S', 30, 0),
    ratePerMinute: int(env, 'CARPE_MCP_RATE_PER_MIN', 120, 1),
    rateBurst: int(env, 'CARPE_MCP_RATE_BURST', 30, 1),
    maxSessionsPerUser: int(env, 'CARPE_MCP_MAX_SESSIONS_PER_USER', 5, 1),
    maxSessions: int(env, 'CARPE_MCP_MAX_SESSIONS', 1000, 1),
    logSalt: env.CARPE_MCP_LOG_SALT?.trim() || undefined,
    // At least the largest single output (a 64 MiB video), so any one of them can be kept.
    mediaStoreBytes: int(env, 'CARPE_MCP_MEDIA_STORE_MB', 256, 64) * 1024 * 1024,
  }
}
