import type { ZodRawShape } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Config, Surface } from '../config.js'
import type { CallMeta, CarpeClient, CarpeResponse, RequestOptions } from '../carpe-client.js'
import type { Estimator, SpendGuard } from '../spend-guard.js'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extFor, saveMedia, type LoadedMedia, type MediaPolicy } from '../media.js'
import { describeError, LocalRefusal } from '../errors.js'
import type { Reservation } from '../remote/media-store.js'

export interface ToolContext {
  client: CarpeClient
  cfg: Config
  guard: SpendGuard
  estimator: Estimator
  media: MediaPolicy
}

export interface ToolExtra {
  signal?: AbortSignal
  sendNotification?: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>
  _meta?: { progressToken?: string | number }
}

export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: ZodRawShape
  /** Spends money: hidden in CARPE_READ_ONLY mode. */
  paid: boolean
  handler: (args: any, extra: ToolExtra) => Promise<CallToolResult>
}

/** Markets whose serving infrastructure is a TEE (router `privacy: true` set). */
export const TEE_MARKETS = new Set(['carpe', 'chutes', 'venice'])

export function routeInfo(surface: Surface, meta: CallMeta | undefined, privacyRequested?: unknown): Record<string, unknown> {
  if (surface === 'carpe' && (!meta?.routeMarket || meta.routeMarket === 'carpe')) {
    return { surface: 'carpe', endpoint_prefix: '/v1', route_used: 'carpe', tee: true }
  }
  const market = meta?.routeMarket
  const info: Record<string, unknown> = {
    surface,
    endpoint_prefix: surface === 'router' ? '/router' : '/v1',
    route_used: market ?? 'unknown',
    tee: market ? TEE_MARKETS.has(market) : null,
  }
  if (meta?.routeReason) info.reason = meta.routeReason
  if (meta?.routeFallback) info.fallback = meta.routeFallback
  if (meta?.routeAttempts) info.attempts = meta.routeAttempts
  if (meta?.routeSavedUsd !== undefined) info.saved_vs_carpe_usd = meta.routeSavedUsd
  if (meta?.routeSticky) info.sticky = meta.routeSticky
  if (market && !TEE_MARKETS.has(market) && (privacyRequested === undefined || privacyRequested === false)) {
    info.warning = `Served by "${market}", outside a TEE. For confidential prompts use route "carpe" (/v1) or privacy: true.`
  }
  return info
}

export function costInfo(meta: CallMeta | undefined, estimateUsd: number | undefined, guard: SpendGuard): Record<string, unknown> {
  return {
    usd: meta?.costUsd ?? null,
    source: meta?.costSource ?? (estimateUsd !== undefined ? 'estimate' : null),
    estimated_before_usd: estimateUsd ?? null,
    ...(meta?.availableCredits !== undefined ? { available_credits_after: meta.availableCredits, available_usd_after: meta.availableCredits / 100 } : {}),
    ...(meta?.paymentTx ? { payment_tx: meta.paymentTx } : {}),
    ...(meta?.paymentSettlement ? { payment_settlement: meta.paymentSettlement } : {}),
    session_spent_usd: Math.round(guard.spentUsd * 1e6) / 1e6,
  }
}

/** Run a paid request through the spend guard (reserve → call → settle, or release on failure). */
export async function paid(ctx: ToolContext, tool: string, estimateUsd: number | undefined, opts: RequestOptions): Promise<CarpeResponse> {
  const hold = ctx.guard.reserve(tool, estimateUsd)
  try {
    const res = await ctx.client.request({ ...opts, auth: 'paid' })
    ctx.guard.settle(hold, res.meta)
    return res
  } catch (err) {
    ctx.guard.fail(hold, err)
    throw err
  }
}

export function ok(text: string, structured: Record<string, unknown>, extra: CallToolResult['content'] = []): CallToolResult {
  return { content: [{ type: 'text', text }, ...extra], structuredContent: structured }
}

export function json(structured: Record<string, unknown>, lead?: string): CallToolResult {
  const body = JSON.stringify(structured, null, 2)
  return ok(lead ? `${lead}\n\n${body}` : body, structured)
}

