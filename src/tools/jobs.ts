/** Polling for the operator's async jobs (image / video / music). */
import type { CarpeResponse, AuthKind } from '../carpe-client.js'
import { errorFromBody } from '../errors.js'
import { progress, sleep, type ToolContext, type ToolExtra } from './context.js'

export interface PollResult {
  done: boolean
  /** Binary response (image / audio / video) once finished. */
  res?: CarpeResponse
  /** Last JSON status (pending/processing, or a completed JSON like video_url). */
  status?: Record<string, unknown>
}

/**
 * POST `path` with `body` until it returns media, a completed JSON, or the
 * wait budget runs out. `200 {status:"failed"}` is thrown as a CarpeError.
 */
export async function pollJob(
  ctx: ToolContext,
  extra: ToolExtra,
  opts: { path: string; body: Record<string, unknown>; auth: AuthKind; waitSeconds: number; intervalMs?: number; label: string; maxBytes?: number },
): Promise<PollResult> {
  const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000
  const interval = opts.intervalMs ?? 3000
  let n = 0
  for (;;) {
    const res = await ctx.client.request({
      method: 'POST',
      path: opts.path,
      json: opts.body,
      auth: opts.auth,
      retry: 'read',
      maxBytes: opts.maxBytes ?? ctx.cfg.maxMediaBytes,
      signal: extra.signal,
    })
    if (!res.isJson) return { done: true, res }
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
