/** Free, read-only tools: catalogue, prices, quotes, markets, status. */
import { z } from 'zod'
import { estimateInputTokens } from '../spend-guard.js'
import { TEE_MARKETS, json, safe, type ToolContext, type ToolDef } from './context.js'

const MODEL_TYPES = ['text', 'code', 'embedding', 'image', 'imageEdit', 'upscale', 'tts', 'asr', 'music', 'video', 'imageToVideo', 'referenceToVideo'] as const

interface ModelRow {
  id: string
  carpe_diem_type?: string
  tier?: string
  privacy?: string
  capabilities?: Record<string, unknown>
  context_length?: number
  max_completion_tokens?: number
  constraints?: unknown
  carpe_diem_constraints?: unknown
  voices?: unknown[]
  carpe_router?: { markets?: string[] }
  [k: string]: unknown
}

export async function fetchModels(ctx: ToolContext, surface: 'carpe' | 'router' = 'carpe'): Promise<ModelRow[]> {
  const res = await ctx.client.request({ path: surface === 'router' ? '/router/models' : '/v1/models', auth: 'optional' })
  return res.json<{ data: ModelRow[] }>().data ?? []
}

function compact(m: ModelRow): Record<string, unknown> {
  const caps = Object.entries(m.capabilities ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k.replace(/^supports/, '').replace(/^optimizedFor/, 'optimizedFor'))
  return {
    id: m.id,
    type: m.carpe_diem_type,
    ...(m.tier ? { tier: m.tier } : {}),
    ...(m.privacy ? { privacy: m.privacy } : {}),
    ...(m.context_length ? { context_length: m.context_length } : {}),
    ...(caps.length ? { capabilities: caps } : {}),
    ...(m.carpe_router?.markets ? { router_markets: m.carpe_router.markets } : {}),
    ...(Array.isArray(m.voices) && m.voices.length ? { voices: m.voices.length } : {}),
    ...(m.carpe_diem_constraints ? { carpe_constraints: m.carpe_diem_constraints } : {}),
  }
}