export function fail(err: unknown): CallToolResult {
  const e = describeError(err)
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e }, null, 2) }], structuredContent: { error: e } }
}

/** Wrap a handler so any throw becomes an MCP tool error result (never a protocol error). */
export function safe(handler: ToolDef['handler']): ToolDef['handler'] {
  return async (args, extra) => {
    try {
      return await handler(args, extra)
    } catch (err) {
      return fail(err)
    }
  }
}

export function surfaceOf(ctx: ToolContext, route: unknown): 'carpe' | 'router' {
  return route === 'router' || route === 'carpe' ? route : ctx.cfg.defaultRoute
}

/** Job handles carry their surface so a status poll always hits the right one. */
export type JobSurface = 'v1' | 'router' | 'x402'
export function encodeJob(surface: JobSurface, kind: string, queueId: string, model?: string): string {
  return [surface, kind, queueId, model ?? ''].map((p) => encodeURIComponent(p)).join(':')
}
/** Job ids are model-supplied: every field is validated before it reaches a path or a body. */
const SAFE_FIELD = /^[A-Za-z0-9._@+=-]{1,200}$/
export function decodeJob(handle: string, kind: string): { surface: JobSurface; queueId: string; model?: string } {
  let parts: string[]
  try {
    parts = handle.split(':').map((p) => decodeURIComponent(p))
  } catch {
    parts = []
  }
  const [surface, k, queueId, model] = parts
  const valid =
    parts.length === 4 &&
    (surface === 'v1' || surface === 'router' || surface === 'x402') &&
    k === kind &&
    SAFE_FIELD.test(queueId ?? '') &&
    !queueId.includes('..') &&
    (model === '' || (SAFE_FIELD.test(model) && !model.includes('..')) || /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model))
  if (!valid) throw new LocalRefusal('BAD_JOB_ID', `"${handle.slice(0, 120)}" is not a ${kind} job id returned by this server.`)
  return { surface: surface as JobSurface, queueId, model: model || undefined }
}

const MiB = 1024 * 1024
/** The operator's /v1/image/share refuses larger images. */
const SHARE_MAX_BYTES = 10 * MiB

export interface MediaOutputOptions {
  forceSave?: boolean
  inlineLimit?: number
  /** Remote mode: room reserved in the media store before a one-shot paid call (see reserveOutput). */
  reservation?: Reservation
}

/**
 * Remote mode: hold room in the media store for the largest output a one-shot
 * call can return, BEFORE paying for it. Throws MEDIA_STORE_FULL (nothing paid)
 * when there is none. Undefined outside remote mode.
 */
export function reserveOutput(ctx: ToolContext, maxBytes: number, note = 'Nothing was sent or paid.'): Reservation | undefined {
  if (!ctx.media.remote || !ctx.media.store) return undefined
  try {
    return ctx.media.store.reserve(maxBytes)
  } catch (err) {
    if (err instanceof LocalRefusal) throw new LocalRefusal(err.code, `${err.message} ${note}`, err.hint)
    throw err
  }
}

/**
 * Remote mode: a finished, paid output could not be stored. The tool result is
 * an error naming the job, never a success without the output.
 */
export function undelivered(err: unknown, what: string, retry: string | undefined): LocalRefusal {
  const e = describeError(err)
  return new LocalRefusal(
    e.code === 'MEDIA_STORE_FULL' ? 'MEDIA_STORE_FULL' : 'MEDIA_NOT_DELIVERED',
    `${what} is ready but could not be delivered: ${String(e.message)}`,
    retry ?? (typeof e.hint === 'string' ? e.hint : undefined),
  )
}

/**
 * Turn produced media into MCP content: inline when small enough, else (or also) a file.
 * Remote mode writes nothing to disk: inline when small, else a link (see remoteMediaOutput).
 */
