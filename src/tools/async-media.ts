/** Video and music: queued jobs whose job_id encodes the surface that created them. */
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { CarpeError, LocalRefusal } from '../errors.js'
import { checkPassThroughUrl, loadMedia, sniffMime, toDataUri } from '../media.js'
import { costInfo, decodeJob, encodeJob, mediaOutput, ok, paid, routeInfo, safe, surfaceOf, type JobSurface, type ToolContext, type ToolDef, type ToolExtra } from './context.js'
import { pollJob } from './jobs.js'

const ROUTE_MEDIA = z
  .enum(['carpe', 'router'])
  .optional()
  .describe('"carpe" → /v1 (Carpe TEE network). "router" → /router (cheapest of Carpe and external markets). Default from CARPE_DEFAULT_ROUTE.')

const WAIT = (def: number) => z.number().int().min(0).max(600).optional().describe(`Seconds to wait for completion before returning (default ${def}). Poll later with the status tool.`)

/** Price a video payload for free: /v1/video/quote with a key, or the unpaid x402 challenge. */
async function quoteVideo(ctx: ToolContext, body: Record<string, unknown>): Promise<{ usd?: number; raw?: unknown }> {
  if (ctx.client.usesBearer) {
    const res = await ctx.client.request({ method: 'POST', path: '/v1/video/quote', json: body, auth: 'account', retry: 'read' })
    const q = res.json<{ cost_usdc?: number | string; quote?: number | string }>()
    const usd = Number(q.cost_usdc ?? q.quote)
    return { usd: Number.isFinite(usd) ? usd : undefined, raw: q }
  }
  try {
    await ctx.client.request({ method: 'POST', path: '/v1/x402/video/queue', json: body, auth: 'none', retry: 'none' })
    return {}
  } catch (err) {
    if (err instanceof CarpeError && err.code === 'X402_PAYMENT_REQUIRED') {
      const accepts = (err.details as { accepts?: { scheme?: string; maxAmountRequired?: string }[] })?.accepts ?? []
      const acc = accepts.find((x) => x.scheme === 'carpe-session') ?? accepts[0]
      const micros = Number(acc?.maxAmountRequired)
      return { usd: Number.isFinite(micros) ? micros / 1e6 : undefined, raw: { challenge: acc } }
    }
    throw err
  }
}

/** Download a finished file: through the client when it is on the operator, else as a bounded public fetch. */
async function download(ctx: ToolContext, url: string, maxBytes: number): Promise<Buffer> {
  if (url.startsWith(ctx.cfg.baseUrl + '/')) {
    const res = await ctx.client.request({ path: url.slice(ctx.cfg.baseUrl.length), auth: 'none', maxBytes, retry: 'read', timeoutMs: 300_000 })
    return res.body
  }
  return (await loadMedia(url, { ...ctx.media, maxInputBytes: maxBytes })).bytes
}

async function resolveMediaField(ctx: ToolContext, v: unknown, maxBytes: number): Promise<unknown> {
  if (typeof v !== 'string') return v
  if (/^data:/i.test(v)) return v
  if (/^https?:/i.test(v)) {
    checkPassThroughUrl(v, ctx.media)
    return v
  }
  return toDataUri(await loadMedia(v, { ...ctx.media, maxInputBytes: maxBytes }))
}

/** Remote mode: a finished file stays on the operator; the user gets its temporary link. */
function remoteLink(kind: 'video' | 'music', handle: string, surface: JobSurface, url: string, mime: string, expires: string): CallToolResult {
  const note = 'Temporary link served by Carpe Diem: open or download it soon. Longer-lived storage is not available yet on the hosted server.'
  return ok(
    `${kind === 'video' ? 'Video' : 'Music'} ready: ${url}\nExpires ${expires}. ${note}`,
    { job_id: handle, status: 'completed', [kind === 'video' ? 'video' : 'audio']: { url, mime_type: mime, expires, note }, remote_url: url, surface },
    [{ type: 'resource_link', uri: url, name: kind === 'video' ? 'video.mp4' : 'music', mimeType: mime }],
  )
}

