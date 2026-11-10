/** Speech tools: TTS, transcription, voice cloning. */
import { z } from 'zod'
import { LocalRefusal } from '../errors.js'
import { extFor, loadMedia, sniffMime } from '../media.js'
import { costInfo, mediaOutput, ok, paid, reserveOutput, routeInfo, safe, surfaceOf, undelivered, type ToolContext, type ToolDef } from './context.js'

const ROUTE_AUDIO = z
  .enum(['carpe', 'router'])
  .optional()
  .describe('"carpe" → /v1/audio/* (Carpe TEE network). "router" → /router/audio/* (cheapest market). Default from CARPE_DEFAULT_ROUTE.')

export function audioTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: 'carpe_tts',
      title: 'Text to speech',
      description:
        'Turn text (≤ 4096 characters) into speech. Voices are model-specific: omit voice for the model default, or read the voices of a model with carpe_model_details. ' +
        'A cloned voice (vv_… from carpe_voice_clone) only works on route "carpe" with the model it was cloned for. Billed per character.',
      paid: true,
      inputSchema: {
        input: z.string().min(1).max(4096),
        model: z.string().optional().describe('TTS model id (default tts-kokoro). See carpe_list_models type "tts".'),
        voice: z.string().optional().describe('A voice of this model, or a vv_… cloned voice handle.'),
        response_format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']).optional(),
        speed: z.number().min(0.25).max(4).optional(),
        route: ROUTE_AUDIO,
      },
      handler: safe(async (a, extra) => {
        let surface = surfaceOf(ctx, a.route)
        const notes: string[] = []
        const cloned = typeof a.voice === 'string' && a.voice.startsWith('vv_')
        if (cloned && ctx.client.mode === 'x402') throw new LocalRefusal('VOICE_HANDLE_V1_ONLY', 'Cloned voices cannot be used over x402.')
        if (cloned && surface === 'router') {
          surface = 'carpe'
          notes.push('Cloned voice: served on /v1/audio/speech (the only route that accepts vv_ handles).')
        }
        if (ctx.client.mode === 'x402' && surface === 'router') {
          surface = 'carpe'
          notes.push('route "router" has no x402 path for speech; served on /v1/x402/audio/speech.')
        }
        const model = a.model ?? 'tts-kokoro'
        const body: Record<string, unknown> = { model, input: a.input }
        for (const k of ['voice', 'response_format', 'speed'] as const) if (a[k] !== undefined) body[k] = a[k]
        const estimate = await ctx.estimator.ttsCost(model, String(a.input).length)
        // Remote mode: the speech is returned once; room to keep it is held before paying.
        const hold = reserveOutput(ctx, ctx.cfg.maxMediaBytes)
        try {
          const res = await paid(ctx, 'carpe_tts', estimate, {
            method: 'POST',
            path: surface === 'router' ? '/router/audio/speech' : '/v1/audio/speech',
            x402Path: '/v1/x402/audio/speech',
            json: body,
            auth: 'paid',
            maxBytes: ctx.cfg.maxMediaBytes,
            signal: extra.signal,
          })
          if (res.isJson) throw new LocalRefusal('UNEXPECTED_RESPONSE', `Expected audio, got JSON: ${res.text().slice(0, 300)}`)
          const media = { bytes: res.body, mime: sniffMime(res.body) ?? (res.contentType || 'audio/mpeg') }
          let out: Awaited<ReturnType<typeof mediaOutput>>
          try {
            out = await mediaOutput(ctx, media, 'tts', { reservation: hold })
          } catch (err) {
            if (ctx.media.remote) throw undelivered(err, 'The speech (already billed)', undefined)
            throw err
          }
          const structured = { model, audio: out.info, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo(surface, res.meta), ...(notes.length ? { notes } : {}) }
          const where = out.info.file ? ` — saved to ${out.info.file}` : out.info.url ? ` — ${out.info.url} (temporary link, expires ${out.info.expires_at})` : ''
          return ok(`Speech generated (${media.mime}, ${media.bytes.length} bytes)${where}.\n${JSON.stringify({ cost: structured.cost, route: structured.route })}`, structured, out.content)
        } finally {
          hold?.release()
        }
      }),
    },
    {
      name: 'carpe_transcribe',
      title: 'Transcribe audio',
      description: 'Speech to text (Whisper-compatible). audio: https:// URL, data: URI, or local path (stdio). Formats such as mp3, wav, m4a, flac, ogg, webm.',
      paid: true,
      inputSchema: {
        audio: z.string().min(1),
        model: z.string().optional().describe('ASR model (default openai/whisper-large-v3). See carpe_list_models type "asr".'),
        language: z.string().optional().describe('ISO-639-1 hint, e.g. "fr".'),
        response_format: z.enum(['json', 'text', 'verbose_json']).optional(),
        prompt: z.string().optional().describe('Context / vocabulary hint.'),
        route: ROUTE_AUDIO,
      },
      handler: safe(async (a, extra) => {
        let surface = surfaceOf(ctx, a.route)
        if (ctx.client.mode === 'x402') surface = 'carpe'
        const media = await loadMedia(a.audio, { ...ctx.media, maxInputBytes: 19 * 1024 * 1024 }, 'audio/mpeg')
        const model = a.model ?? 'openai/whisper-large-v3'
        const form = new FormData()
        form.append('file', new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: media.mime }), `audio.${extFor(media.mime)}`)
        form.append('model', model)
        for (const k of ['language', 'response_format', 'prompt'] as const) if (a[k] !== undefined) form.append(k, String(a[k]))
        const res = await paid(ctx, 'carpe_transcribe', undefined, {
          method: 'POST',
          path: surface === 'router' ? '/router/audio/transcriptions' : '/v1/audio/transcriptions',
          x402Path: '/v1/x402/audio/transcriptions',
          form,
          auth: 'paid',
          signal: extra.signal,
        })
        const out = res.isJson ? res.json<Record<string, unknown>>() : { text: res.text() }
        const text = typeof out.text === 'string' ? out.text : JSON.stringify(out)
        return ok(text, { model, transcription: out, cost: costInfo(res.meta, undefined, ctx.guard), route: routeInfo(surface, res.meta) })
      }),
    },
    {
      name: 'carpe_voice_clone',
      title: 'Clone a voice',
      description:
        'Upload a short reference sample (one speaker) and get a vv_… voice handle for carpe_tts (route "carpe", same model). The upload itself is free but needs a funded account. ' +
        'ONLY with consent: the voice must be the user\'s own, or its speaker must have agreed to be cloned. The handle expires (~7 days).',
      paid: false,
      inputSchema: {
        sample: z.string().min(1).describe('Audio sample: https:// URL, data: URI, or local path (stdio).'),
        model: z.string().optional().describe('TTS model that clones (default tts-chatterbox-hd).'),
        consent: z.literal(true).describe('Must be true: the voice is the user\'s, or its speaker consented to cloning.'),
      },
      handler: safe(async (a, extra) => {
        const media = await loadMedia(a.sample, { ...ctx.media, maxInputBytes: 19 * 1024 * 1024 }, 'audio/wav')
        const model = a.model ?? 'tts-chatterbox-hd'
        const form = new FormData()
        form.append('file', new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: media.mime }), `sample.${extFor(media.mime)}`)
        form.append('model', model)
        form.append('consent', 'true')
        const res = await ctx.client.request({ method: 'POST', path: '/v1/audio/voices', form, auth: 'account', retry: 'none', signal: extra.signal })
        const out = res.json<{ id?: string; model?: string; expires_at?: string }>()
        return ok(`Voice cloned: ${out.id} (model ${out.model ?? model}, expires ${out.expires_at ?? 'unknown'}). Use it as voice in carpe_tts with route "carpe".`, { ...out })
      }),
    },
  ]
}
