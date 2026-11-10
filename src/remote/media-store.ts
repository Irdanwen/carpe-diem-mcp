/**
 * Remote mode: temporary storage of produced media, so a paid output too large
 * to return inline is never thrown away.
 *
 * - In memory only (the hosted server writes nothing to disk), bounded by a
 *   global byte budget (CARPE_MCP_MEDIA_STORE_MB) and a TTL (1 hour).
 * - Each user (hashed `sub`) has a share of it (CARPE_MCP_MEDIA_STORE_PER_USER_MB),
 *   reservations included: one user filling the store cannot starve the others.
 * - A job's output is stored once per user: retrieving the same job again
 *   returns the existing link (and its expiry) instead of a new copy.
 * - Served without authentication at `GET /media/<id>`: the id is 128 random
 *   bits (base64url), a capability like the operator's own share links. The
 *   link goes only into the tool result of the user who paid for it.
 * - Reservations: a one-shot paid call (TTS, synchronous image, music
 *   retrieve) reserves room for its largest possible output BEFORE the call is
 *   made, so a full store refuses the call instead of losing what was paid.
 *   The budget therefore also bounds the output buffers in flight.
 * - Ids never appear in logs.
 */
import { randomBytes } from 'node:crypto'
import { LocalRefusal } from '../errors.js'
import { extFor, type LoadedMedia } from '../media.js'

export const MEDIA_TTL_MS = 60 * 60 * 1000

export interface StoredMedia {
  id: string
  url: string
  /** ISO 8601. */
  expiresAt: string
  mime: string
  bytes: number
  /** True when this output was already stored (the same job retrieved again). */
  existing?: boolean
}

interface Item {
  bytes: Buffer
  mime: string
  filename: string
  expires: number
  owner: string | undefined
  key: string | undefined
}

/** Who stores, and under which job key (dedupe). */
export interface StoreTag {
  /** Hashed `sub` of the user (per-user share). */
  owner?: string
  /** A job's output, e.g. its job_id: stored once per owner. */
  key?: string
}

/** Room held for an output that may arrive; `store` consumes it, `release` frees what is left. */
export interface Reservation {
  store: (media: LoadedMedia, prefix: string, key?: string) => StoredMedia
  release: () => void
}

export const ID_RE = /^[A-Za-z0-9_-]{22}$/

/** Content types served as such (inline); anything else is an attachment of type application/octet-stream. */
const SAFE_MIME = /^(image\/(png|jpeg|webp|gif)|audio\/[a-z0-9.+-]{1,40}|video\/[a-z0-9.+-]{1,40})$/

export class MediaStore {
  private readonly items = new Map<string, Item>()
  /** owner + key → id. */
  private readonly keys = new Map<string, string>()
  /** owner → bytes stored or reserved. */
  private readonly owners = new Map<string, number>()
  private used = 0
  private reserved = 0

  constructor(
    readonly maxBytes: number,
    private readonly publicUrl: string,
    readonly ttlMs = MEDIA_TTL_MS,
    private readonly now: () => number = Date.now,
    /** Each owner's share (stored + reserved). */
    readonly perOwnerBytes = maxBytes,
  ) {}

  /** Bytes neither stored nor reserved. */
  get free(): number {
    this.sweep()
    return this.maxBytes - this.used - this.reserved
  }

  /** What `owner` may still store or reserve. */
  freeFor(owner: string | undefined): number {
    const global = this.free
    return owner === undefined ? global : Math.min(global, this.perOwnerBytes - (this.owners.get(owner) ?? 0))
  }

  get size(): number {
    return this.items.size
  }

  private full(bytes: number, owner: string | undefined): LocalRefusal {
    const mine = owner !== undefined && this.perOwnerBytes - (this.owners.get(owner) ?? 0) < bytes
    return new LocalRefusal(
      'MEDIA_STORE_FULL',
      mine
        ? `Your share of the hosted server's temporary media storage (${Math.round(this.perOwnerBytes / 1048576)} MiB, files kept one hour) is full: ${Math.ceil(bytes / 1048576)} MiB needed.`
        : `The hosted server's temporary media storage is full (${Math.ceil(bytes / 1048576)} MiB needed).`,
      'Retry in a few minutes (stored files expire after an hour), or use the local server (npx carpe-diem-mcp), which saves outputs to disk.',
    )
  }

