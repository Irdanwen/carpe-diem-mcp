/**
 * Per-user state in remote mode, keyed by the token's `sub`. Nothing here is
 * shared between users: each one has its own spend guard and request budget.
 */
import type { Config } from '../config.js'
import { SpendGuard } from '../spend-guard.js'
import type { RemoteConfig } from './config.js'

/** Classic token bucket: `capacity` requests at once, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity
    this.last = now
  }

  /** 0 when the request may go, else the seconds to wait. */
  take(now = Date.now()): number {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return 0
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond))
  }
}

interface UserState {
  guard: SpendGuard
  /** UTC day of the guard: the per-user budget (CARPE_MAX_SPEND_USD) is daily. */
  day: string
  bucket: TokenBucket
  lastSeen: number
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
const IDLE_MS = 24 * 60 * 60 * 1000

export class UserRegistry {
  private readonly users = new Map<string, UserState>()

  constructor(
    private readonly cfg: Config,
    private readonly rc: RemoteConfig,
  ) {}

  private state(sub: string, now: number): UserState {
    let u = this.users.get(sub)
    if (!u) {
      u = { guard: this.newGuard(), day: utcDay(now), bucket: new TokenBucket(this.rc.rateBurst, this.rc.ratePerMinute / 60, now), lastSeen: now }
      this.users.set(sub, u)
    }
    u.lastSeen = now
    return u
  }

  private newGuard(): SpendGuard {
    return new SpendGuard(this.cfg, 'Per signed-in user, since 00:00 UTC (in-memory, defense in depth). The authoritative daily cap is the one chosen when connecting, enforced by Carpe Diem.')
  }

  /** The user's spend guard for today. A guard is never shared between two `sub`. */
  guard(sub: string, now = Date.now()): SpendGuard {
    const u = this.state(sub, now)
    const day = utcDay(now)
    if (u.day !== day) {
      u.day = day
      u.guard = this.newGuard()
    }
    return u.guard
  }

  /** Rate limit: 0 = allowed, else Retry-After seconds. */
  take(sub: string, now = Date.now()): number {
    return this.state(sub, now).bucket.take(now)
  }

  /** Forget users idle for a day (their guard and bucket start fresh). */
  sweep(now = Date.now()): void {
    for (const [sub, u] of this.users) if (now - u.lastSeen > IDLE_MS) this.users.delete(sub)
  }

  get size(): number {
    return this.users.size
  }
}