export function asyncMediaTools(ctx: ToolContext): ToolDef[] {
  const effectiveSurface = (route: unknown): JobSurface => {
    if (ctx.client.mode === 'x402') return 'x402'
    return surfaceOf(ctx, route) === 'router' ? 'router' : 'v1'
  }

  const videoStatus = async (handle: string, wait: number, extra: ToolExtra): Promise<CallToolResult> => {
    const job = decodeJob(handle, 'video')
    const path = job.surface === 'router' ? '/router/video/retrieve' : job.surface === 'x402' ? '/v1/x402/video/retrieve' : '/v1/video/retrieve'
    const r = await pollJob(ctx, extra, {
      path,
      body: { queue_id: job.queueId, ...(job.model ? { model: job.model } : {}) },
      auth: job.surface === 'x402' ? 'none' : 'account',
      waitSeconds: wait,
      intervalMs: 5000,
      label: 'video',
      maxBytes: ctx.cfg.maxVideoBytes,
    })
    if (!r.done) return ok(`Video still ${r.status?.status ?? 'processing'}. Poll again with carpe_video_status job_id "${handle}".`, { job_id: handle, status: r.status?.status ?? 'processing', upstream: r.status })
    let bytes: Buffer
    let remote: string | undefined
    if (r.res) bytes = r.res.body
    else {
      const url = (r.status?.video_url ?? r.status?.download_url ?? r.status?.url) as string | undefined
      if (!url) return ok('Video completed but no file URL was returned.', { job_id: handle, status: 'completed', upstream: r.status })
      remote = ctx.client.absoluteUrl(url)
      // Hosted server: no disk, so hand the operator's short-lived link over instead of downloading it.
      if (ctx.media.remote) return remoteLink('video', handle, job.surface, remote, 'video/mp4', 'about 10 minutes after completion')
      // The file is served by its opaque id for ~10 minutes: download it now.
      bytes = await download(ctx, remote, ctx.cfg.maxVideoBytes)
    }
    const media = { bytes, mime: sniffMime(bytes) ?? 'video/mp4' }
    const out = await mediaOutput(ctx, media, 'video', { forceSave: true })
    const where = out.info.file ?? out.info.note
    return ok(
      `Video ready: ${where}${remote ? `\nRemote copy (expires ~10 min after completion): ${remote}` : ''}`,
      { job_id: handle, status: 'completed', video: out.info, ...(remote ? { remote_url: remote } : {}), surface: job.surface },
      out.content,
    )
  }

  const musicStatus = async (handle: string, wait: number, extra: ToolExtra): Promise<CallToolResult> => {
    const job = decodeJob(handle, 'music')
    const path = job.surface === 'router' ? '/router/audio/music/retrieve' : job.surface === 'x402' ? '/v1/x402/audio/music/retrieve' : '/v1/audio/music/retrieve'
    const r = await pollJob(ctx, extra, {
      path,
      body: { queue_id: job.queueId, ...(job.model ? { model: job.model } : {}) },
      auth: job.surface === 'x402' ? 'none' : 'account',
      waitSeconds: wait,
      intervalMs: 4000,
      label: 'music',
    })
    if (!r.done) return ok(`Music still ${r.status?.status ?? 'processing'}. Poll again with carpe_music_status job_id "${handle}".`, { job_id: handle, status: r.status?.status ?? 'processing', upstream: r.status })
    let bytes: Buffer | undefined = r.res?.body
    if (!bytes) {
      const url = (r.status?.audio_url ?? r.status?.download_url ?? r.status?.url) as string | undefined
      if (!url) return ok('Music completed but no audio was returned.', { job_id: handle, status: 'completed', upstream: r.status })
      if (ctx.media.remote) return remoteLink('music', handle, job.surface, ctx.client.absoluteUrl(url), 'audio/mpeg', 'set by the operator (short-lived)')
      bytes = await download(ctx, ctx.client.absoluteUrl(url), ctx.cfg.maxMediaBytes)
    }
    const media = { bytes, mime: sniffMime(bytes) ?? r.res?.contentType ?? 'audio/mpeg' }
    // On /v1 a finished track can be claimed only once: always keep a copy on disk (inline only in remote mode).
    const out = await mediaOutput(ctx, media, 'music', { forceSave: true })
    return ok(`Music ready${out.info.file ? `: ${out.info.file}` : out.info.inline ? ' (inline audio)' : `: ${out.info.note}`}`, { job_id: handle, status: 'completed', audio: out.info, surface: job.surface }, out.content)
  }

  return [
    {
      name: 'carpe_video_generate',
      title: 'Generate a video',
      description:
        'Queue a video (Sora, Veo, Kling, Seedance, Wan, LTX, Grok Imagine…; text-to-video, image-to-video, reference-to-video). The payload is priced first (free quote) and refused locally above CARPE_MAX_PER_CALL_USD. ' +
        'Returns a job_id; carpe_video_status downloads the MP4 when ready (videos take minutes). Read the model constraints (durations, aspect ratios, resolutions) with carpe_model_details.',
      paid: true,
      inputSchema: {
        model: z.string().min(1).describe('Video model id (carpe_list_models type video / imageToVideo / referenceToVideo).'),
        prompt: z.string().min(1),
        duration: z.string().describe('With unit, as the model lists it: "5s", "10s"…'),
        aspect_ratio: z.string().optional(),
        resolution: z.string().optional(),
        image_url: z.string().optional().describe('First frame / source image: https:// URL, data: URI, or local path (stdio).'),
        end_image_url: z.string().optional(),
        reference_image_urls: z.array(z.string()).optional(),
        reference_video_urls: z.array(z.string()).optional().describe('https:// URLs preferred (35 MB request limit).'),
        reference_audio_urls: z.array(z.string()).optional(),
        reference_video_total_duration: z.number().optional().describe('Sum of the reference clip lengths, in seconds (needed for pricing when clips are given).'),
        negative_prompt: z.string().optional(),
        consents: z.record(z.any()).optional().describe('ONLY in answer to a NEEDS_CONSENT refusal, after the user explicitly accepted the policy text.'),
        route: ROUTE_MEDIA,
        wait_seconds: WAIT(0),
        extra: z.record(z.any()).optional().describe('Other model fields passed through verbatim (seed, audio, …).'),
      },
      handler: safe(async (a, extra) => {
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model: a.model, prompt: a.prompt, duration: a.duration }
        for (const k of ['aspect_ratio', 'resolution', 'negative_prompt', 'reference_video_total_duration', 'consents'] as const) if (a[k] !== undefined) body[k] = a[k]
        for (const k of ['image_url', 'end_image_url'] as const) if (a[k] !== undefined) body[k] = await resolveMediaField(ctx, a[k], 10 * 1024 * 1024)
        for (const k of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls'] as const) {
          if (a[k] !== undefined) body[k] = await Promise.all((a[k] as string[]).map((v) => resolveMediaField(ctx, v, 25 * 1024 * 1024)))
        }
        const surface = effectiveSurface(a.route)
        const quote = await quoteVideo(ctx, body)
        if (quote.usd === undefined) throw new LocalRefusal('PRICE_UNAVAILABLE', 'The video could not be priced in advance; nothing was queued. Retry shortly.')
        const path = surface === 'router' ? '/router/video/generations' : '/v1/video/queue'
        const res = await paid(ctx, 'carpe_video_generate', quote.usd, { method: 'POST', path, x402Path: '/v1/x402/video/queue', json: body, auth: 'paid', signal: extra.signal, timeoutMs: 120_000 })
        const out = res.json<{ queue_id?: string; id?: string; market?: string; status?: string }>()
        const queueId = out.queue_id ?? out.id
        if (!queueId) throw new LocalRefusal('UNEXPECTED_RESPONSE', `No job id in the queue response: ${JSON.stringify(out).slice(0, 300)}`)
        const handle = encodeJob(surface, 'video', queueId, a.model)
        const base = {
          job_id: handle,
          model: a.model,
          quote_usd: quote.usd,
          cost: costInfo(res.meta, quote.usd, ctx.guard),
          route: routeInfo(surface === 'router' ? 'router' : 'carpe', { ...res.meta, ...(out.market ? { routeMarket: out.market } : {}) }),
        }
        if ((a.wait_seconds ?? 0) > 0) {
          const st = await videoStatus(handle, a.wait_seconds, extra)
          return { ...st, structuredContent: { ...base, ...(st.structuredContent ?? {}) } }
        }
        return ok(`Video queued (≈$${quote.usd.toFixed(4)}). job_id: ${handle}\nPoll with carpe_video_status (wait_seconds up to 600).`, { ...base, status: out.status ?? 'queued' })
      }),
    },
    {
      name: 'carpe_video_status',
      title: 'Poll / download a video',
      description: 'Check a video job from carpe_video_generate; when completed, downloads the MP4 to CARPE_OUTPUT_DIR (or the temp dir) and returns its path. Polls the surface that created the job. Free.',
      paid: false,
      inputSchema: { job_id: z.string().min(1), wait_seconds: WAIT(60) },
      handler: safe(async (a, extra) => videoStatus(a.job_id, a.wait_seconds ?? 60, extra)),
    },
    {
      name: 'carpe_music_generate',
      title: 'Generate music / sound',
      description:
        'Queue music, a sound effect, or long-form speech (music-pipeline models: ElevenLabs Music, ACE-Step, Lyria, MiniMax, ElevenLabs sound effects / TTS v3-v4). ' +
        'Each model has its own accepted durations, lyrics and instrumental options — read them with carpe_model_details first. Returns a job_id for carpe_music_status.',
      paid: true,
      inputSchema: {
        prompt: z.string().min(1).describe('Musical style / description (or the text read aloud on speaking models).'),
        model: z.string().optional().describe('Default ace-step-15. See carpe_list_models type "music".'),
        lyrics_prompt: z.string().optional(),
        duration_seconds: z.number().int().optional(),
        force_instrumental: z.boolean().optional().describe('Only on models whose constraints list supports_force_instrumental.'),
        voice: z.string().optional(),
        speed: z.number().optional(),
        route: ROUTE_MEDIA,
        wait_seconds: WAIT(0),
        extra: z.record(z.any()).optional(),
      },
      handler: safe(async (a, extra) => {
        const model = a.model ?? 'ace-step-15'
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model, prompt: a.prompt }
        for (const k of ['lyrics_prompt', 'duration_seconds', 'force_instrumental', 'voice', 'speed'] as const) if (a[k] !== undefined) body[k] = a[k]
        const surface = effectiveSurface(a.route)
        const estimate = (await ctx.estimator.row(model))?.inputPrice
        const res = await paid(ctx, 'carpe_music_generate', estimate, {
          method: 'POST',
          path: surface === 'router' ? '/router/audio/music/queue' : '/v1/audio/music/queue',
          x402Path: '/v1/x402/audio/music/queue',
          json: body,
          auth: 'paid',
          signal: extra.signal,
        })
        const out = res.json<{ queue_id?: string; id?: string; status?: string }>()
        const queueId = out.queue_id ?? out.id
        if (!queueId) throw new LocalRefusal('UNEXPECTED_RESPONSE', `No job id in the queue response: ${JSON.stringify(out).slice(0, 300)}`)
        const handle = encodeJob(surface, 'music', queueId, model)
        const base = { job_id: handle, model, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo(surface === 'router' ? 'router' : 'carpe', res.meta) }
        if ((a.wait_seconds ?? 0) > 0) {
          const st = await musicStatus(handle, a.wait_seconds, extra)
          return { ...st, structuredContent: { ...base, ...(st.structuredContent ?? {}) } }
        }
        return ok(`Music queued. job_id: ${handle}\nPoll with carpe_music_status.`, { ...base, status: out.status ?? 'queued' })
      }),
    },
    {
      name: 'carpe_music_status',
      title: 'Poll / download music',
      description: 'Check a music job from carpe_music_generate; when completed, the track is saved to disk (it can be retrieved only once on /v1) and returned. Free.',
      paid: false,
      inputSchema: { job_id: z.string().min(1), wait_seconds: WAIT(60) },
      handler: safe(async (a, extra) => musicStatus(a.job_id, a.wait_seconds ?? 60, extra)),
    },
  ]
}
