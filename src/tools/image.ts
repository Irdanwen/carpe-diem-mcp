/** Paid image tools. Surfaces differ in paths AND shapes — see the table in README "Two surfaces". */
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CarpeResponse } from '../carpe-client.js'
import { LocalRefusal } from '../errors.js'
import { decodeBase64Media, loadMedia, sniffMime, toDataUri, type LoadedMedia } from '../media.js'
import { costInfo, decodeJob, encodeJob, mediaOutput, ok, paid, routeInfo, safe, surfaceOf, type JobSurface, type ToolContext, type ToolDef, type ToolExtra } from './context.js'
import { pollJob } from './jobs.js'

/** Models the operator documents as too slow for the synchronous route (edge cap ~60 s). */
const HEAVY = /^(gpt-image|nano-banana|recraft|flux-2|qwen-image)/

type ImageKind = 'generate' | 'edit' | 'multi-edit'

const ROUTE_IMG = z
  .enum(['carpe', 'router'])
  .optional()
  .describe('"carpe" → /v1/image/* (Carpe TEE network). "router" → /router/images/* (cheapest of Carpe and external markets; no privacy filter for images). Default from CARPE_DEFAULT_ROUTE.')

const WAIT = z.number().int().min(0).max(600).optional().describe('Seconds to wait for a queued job before returning a job_id (default 120).')

function retrievePath(surface: JobSurface, kind: ImageKind): string {
  if (surface === 'router') return '/router/images/retrieve'
  if (surface === 'x402') return `/v1/x402/image/${kind}/retrieve`
  return `/v1/image/${kind}/retrieve`
}

function imagesFromJson(body: unknown): LoadedMedia[] {
  const b = body as { images?: unknown[]; data?: { b64_json?: string }[] }
  const list = Array.isArray(b.images) ? b.images : Array.isArray(b.data) ? b.data.map((d) => d.b64_json) : []
  return list.filter((s): s is string => typeof s === 'string' && s.length > 0 && !/^https?:/.test(s)).map(decodeBase64Media)
}

function urlsFromJson(body: unknown): string[] {
  const b = body as { images?: unknown[] }
  return (Array.isArray(b.images) ? b.images : []).filter((s): s is string => typeof s === 'string' && /^https?:/.test(s))
}

