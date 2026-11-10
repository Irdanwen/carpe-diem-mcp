/**
 * Remote mode: temporary storage of produced media, so a paid output too large
 * to return inline is never thrown away.
 *
 * - In memory only (the hosted server writes nothing to disk), bounded by a
 *   global byte budget (CARPE_MCP_MEDIA_STORE_MB) and a TTL (1 hour).
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
}

interface Item {
  bytes: Buffer
  mime: string
  filename: string
  expires: number
}

/** Room held for an output that may arrive; `store` consumes it, `release` frees what is left. */
export interface Reservation {
  store: (media: LoadedMedia, prefix: string) => StoredMedia
  release: () => void
}

export const ID_RE = /^[A-Za-z0-9_-]{22}$/

/** Content types served as such (inline); anything else is an attachment of type application/octet-stream. */
const SAFE_MIME = /^(image\/(png|jpeg|webp|gif)|audio\/[a-z0-9.+-]{1,40}|video\/[a-z0-9.+-]{1,40})$/

export class MediaStore {
  private readonly items = new Map<string, Item>()
  private used = 0
  private reserved = 0

  constructor(
    readonly maxBytes: number,
    private readonly publicUrl: string,
    readonly ttlMs = MEDIA_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Bytes neither stored nor reserved. */
  get free(): number {
    this.sweep()
    return this.maxBytes - this.used - this.reserved
  }

  get size(): number {
    return this.items.size
  }

  private full(bytes: number): LocalRefusal {
    return new LocalRefusal(
      'MEDIA_STORE_FULL',
      `The hosted server's temporary media storage is full (${Math.ceil(bytes / 1048576)} MiB needed).`,
      'Retry in a few minutes (stored files expire after an hour), or use the local server (npx carpe-diem-mcp), which saves outputs to disk.',
    )
  }

  /** Hold `bytes` of room, or throw MEDIA_STORE_FULL. */
  reserve(bytes: number): Reservation {
    if (bytes > this.free) throw this.full(bytes)
    this.reserved += bytes
    let left = bytes
    const release = () => {
      this.reserved -= left
      left = 0
    }
    return {
      store: (media, prefix) => {
        const n = media.bytes.length
        const fromHold = Math.min(left, n)
        // Beyond what was held, the rest must fit in the free room.
        if (n - fromHold > this.free) throw this.full(n)
        left -= fromHold
        this.reserved -= fromHold
        return this.add(media, prefix)
      },
      release,
    }
  }

  /** Store without a prior reservation (the output can be fetched again if this fails). */
  put(media: LoadedMedia, prefix: string): StoredMedia {
    if (media.bytes.length > this.free) throw this.full(media.bytes.length)
    return this.add(media, prefix)
  }

  private add(media: LoadedMedia, prefix: string): StoredMedia {
    const id = randomBytes(16).toString('base64url')
    const expires = this.now() + this.ttlMs
    const mime = SAFE_MIME.test(media.mime) ? media.mime : 'application/octet-stream'
    this.items.set(id, { bytes: media.bytes, mime, filename: `${prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'media'}.${extFor(media.mime)}`, expires })
    this.used += media.bytes.length
    return { id, url: `${this.publicUrl}/media/${id}`, expiresAt: new Date(expires).toISOString() }
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
    this.used -= it.bytes.length
  }

  sweep(now = this.now()): void {
    for (const [id, it] of this.items) if (it.expires <= now) this.drop(id, it)
  }

  clear(): void {
    this.items.clear()
    this.used = 0
  }
}