export async function mediaOutput(
  ctx: ToolContext,
  media: LoadedMedia,
  prefix: string,
  opts: MediaOutputOptions = {},
): Promise<{ content: CallToolResult['content']; info: Record<string, unknown> }> {
  const kind = media.mime.split('/')[0]
  const inlineLimit = opts.inlineLimit ?? (kind === 'image' ? 4 * MiB : kind === 'audio' ? 8 * MiB : 0)
  const inline = media.bytes.length <= inlineLimit && (kind === 'image' || kind === 'audio')
  if (ctx.media.remote) return remoteMediaOutput(ctx, media, kind, inline, prefix, opts.reservation)
  const path = saveMedia(media, prefix, ctx.media, opts.forceSave || !inline)
  const info: Record<string, unknown> = { mime_type: media.mime, bytes: media.bytes.length, ...(path ? { file: path } : {}), inline }
  const content: CallToolResult['content'] = []
  if (inline && kind === 'image') content.push({ type: 'image', data: media.bytes.toString('base64'), mimeType: media.mime })
  if (inline && kind === 'audio') content.push({ type: 'audio', data: media.bytes.toString('base64'), mimeType: media.mime })
  if (path) content.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: basename(path), mimeType: media.mime })
  return { content, info }
}

/**
 * Remote mode: there is no disk. Inline when small; else an image goes to the
 * operator's short-lived share link, and anything else (or an image the share
 * refused) to this server's temporary media store (GET /media/<id>, 1 hour).
 * Throws when the output cannot be delivered: the caller turns that into an
 * error naming the job, never a silent success.
 */
async function remoteMediaOutput(
  ctx: ToolContext,
  media: LoadedMedia,
  kind: string,
  inline: boolean,
  prefix: string,
  reservation: Reservation | undefined,
): Promise<{ content: CallToolResult['content']; info: Record<string, unknown> }> {
  const info: Record<string, unknown> = { mime_type: media.mime, bytes: media.bytes.length, inline }
  const content: CallToolResult['content'] = []
  if (inline && kind === 'image') content.push({ type: 'image', data: media.bytes.toString('base64'), mimeType: media.mime })
  else if (inline && kind === 'audio') content.push({ type: 'audio', data: media.bytes.toString('base64'), mimeType: media.mime })
  else {
    if (kind === 'image' && media.bytes.length <= SHARE_MAX_BYTES) {
      try {
        const url = await shareImage(ctx, media)
        Object.assign(info, { url, expires: 'about 1 hour after creation', storage: 'operator_share' })
        content.push({ type: 'resource_link', uri: url, name: 'image', mimeType: media.mime })
        return { content, info }
      } catch {
        /* the hosted server's own store takes it */
      }
    }
    const store = ctx.media.store
    if (!store) throw new LocalRefusal('MEDIA_NOT_DELIVERED', 'This output is too large to return inline and this server has no temporary storage.')
    const saved = reservation ? reservation.store(media, prefix) : store.put(media, prefix)
    Object.assign(info, { url: saved.url, expires_at: saved.expiresAt, expires: 'one hour after creation', storage: 'hosted_mcp' })
    content.push({ type: 'resource_link', uri: saved.url, name: `${prefix}.${extFor(media.mime)}`, mimeType: media.mime })
  }
  return { content, info }
}

/** POST /v1/image/share → a public, short-lived (about 1 h) URL on the operator. */
async function shareImage(ctx: ToolContext, media: LoadedMedia): Promise<string> {
  const res = await ctx.client.request({ method: 'POST', path: '/v1/image/share', json: { data: media.bytes.toString('base64'), mime: media.mime }, auth: 'account', retry: 'none' })
  const out = res.json<{ id?: unknown; url?: unknown }>()
  if (typeof out.url === 'string' && /^https:\/\//i.test(out.url)) return out.url
  if (typeof out.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(out.id)) return ctx.client.absoluteUrl(`/v1/image/share/${out.id}`)
  throw new LocalRefusal('UNEXPECTED_RESPONSE', 'The operator did not return a share id.')
}

export async function progress(extra: ToolExtra, value: number, total: number | undefined, message: string): Promise<void> {
  const token = extra._meta?.progressToken
  if (token === undefined || !extra.sendNotification) return
  await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: value, ...(total ? { total } : {}), message } }).catch(() => undefined)
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('Cancelled'))
    }, { once: true })
  })