export function catalogTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: 'carpe_list_models',
      title: 'List Carpe Diem models',
      description:
        'Page through the live Carpe Diem model catalogue (Venice models plus Carpe metadata). Filter by type (text, image, video, tts, …), capability, privacy or a search string. ' +
        'Use carpe_diem_type to pick the right tool: text/code → carpe_chat, embedding → carpe_embeddings, image → carpe_image_generate, imageEdit → carpe_image_edit, upscale → carpe_image_upscale, tts → carpe_tts, asr → carpe_transcribe, music → carpe_music_generate, video/imageToVideo/referenceToVideo → carpe_video_generate. ' +
        'route "router" reads /router/models, which adds the best-price markets able to serve each text model. Free.',
      paid: false,
      inputSchema: {
        type: z.enum([...MODEL_TYPES, 'all']).optional().describe('Filter by carpe_diem_type (default all).'),
        search: z.string().optional().describe('Case-insensitive substring of the model id.'),
        capability: z.string().optional().describe('Keep models whose capability flag is true, e.g. Vision, FunctionCalling, Reasoning, WebSearch, ResponseSchema, TeeAttestation.'),
        privacy: z.enum(['private', 'anonymized']).optional().describe('"private": Venice runs the model without logging; "anonymized": proxied to its maker.'),
        route: z.enum(['carpe', 'router']).optional().describe('"carpe" = /v1/models (default); "router" = /router/models with router_markets per text model.'),
        limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50).'),
        offset: z.number().int().min(0).optional(),
        verbose: z.boolean().optional().describe('Return full catalogue rows (constraints, voices…) instead of summaries.'),
      },
      handler: safe(async (a) => {
        const surface = a.route === 'router' ? 'router' : 'carpe'
        let rows = await fetchModels(ctx, surface)
        if (a.type && a.type !== 'all') rows = rows.filter((m) => m.carpe_diem_type === a.type)
        if (a.search) rows = rows.filter((m) => m.id.toLowerCase().includes(String(a.search).toLowerCase()))
        if (a.privacy) rows = rows.filter((m) => m.privacy === a.privacy)
        if (a.capability) {
          const want = String(a.capability).replace(/^supports/i, '').toLowerCase()
          rows = rows.filter((m) => Object.entries(m.capabilities ?? {}).some(([k, v]) => v === true && k.replace(/^supports/, '').toLowerCase() === want))
        }
        const limit = a.limit ?? 50
        const offset = a.offset ?? 0
        const page = rows.slice(offset, offset + limit)
        return json({
          total: rows.length,
          offset,
          next_offset: offset + limit < rows.length ? offset + limit : null,
          surface: surface === 'router' ? '/router/models' : '/v1/models',
          models: a.verbose ? page : page.map(compact),
        })
      }),
    },
    {
      name: 'carpe_model_details',
      title: 'Model details',
      description:
        'Everything about one model: catalogue row (capabilities, constraints such as video durations or music lengths, TTS voices), Carpe price (USD per 1M tokens, or fixed cost per image/call), Venice rate limits and live capacity. Free.',
      paid: false,
      inputSchema: { model: z.string().min(1).describe('Exact model id, e.g. from carpe_list_models.') },
      handler: safe(async (a) => {
        const model = String(a.model)
        const [models, pricing, limits, capacity] = await Promise.allSettled([
          fetchModels(ctx),
          ctx.estimator.getPricing(),
          ctx.client.request({ path: `/v1/limits/${encodeURIComponent(model)}`, auth: 'none', retry: 'none' }).then((r) => r.json()),
          ctx.client.request({ path: '/v1/capacity', query: { model }, auth: 'none', retry: 'none' }).then((r) => r.json()),
        ])
        const row = models.status === 'fulfilled' ? models.value.find((m) => m.id === model) : undefined
        if (models.status === 'fulfilled' && !row) {
          const near = models.value.filter((m) => m.id.includes(model) || model.includes(m.id)).slice(0, 10).map((m) => m.id)
          return json({ error: { code: 'INVALID_MODEL', message: `No model "${model}" in the catalogue.`, did_you_mean: near } })
        }
        const p = pricing.status === 'fulfilled' ? pricing.value : undefined
        return json({
          model,
          catalogue: row ?? null,
          price: p
            ? {
                tokens: p.models.find((r) => r.model === model) ?? null,
                fixed_cost: p.fixedCost.find((r) => r.model === model) ?? null,
                units: 'Token prices are USD per 1M tokens, already including the dynamic multiplier (inputPrice / outputPrice). Fixed costs are USD per image or per call.',
                updated_at: p.updatedAt,
              }
            : null,
          venice_rate_limits: limits.status === 'fulfilled' ? limits.value : null,
          capacity: capacity.status === 'fulfilled' ? capacity.value : null,
        })
      }),
    },
    {
      name: 'carpe_pricing',
      title: 'Carpe Diem prices',
      description:
        'Live Carpe prices. Token models: USD per 1M input/output tokens (inputPrice/outputPrice, after the dynamic multiplier; inputBase/outputBase are Venice list prices). Media: fixed USD per image/edit/web call. Filter by model substring. Free.',
      paid: false,
      inputSchema: {
        model: z.string().optional().describe('Substring filter on the model id.'),
        kind: z.enum(['tokens', 'fixed', 'all']).optional().describe('Token-priced rows, fixed-cost rows, or both (default).'),
        sort: z.enum(['cheapest_input', 'cheapest_output', 'name']).optional(),
        limit: z.number().int().min(1).max(500).optional().describe('Max rows per list (default 100).'),
      },
      handler: safe(async (a) => {
        const p = await ctx.estimator.getPricing()
        const f = (id: string) => !a.model || id.toLowerCase().includes(String(a.model).toLowerCase())
        let tokens = p.models.filter((r) => f(r.model))
        const fixed = p.fixedCost.filter((r) => f(r.model))
        if (a.sort === 'cheapest_input') tokens = [...tokens].sort((x, y) => (x.inputPrice ?? 1e9) - (y.inputPrice ?? 1e9))
        if (a.sort === 'cheapest_output') tokens = [...tokens].sort((x, y) => (x.outputPrice ?? 1e9) - (y.outputPrice ?? 1e9))
        if (a.sort === 'name') tokens = [...tokens].sort((x, y) => x.model.localeCompare(y.model))
        const limit = a.limit ?? 100
        return json({
          updated_at: p.updatedAt,
          units: { tokens: 'USD per 1M tokens', fixed: 'USD per unit (image, edit, call)' },
          ...(a.kind !== 'fixed' ? { token_models: tokens.slice(0, limit), token_models_total: tokens.length } : {}),
          ...(a.kind !== 'tokens' ? { fixed_cost: fixed.slice(0, limit), fixed_cost_total: fixed.length } : {}),
        })
      }),
    },
    {
      name: 'carpe_quote',
      title: 'Quote a chat request across markets',
      description:
        'Price a text request BEFORE running it, on both surfaces: what /v1 (Carpe alone, in its TEE) would bill, and what /router (best price) would pick among the markets — with each market\'s price, availability and whether it is a TEE. ' +
        'Give messages (or a prompt) so the input size is estimated, or input_tokens directly. Costs nothing.',
      paid: false,
      inputSchema: {
        model: z.string().optional().describe(`Model id (default ${ctx.cfg.defaultChatModel}).`),
        messages: z.array(z.record(z.any())).optional().describe('OpenAI-style messages, used only to estimate input tokens.'),
        prompt: z.string().optional().describe('Alternative to messages for a single user prompt.'),
        input_tokens: z.number().int().min(1).optional().describe('Override the input-token estimate.'),
        max_tokens: z.number().int().min(1).optional().describe('Expected output tokens (default 1000).'),
        privacy: z.union([z.boolean(), z.literal('private')]).optional().describe('Router privacy filter: true = TEE markets only; "private" = no-retention markets for private models.'),
      },
      handler: safe(async (a) => {
        const model = a.model ?? ctx.cfg.defaultChatModel
        const input = a.input_tokens ?? estimateInputTokens(a.messages ?? a.prompt ?? '')
        const res = await ctx.client.request({
          method: 'POST',
          path: '/router/quote',
          auth: 'none',
          json: { model, input_tokens: input, max_tokens: a.max_tokens ?? 1000, ...(a.privacy !== undefined ? { privacy: a.privacy } : {}) },
        })
        const q = res.json<Record<string, any>>()
        const candidates = (q.candidates ?? []).map((c: Record<string, unknown>) => ({ ...c, tee: TEE_MARKETS.has(String(c.market)) }))
        const carpe = candidates.find((c: Record<string, unknown>) => c.market === 'carpe')
        return json({
          model: q.model ?? model,
          tokens: q.tokens,
          surfaces: {
            carpe: {
              endpoint_prefix: '/v1',
              available: carpe?.available ?? q.carpeCostUsd != null,
              cost_usd: carpe?.available === false ? null : q.carpeCostUsd ?? null,
              tee: true,
              ...(carpe?.note ? { note: carpe.note } : {}),
            },
            router: {
              endpoint_prefix: '/router',
              best: q.best ? { ...q.best, tee: TEE_MARKETS.has(String(q.best.market)) } : null,
              saved_vs_carpe_usd: q.savedVsCarpeUsdc ?? null,
              saved_pct: q.savedPct ?? null,
            },
          },
          venice_list_price_usd: q.veniceCostUsd ?? null,
          candidates,
          privacy: q.privacy,
          input_tokens_estimated: a.input_tokens === undefined,
          note: 'External market prices include the router fee. "unverified" deliverability is indicative until a paid request confirms it. Actual cost depends on the real output length.',
        })
      }),
    },
    {
      name: 'carpe_markets',
      title: 'Best-price router markets',
      description: 'Live state of the /router best-price markets: which markets are on, the external routing fee, observed latency per market, and whether external execution is open to this key. Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => {
        const res = await ctx.client.request({ path: '/router/markets', auth: 'optional' })
        return json(res.json<Record<string, unknown>>())
      }),
    },
    {
      name: 'carpe_status',
      title: 'Carpe Diem service status',
      description: 'Operator health (database, settlement, providers) and marketplace capacity (headroom, dynamic price multiplier). Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => {
        const [health, capacity] = await Promise.allSettled([
          ctx.client.request({ path: '/health', auth: 'none' }).then((r) => r.json()),
          ctx.client.request({ path: '/v1/capacity', auth: 'none' }).then((r) => r.json()),
        ])
        return json({
          base_url: ctx.cfg.baseUrl,
          payment_mode: ctx.client.mode,
          health: health.status === 'fulfilled' ? health.value : { error: String(health.reason) },
          capacity: capacity.status === 'fulfilled' ? capacity.value : { error: String(capacity.reason) },
        })
      }),
    },
  ]
}
