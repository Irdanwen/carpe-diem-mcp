import type { ZodRawShape } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Config, Surface } from '../config.js'
import type { CallMeta, CarpeClient, CarpeResponse, RequestOptions } from '../carpe-client.js'
import type { Estimator, SpendGuard } from '../spend-guard.js'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { saveMedia, type LoadedMedia, type MediaPolicy } from '../media.js'
import { describeError } from '../errors.js'

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

/** Run a paid request through the spend guard. */
export async function paid(ctx: ToolContext, tool: string, estimateUsd: number | undefined, opts: RequestOptions): Promise<CarpeResponse> {
  ctx.guard.check(tool, estimateUsd)
  const res = await ctx.client.request({ ...opts, auth: 'paid' })
  ctx.guard.record(tool, res.meta, estimateUsd)
  return res
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
export function decodeJob(handle: string, kind: string): { surface: JobSurface; queueId: string; model?: string } {
  const parts = handle.split(':').map((p) => decodeURIComponent(p))
  if (parts.length === 4 && (parts[0] === 'v1' || parts[0] === 'router' || parts[0] === 'x402') && parts[1] === kind && parts[2]) {
    return { surface: parts[0], queueId: parts[2], model: parts[3] || undefined }
  }
  throw new Error(`"${handle}" is not a ${kind} job id returned by carpe_${kind}_generate.`)
}

/** Turn produced media into MCP content: inline when small enough, else (or also) a file. */
export function mediaOutput(
  ctx: ToolContext,
  media: LoadedMedia,
  prefix: string,
  opts: { forceSave?: boolean; inlineLimit?: number } = {},
): { content: CallToolResult['content']; info: Record<string, unknown> } {
  const kind = media.mime.split('/')[0]
  const inlineLimit = opts.inlineLimit ?? (kind === 'image' ? 4 * 1024 * 1024 : kind === 'audio' ? 8 * 1024 * 1024 : 0)
  const inline = media.bytes.length <= inlineLimit && (kind === 'image' || kind === 'audio')
  const path = saveMedia(media, prefix, ctx.media, opts.forceSave || !inline)
  const info: Record<string, unknown> = { mime_type: media.mime, bytes: media.bytes.length, ...(path ? { file: path } : {}), inline }
  const content: CallToolResult['content'] = []
  if (inline && kind === 'image') content.push({ type: 'image', data: media.bytes.toString('base64'), mimeType: media.mime })
  if (inline && kind === 'audio') content.push({ type: 'audio', data: media.bytes.toString('base64'), mimeType: media.mime })
  if (path) content.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: basename(path), mimeType: media.mime })
  return { content, info }
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
