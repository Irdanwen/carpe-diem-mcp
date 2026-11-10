/** Polling for the operator's async jobs (image / video / music). */
import type { CarpeResponse, AuthKind } from '../carpe-client.js'
import { errorFromBody } from '../errors.js'
import type { Reservation } from '../remote/media-store.js'
import { progress, sleep, type ToolContext, type ToolExtra } from './context.js'

export interface PollResult {
  done: boolean
  /** Binary response (image / audio / video) once finished. */
  res?: CarpeResponse
  /** Last JSON status (pending/processing, or a completed JSON like video_url). */
  status?: Record<string, unknown>
  /** Remote mode: the media-store room held for `res` (the caller stores into it, then releases it). */
  hold?: Reservation
}

/**
 * POST `path` with `body` until it returns media, a completed JSON, or the
 * wait budget runs out. `200 {status:"failed"}` is thrown as a CarpeError.
 *
 * `reserve` (remote mode, media retrieves): called before each request; a
 * full store throws before the request is sent, so a result is never fetched
 * without room to keep it (a one-shot track, a router video of up to
 * CARPE_MAX_VIDEO_BYTES).
 *
 * `shareKey` (remote mode): concurrent requests of callers with the same key
 * (the user and the job) are one request, whose result they share — one
 * download and one reservation (see remote/single-flight.ts). The reservation
 * is then shared too: the first caller to store the output consumes it, the
 * others find the stored copy, and each releases what is left (idempotent).
 */
export async function pollJob(
  ctx: ToolContext,
  extra: ToolExtra,
  opts: { path: string; body: Record<string, unknown>; auth: AuthKind; waitSeconds: number; intervalMs?: number; label: string; maxBytes?: number; reserve?: () => Reservation | undefined; shareKey?: string },
): Promise<PollResult> {
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000
  const interval = opts.intervalMs ?? 3000
  const once = async (signal: AbortSignal | undefined): Promise<{ res: CarpeResponse; hold?: Reservation }> => {
    const hold = opts.reserve?.()
    let res: CarpeResponse
    try {
      res = await ctx.client.request({
        method: 'POST',
        path: opts.path,
        json: opts.body,
        auth: opts.auth,
        retry: 'read',
        maxBytes: opts.maxBytes ?? ctx.cfg.maxMediaBytes,
        signal,
      })
    } catch (err) {
      hold?.release()
      throw err
    }
    if (res.isJson) {
      hold?.release()
      return { res }
    }
    return { res, hold }
  }
  const flights = opts.shareKey !== undefined && ctx.media.remote ? ctx.media.store?.flights : undefined
  let n = 0
  for (;;) {
    const { res, hold } = flights ? await flights.run(`${ctx.media.owner ?? ''}\u0000${opts.shareKey}`, once, extra.signal) : await once(extra.signal)
    if (!res.isJson) return { done: true, res, hold }
    const status = res.json<Record<string, unknown>>()
    const s = String(status.status ?? '').toLowerCase()
    if (s === 'failed' || s === 'error') throw errorFromBody(200, status)
    if (s === 'completed' || s === 'complete' || s === 'succeeded') return { done: true, status }
    n++
    if (Date.now() + interval > deadline) return { done: false, status }
    await progress(extra, n, undefined, `${opts.label}: ${s || 'pending'}`)
    await sleep(interval, extra.signal)
  }
}