export function imageTools(ctx: ToolContext): ToolDef[] {
  const finish = (tool: string, _res: CarpeResponse | undefined, images: LoadedMedia[], urls: string[], structured: Record<string, unknown>): CallToolResult => {
    const outputs = images.map((m, i) => mediaOutput(ctx, m, `${tool.replace('carpe_', '')}-${i + 1}`))
    const content = outputs.flatMap((o) => o.content)
    const info: Record<string, unknown> = { ...structured, images: outputs.map((o) => o.info), ...(urls.length ? { image_urls: urls } : {}) }
    const files = outputs.map((o) => o.info.file).filter(Boolean)
    const lead = `${images.length + urls.length} image(s) from ${structured.model ?? 'the model'}${files.length ? ` — saved to ${files.join(', ')}` : ''}${urls.length ? `\n${urls.join('\n')}` : ''}`
    return ok(`${lead}\n${JSON.stringify({ cost: info.cost, route: info.route }, null, 0)}`, info, content)
  }

  /** Queue on `surface`, wait up to `wait` seconds, return the image or a job id. */
  const queued = async (tool: string, surface: JobSurface, kind: ImageKind, queueId: string, base: Record<string, unknown>, wait: number, extra: ToolExtra): Promise<CallToolResult> => {
    const jobId = encodeJob(surface, 'image', queueId, kind)
    const r = await pollJob(ctx, extra, { path: retrievePath(surface, kind), body: { queue_id: queueId }, auth: surface === 'x402' ? 'none' : 'account', waitSeconds: wait, label: tool })
    if (!r.done) return ok(`Image job queued: ${jobId}. Poll with carpe_image_status.`, { ...base, status: 'pending', job_id: jobId })
    if (r.res) {
      const media = { bytes: r.res.body, mime: sniffMime(r.res.body) ?? r.res.contentType }
      if (surface === 'v1') {
        // Free the operator buffer (best effort; the job also expires on its own).
        ctx.client.request({ method: 'POST', path: `/v1/image/${kind}/complete`, json: { queue_id: queueId }, auth: 'account', retry: 'none' }).catch(() => undefined)
      }
      return finish(tool, r.res, [media], [], { ...base, status: 'completed', job_id: jobId })
    }
    return finish(tool, undefined, imagesFromJson(r.status), urlsFromJson(r.status), { ...base, status: 'completed', job_id: jobId })
  }

  const run = async (tool: string, kind: ImageKind, model: string, body: Record<string, unknown>, a: Record<string, any>, extra: ToolExtra, estimate: number | undefined): Promise<CallToolResult> => {
    let surface = surfaceOf(ctx, a.route)
    const notes: string[] = []
    const x402 = ctx.client.mode === 'x402'
    if (x402 && surface === 'router') {
      surface = 'carpe'
      notes.push('route "router" has no x402 path for images; served on /v1/x402.')
    }
    if (kind === 'multi-edit' && surface === 'router') {
      surface = 'carpe'
      notes.push('No market arbitrates multi-edit: served on /v1 (Carpe).')
    }
    const variants = Number(body.variants ?? 1)
    const mode: 'auto' | 'sync' | 'queue' = a.mode ?? 'auto'
    const useQueue = kind === 'multi-edit' || mode === 'queue' || (mode === 'auto' && (kind === 'edit' || HEAVY.test(model)) && variants <= 1)
    if (useQueue && variants > 1) throw new LocalRefusal('VARIANTS_NOT_SUPPORTED', 'Queued image jobs return one image: use mode "sync" for variants > 1.')
    const wait = a.wait_seconds ?? 120
    const base = { model, kind, ...(notes.length ? { notes } : {}) }

    if (surface === 'router') {
      const path = kind === 'generate' ? '/router/images/generations' : '/router/images/edits'
      const res = await paid(ctx, tool, estimate, { method: 'POST', path, json: body, auth: 'paid', signal: extra.signal })
      const structured = { ...base, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('router', res.meta) }
      if (!res.isJson) return finish(tool, res, [{ bytes: res.body, mime: sniffMime(res.body) ?? res.contentType }], [], structured)
      const out = res.json<Record<string, unknown>>()
      if (typeof out.queue_id === 'string') return queued(tool, 'router', kind, out.queue_id, structured, wait, extra)
      return finish(tool, res, imagesFromJson(out), urlsFromJson(out), structured)
    }

    const jobSurface: JobSurface = x402 ? 'x402' : 'v1'
    if (useQueue) {
      const res = await paid(ctx, tool, estimate, { method: 'POST', path: `/v1/image/${kind}/queue`, x402Path: `/v1/x402/image/${kind}/queue`, json: body, auth: 'paid', signal: extra.signal })
      const out = res.json<{ queue_id?: string }>()
      if (!out.queue_id) throw new LocalRefusal('UNEXPECTED_RESPONSE', `The operator did not return a queue_id: ${JSON.stringify(out).slice(0, 300)}`)
      return queued(tool, jobSurface, kind, out.queue_id, { ...base, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('carpe', res.meta) }, wait, extra)
    }
    const res = await paid(ctx, tool, estimate, { method: 'POST', path: `/v1/image/${kind}`, x402Path: `/v1/x402/image/${kind}`, json: body, auth: 'paid', signal: extra.signal })
    const structured = { ...base, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('carpe', res.meta) }
    if (!res.isJson) return finish(tool, res, [{ bytes: res.body, mime: sniffMime(res.body) ?? res.contentType }], [], structured)
    const out = res.json<Record<string, unknown>>()
    return finish(tool, res, imagesFromJson(out), urlsFromJson(out), { ...structured, ...(out.safe_mode !== undefined ? { safe_mode: out.safe_mode } : {}) })
  }

  const common = {
    route: ROUTE_IMG,
    mode: z.enum(['auto', 'sync', 'queue']).optional().describe('auto (default): queue slow models (gpt-image, nano-banana, recraft, flux-2, qwen-image) and edits, sync otherwise.'),
    wait_seconds: WAIT,
    extra: z.record(z.any()).optional().describe('Additional model parameters passed through verbatim (steps, cfg_scale, style_preset, hide_watermark…).'),
  }

  return [
    {
      name: 'carpe_image_generate',
      title: 'Generate an image',
      description:
        'Generate image(s) from a prompt (Venice image models: Flux, GPT Image, Nano Banana, Seedream, Qwen Image, Recraft, uncensored SD…). Images are returned inline and/or saved to CARPE_OUTPUT_DIR. ' +
        'Fixed price per image (carpe_pricing). Slow models run as a queued job automatically.',
      paid: true,
      inputSchema: {
        prompt: z.string().min(1).max(10000),
        model: z.string().optional().describe('Image model id (default z-image-turbo). See carpe_list_models type "image".'),
        variants: z.number().int().min(1).max(4).optional().describe('1–4 images (sync mode only), each billed.'),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        aspect_ratio: z.string().optional().describe('e.g. "1:1", "16:9" (model-dependent).'),
        resolution: z.string().optional().describe('"1K" | "2K" | "4K" on tiered models — sets the price tier.'),
        quality: z.enum(['low', 'medium', 'high']).optional().describe('Price tier on tiered models.'),
        format: z.enum(['webp', 'png', 'jpeg']).optional().describe('Output format (default webp).'),
        negative_prompt: z.string().optional(),
        seed: z.number().int().optional(),
        safe_mode: z.boolean().optional().describe('Blur adult content (default false).'),
        ...common,
      },
      handler: safe(async (a, extra) => {
        const model = a.model ?? 'z-image-turbo'
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model, prompt: a.prompt }
        for (const k of ['variants', 'width', 'height', 'aspect_ratio', 'resolution', 'quality', 'format', 'negative_prompt', 'seed', 'safe_mode'] as const) if (a[k] !== undefined) body[k] = a[k]
        const unit = await ctx.estimator.fixedCost(model)
        return run('carpe_image_generate', 'generate', model, body, a, extra, unit !== undefined ? unit * (a.variants ?? 1) : undefined)
      }),
    },
    {
      name: 'carpe_image_edit',
      title: 'Edit an image',
      description: 'Transform one image from a prompt (imageEdit models such as qwen-image-2-edit, nano-banana-2-edit, gpt-image-2-edit). image: https URL, data: URI or (stdio) a local file path.',
      paid: true,
      inputSchema: {
        prompt: z.string().min(1).max(10000),
        image: z.string().min(1).describe('Source image: https:// URL, data: URI, or local path (stdio mode).'),
        model: z.string().optional().describe('imageEdit model id (default qwen-image-2-edit). See carpe_list_models type "imageEdit".'),
        aspect_ratio: z.string().optional(),
        resolution: z.string().optional(),
        quality: z.enum(['low', 'medium', 'high']).optional(),
        format: z.enum(['webp', 'png', 'jpeg']).optional(),
        safe_mode: z.boolean().optional(),
        ...common,
      },
      handler: safe(async (a, extra) => {
        const model = a.model ?? 'qwen-image-2-edit'
        const img = await loadMedia(a.image, { ...ctx.media, maxInputBytes: 5 * 1024 * 1024 }, 'image/png')
        if (!img.mime.startsWith('image/')) throw new LocalRefusal('BAD_MEDIA', `The source is ${img.mime}, not an image.`)
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model, prompt: a.prompt, image: toDataUri(img) }
        for (const k of ['aspect_ratio', 'resolution', 'quality', 'format', 'safe_mode'] as const) if (a[k] !== undefined) body[k] = a[k]
        return run('carpe_image_edit', 'edit', model, body, a, extra, await ctx.estimator.fixedCost(model))
      }),
    },
    {
      name: 'carpe_image_multi_edit',
      title: 'Compose / edit several images',
      description: 'Compose or edit from 1–3 source images and a prompt (e.g. "put the product from image 1 on the table of image 2"). Always on /v1 — no market arbitrates multi-edit. Runs as a queued job.',
      paid: true,
      inputSchema: {
        prompt: z.string().min(1).max(10000),
        images: z.array(z.string().min(1)).min(1).max(3).describe('1–3 images: https:// URLs, data: URIs or local paths (stdio).'),
        model: z.string().optional().describe('Multi-edit capable model (default flux-2-max-edit).'),
        aspect_ratio: z.string().optional(),
        output_format: z.enum(['webp', 'png', 'jpeg']).optional(),
        resolution: z.string().optional(),
        quality: z.enum(['low', 'medium', 'high']).optional(),
        safe_mode: z.boolean().optional(),
        wait_seconds: WAIT,
        extra: common.extra,
      },
      handler: safe(async (a, extra) => {
        const model = a.model ?? 'flux-2-max-edit'
        const images = await Promise.all((a.images as string[]).map((s) => loadMedia(s, { ...ctx.media, maxInputBytes: 5 * 1024 * 1024 }, 'image/png')))
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model, prompt: a.prompt, images: images.map(toDataUri) }
        for (const k of ['aspect_ratio', 'output_format', 'resolution', 'quality', 'safe_mode'] as const) if (a[k] !== undefined) body[k] = a[k]
        return run('carpe_image_multi_edit', 'multi-edit', model, body, { ...a, route: 'carpe', mode: 'queue' }, extra, await ctx.estimator.fixedCost(model))
      }),
    },
    {
      name: 'carpe_image_upscale',
      title: 'Upscale an image',
      description: 'Increase image resolution 1–4× (source ≥ 256×256). Always on /v1. image: https URL, data: URI or local path (stdio).',
      paid: true,
      inputSchema: {
        image: z.string().min(1),
        scale: z.number().min(1).max(4).optional().describe('Default 2.'),
        model: z.string().optional().describe('Default "upscaler".'),
        extra: common.extra,
      },
      handler: safe(async (a, extra) => {
        const img = await loadMedia(a.image, { ...ctx.media, maxInputBytes: 10 * 1024 * 1024 }, 'image/png')
        const model = a.model ?? 'upscaler'
        // The upscale route wants RAW base64 (no data: prefix), unlike edit.
        const body = { ...(a.extra ?? {}), model, image: img.bytes.toString('base64'), scale: a.scale ?? 2 }
        const estimate = await ctx.estimator.fixedCost(model)
        const res = await paid(ctx, 'carpe_image_upscale', estimate, { method: 'POST', path: '/v1/image/upscale', x402Path: '/v1/x402/image/upscale', json: body, auth: 'paid', signal: extra.signal })
        const structured = { model, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('carpe', res.meta) }
        if (!res.isJson) return finish('carpe_image_upscale', res, [{ bytes: res.body, mime: sniffMime(res.body) ?? res.contentType }], [], structured)
        const out = res.json<Record<string, unknown>>()
        return finish('carpe_image_upscale', res, imagesFromJson(out), urlsFromJson(out), structured)
      }),
    },
    {
      name: 'carpe_image_status',
      title: 'Poll a queued image job',
      description: 'Fetch the result of a queued image job (job_id from an image tool). Polls on the surface that created the job. Free.',
      paid: false,
      inputSchema: { job_id: z.string().min(1), wait_seconds: WAIT },
      handler: safe(async (a, extra) => {
        const job = decodeJob(a.job_id, 'image')
        const kind = (job.model ?? 'generate') as ImageKind
        return queued('carpe_image_status', job.surface, kind, job.queueId, { kind }, a.wait_seconds ?? 60, extra)
      }),
    },
  ]
}
