/**
 * Access tokens the operator has refused as invalid (connector revoked, token
 * revoked): the MCP server answers them `401 invalid_token` itself from then
 * on, so the client (claude.ai, ChatGPT) starts the OAuth flow again instead of
 * keeping a session whose every tool call fails until the token expires.
 *
 * Only a hash is kept, until the token's own expiry. Bounded: beyond the cap the
 * entries closest to expiry make room (a dropped entry only means the operator
 * refuses that token again on its next call).
 */
import { createHash } from 'node:crypto'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export class DeadTokens {
  private readonly until = new Map<string, number>()

  constructor(private readonly max = 50_000) {}

  add(token: string, untilMs: number, now = Date.now()): void {
    if (!(untilMs > now)) return
    this.until.set(hash(token), untilMs)
    if (this.until.size > this.max) {
      const soonest = [...this.until.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.until.size - this.max)
      for (const [k] of soonest) this.until.delete(k)
    }
  }

  has(token: string, now = Date.now()): boolean {
    const t = this.until.get(hash(token))
    if (t === undefined) return false
    if (t <= now) {
      this.until.delete(hash(token))
      return false
    }
    return true
  }

  sweep(now = Date.now()): void {
    for (const [k, t] of this.until) if (t <= now) this.until.delete(k)
  }

  get size(): number {
    return this.until.size
  }
}