  private charge(owner: string | undefined, n: number): void {
    if (owner === undefined) return
    const v = (this.owners.get(owner) ?? 0) + n
    if (v > 0) this.owners.set(owner, v)
    else this.owners.delete(owner)
  }

  private keyOf(owner: string | undefined, key: string | undefined): string | undefined {
    return key === undefined ? undefined : `${owner ?? ''}\u0000${key}`
  }

  /** The live output already stored for this owner and job key, if any. */
  find(tag: StoreTag): StoredMedia | undefined {
    const k = this.keyOf(tag.owner, tag.key)
    const id = k && this.keys.get(k)
    const it = id ? this.get(id) : undefined
    return id && it ? this.describe(id, it, true) : undefined
  }

  /** Hold `bytes` of room for `owner`, or throw MEDIA_STORE_FULL. */
  reserve(bytes: number, owner?: string): Reservation {
    if (bytes > this.freeFor(owner)) throw this.full(bytes, owner)
    this.reserved += bytes
    this.charge(owner, bytes)
    let left = bytes
    return {
      store: (media, prefix, key) => {
        const again = this.find({ owner, key })
        if (again) return again
        const n = media.bytes.length
        const fromHold = Math.min(left, n)
        // Beyond what was held, the rest must fit in what is free (globally and for this owner).
        if (n - fromHold > this.freeFor(owner)) throw this.full(n, owner)
        left -= fromHold
        this.reserved -= fromHold
        this.charge(owner, -fromHold)
        return this.add(media, prefix, owner, key)
      },
      release: () => {
        this.reserved -= left
        this.charge(owner, -left)
        left = 0
      },
    }
  }

  /** Store without a prior reservation (the output can be fetched again if this fails). */
  put(media: LoadedMedia, prefix: string, tag: StoreTag = {}): StoredMedia {
    const again = this.find(tag)
    if (again) return again
    if (media.bytes.length > this.freeFor(tag.owner)) throw this.full(media.bytes.length, tag.owner)
    return this.add(media, prefix, tag.owner, tag.key)
  }

  private add(media: LoadedMedia, prefix: string, owner: string | undefined, key: string | undefined): StoredMedia {
    const id = randomBytes(16).toString('base64url')
    const expires = this.now() + this.ttlMs
    const mime = SAFE_MIME.test(media.mime) ? media.mime : 'application/octet-stream'
    const item: Item = { bytes: media.bytes, mime, filename: `${prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'media'}.${extFor(media.mime)}`, expires, owner, key: this.keyOf(owner, key) }
    this.items.set(id, item)
    if (item.key) this.keys.set(item.key, id)
    this.used += media.bytes.length
    this.charge(owner, media.bytes.length)
    return this.describe(id, item, false)
  }

  private describe(id: string, it: Item, existing: boolean): StoredMedia {
    return { id, url: `${this.publicUrl}/media/${id}`, expiresAt: new Date(it.expires).toISOString(), mime: it.mime, bytes: it.bytes.length, ...(existing ? { existing } : {}) }
  }

  /** The live item, or undefined (unknown, malformed or expired id). */
  get(id: string): Item | undefined {
    if (!ID_RE.test(id)) return undefined
    const it = this.items.get(id)
    if (!it) return undefined
    if (it.expires <= this.now()) {
      this.drop(id, it)
      return undefined
    }
    return it
  }

  private drop(id: string, it: Item): void {
    this.items.delete(id)
    if (it.key && this.keys.get(it.key) === id) this.keys.delete(it.key)
    this.used -= it.bytes.length
    this.charge(it.owner, -it.bytes.length)
  }

  sweep(now = this.now()): void {
    for (const [id, it] of this.items) if (it.expires <= now) this.drop(id, it)
  }

  /** Drop every stored item (reservations in flight stay counted). */
  clear(): void {
    for (const [id, it] of [...this.items]) this.drop(id, it)
  }
}
