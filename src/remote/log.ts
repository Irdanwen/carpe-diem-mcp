/**
 * Remote-mode logging. One JSON line per event, with metadata only:
 * HTTP/JSON-RPC method, tool name, status, duration, error code and a keyed
 * hash of the user's `sub`. Never prompts, tool arguments, outputs, tokens or
 * error messages (they can quote user input).
 */
import { createHmac, randomBytes } from 'node:crypto'

export type RemoteLogger = (entry: Record<string, unknown>) => void

export const stderrLogger: RemoteLogger = (entry) => {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`)
}

/** HMAC of the sub: stable within a deployment (CARPE_MCP_LOG_SALT) for correlation, useless outside it. */
export function subHasher(salt: string | undefined): (sub: string) => string {
  const key = salt ?? randomBytes(32).toString('hex')
  return (sub) => createHmac('sha256', key).update(sub).digest('hex').slice(0, 16)
}

/** An error code is logged only when it looks like one (an operator could echo free text in `code`). */
export const safeCode = (code: unknown): string | undefined => (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : code === undefined ? undefined : 'OTHER')

/** A tool name from the request, logged only when it is one of ours. */
export const safeName = (name: unknown, known: (n: string) => boolean): string | undefined =>
  typeof name === 'string' ? (known(name) ? name : 'unknown') : undefined
