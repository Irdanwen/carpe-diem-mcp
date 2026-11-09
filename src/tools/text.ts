/** Paid text tools: chat, embeddings, web search / scrape. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CallMeta } from '../carpe-client.js'
import { LocalRefusal } from '../errors.js'
import { aggregateChatStream } from '../sse.js'
import { estimateInputTokens } from '../spend-guard.js'
import { costInfo, ok, paid, routeInfo, safe, surfaceOf, type ToolContext, type ToolDef } from './context.js'
import { fetchModels } from './catalog.js'

const ROUTE = z
  .enum(['carpe', 'router'])
  .optional()
  .describe('"carpe" → /v1: Carpe alone, always in its TEE, Carpe price. "router" → /router: best price across markets (may be served outside a TEE; see privacy). Default from CARPE_DEFAULT_ROUTE.')

const PRIVACY = z
  .union([z.boolean(), z.literal('private')])
  .optional()
  .describe('route "router" only. true = TEE markets only (Carpe, Chutes, Venice); "private" = for models Venice runs privately, only markets that keep nothing. Ignored on route "carpe", which is always TEE.')

export function textTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: 'carpe_chat',
      title: 'Chat completion',
      description:
        'Run a chat completion on Carpe Diem (OpenAI-compatible; Venice models: GPT, Claude, Gemini, DeepSeek, GLM, Qwen, Llama, uncensored models…). ' +
        'Two surfaces: route "carpe" (/v1, Carpe\'s TEE, private) or route "router" (/router, cheapest market). Returns the answer plus usage, the exact cost billed and which market served it. ' +
        'Supports function tools, response_format (JSON schema), reasoning_effort and Venice web search. Paid — use carpe_quote first for expensive requests.',
      paid: true,
      inputSchema: {
        prompt: z.string().optional().describe('User message (shortcut for messages).'),
        system: z.string().optional().describe('System prompt, used with prompt.'),
        messages: z.array(z.record(z.any())).optional().describe('Full OpenAI-style messages array (takes precedence over prompt/system).'),
        model: z.string().optional().describe(`Model id (default ${ctx.cfg.defaultChatModel}). See carpe_list_models type "text".`),
        route: ROUTE,
        max_tokens: z.number().int().min(1).optional().describe('Output token cap (also bounds the cost).'),
        temperature: z.number().min(0).max(2).optional(),
        top_p: z.number().min(0).max(1).optional(),
        stop: z.union([z.string(), z.array(z.string())]).optional(),
        seed: z.number().int().optional(),
        response_format: z.record(z.any()).optional().describe('e.g. {"type":"json_schema","json_schema":{…}}'),
        tools: z.array(z.record(z.any())).optional().describe('OpenAI function tools; tool calls are returned, not executed.'),
        tool_choice: z.any().optional(),
        reasoning_effort: z.string().optional().describe('none | low | medium | high … (model-dependent).'),
        web_search: z.enum(['off', 'auto', 'on']).optional().describe('Venice web search (extra flat fee per search that runs).'),
        privacy: PRIVACY,
        provider: z
          .object({
            sort: z.enum(['price', 'latency', 'throughput']).optional(),
            max_price: z.object({ prompt: z.number(), completion: z.number(), request: z.number().optional() }).optional().describe('USD per 1M tokens.'),
            zdr: z.boolean().optional().describe('Only markets that retain nothing.'),
            data_collection: z.enum(['allow', 'deny']).optional(),
          })
          .optional()
          .describe('route "router" only: OpenRouter-style routing preferences.'),
        extra: z.record(z.any()).optional().describe('Additional body fields passed through verbatim (e.g. venice_parameters, frequency_penalty).'),
      },
      handler: safe(async (a, extra) => {
        const surface = surfaceOf(ctx, a.route)
        const model: string = a.model ?? ctx.cfg.defaultChatModel
        const messages =
          a.messages ??
          (a.prompt !== undefined ? [...(a.system ? [{ role: 'system', content: a.system }] : []), { role: 'user', content: a.prompt }] : undefined)
        if (!messages?.length) throw new LocalRefusal('BAD_REQUEST', 'Give prompt or messages.')
        const notes: string[] = []
        const body: Record<string, unknown> = { ...(a.extra ?? {}), model, messages }
        for (const k of ['max_tokens', 'temperature', 'top_p', 'stop', 'seed', 'response_format', 'tools', 'tool_choice', 'reasoning_effort'] as const) {
          if (a[k] !== undefined) body[k] = a[k]
        }
        if (a.web_search && a.web_search !== 'off') {
          body.venice_parameters = { ...((body.venice_parameters as object) ?? {}), enable_web_search: a.web_search }
        }
        if (surface === 'router') {
          if (a.privacy !== undefined) body.privacy = a.privacy
          if (a.provider) body.provider = a.provider
        } else {
          if (a.privacy !== undefined) notes.push('privacy ignored: route "carpe" (/v1) is always served in Carpe\'s TEE.')
          if (a.provider) notes.push('provider ignored: it only applies to route "router".')
        }

        const estimate = await ctx.estimator.tokenCost(model, estimateInputTokens(messages), a.max_tokens ?? 1024, surface, a.privacy)
        const hold = ctx.guard.reserve('carpe_chat', estimate)

        let completion: Record<string, any> = {}
        let meta: CallMeta = { status: 0 }
        try {
        if (ctx.client.usesBearer) {
          const path = surface === 'router' ? '/router/chat/completions' : '/v1/chat/completions'
          const r = await ctx.client.openStream({
            path,
            json: { ...body, stream: true, stream_options: { include_usage: true } },
            // The router replays the first answer for a repeated key instead of re-running (and re-billing) it.
            idempotencyKey: surface === 'router' && a.privacy === undefined && !a.provider?.zdr && a.provider?.data_collection !== 'deny' ? randomUUID() : undefined,
            signal: extra.signal,
          })
          meta = r.meta
          if (r.json) completion = r.json as Record<string, any>
          else {
            const agg = await aggregateChatStream(r.stream!, ctx.cfg.maxJsonBytes)
            completion = agg.completion
            if (meta.costUsd === undefined && agg.costUsd !== undefined) {
              meta.costUsd = agg.costUsd
              meta.costSource = 'stream-usage'
            }
            if (agg.route?.market && !meta.routeMarket) meta.routeMarket = agg.route.market
            if (agg.route?.reason && !meta.routeReason) meta.routeReason = agg.route.reason
            if (agg.route?.attempts && !meta.routeAttempts) meta.routeAttempts = agg.route.attempts
          }
          if (meta.costUsd === undefined) {
            const micro = Number(completion?.usage?.carpe_cost_usdc_micro)
            if (Number.isFinite(micro)) {
              meta.costUsd = micro / 1e6
              meta.costSource = 'stream-usage'
            }
          }
        } else {
          // x402 (or no payment → refused by the client): the x402 chat routes answer non-streamed.
          const res = await ctx.client.request({
            method: 'POST',
            auth: 'paid',
            path: surface === 'router' ? '/router/chat/completions' : '/v1/chat/completions',
            x402Path: surface === 'router' ? '/router/x402/chat/completions' : '/v1/x402/chat/completions',
            json: { ...body, stream: false },
            signal: extra.signal,
          })
          meta = res.meta
          completion = res.json<Record<string, any>>()
        }
        } catch (err) {
          ctx.guard.fail(hold, err)
          throw err
        }
        ctx.guard.settle(hold, meta)

        const choice = completion?.choices?.[0] ?? {}
        const msg = choice.message ?? {}
        const route = routeInfo(surface, meta, a.privacy)
        const cost = costInfo(meta, estimate, ctx.guard)
        const structured: Record<string, unknown> = {
          model: completion.model ?? model,
          content: msg.content ?? null,
          ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          finish_reason: choice.finish_reason ?? null,
          usage: completion.usage ?? null,
          cost,
          route,
          ...(completion.id ? { id: completion.id } : {}),
          ...(meta.compat ? { compat: meta.compat } : {}),
          ...(notes.length ? { notes } : {}),
        }
        const footer = `\n\n— ${cost.usd !== null ? `$${Number(cost.usd).toFixed(6)}` : 'cost not reported'} · ${route.surface === 'carpe' ? '/v1 (Carpe TEE)' : `/router → ${route.route_used}${route.tee === false ? ' (not TEE)' : ''}`} · ${structured.model}`
        const text =
          (typeof msg.content === 'string' && msg.content ? msg.content : '') +
          (msg.tool_calls ? `${msg.content ? '\n\n' : ''}Tool calls:\n${JSON.stringify(msg.tool_calls, null, 2)}` : '') +
          footer
        return ok(text, structured)
      }),
    },
    {
      name: 'carpe_embeddings',
      title: 'Embeddings',
      description:
        'Compute embedding vectors (OpenAI-compatible) for 1–128 texts. route "carpe" (/v1) or "router" (/router, cheapest market; privacy applies). Paid per input token.',
      paid: true,
      inputSchema: {
        input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(128)]).describe('Text or array of up to 128 texts.'),
        model: z.string().optional().describe('Embedding model id (default: text-embedding-bge-m3). See carpe_list_models type "embedding".'),
        route: ROUTE,
        dimensions: z.number().int().min(1).optional(),
        encoding_format: z.enum(['float', 'base64']).optional(),
        privacy: PRIVACY,
      },
      handler: safe(async (a, extra) => {
        const surface = surfaceOf(ctx, a.route)
        let model: string | undefined = a.model
        if (!model) {
          const all = await fetchModels(ctx).catch(() => [])
          model = all.find((m) => m.id === 'text-embedding-bge-m3')?.id ?? all.find((m) => m.carpe_diem_type === 'embedding')?.id ?? 'text-embedding-bge-m3'
        }
        const body: Record<string, unknown> = { model, input: a.input }
        if (a.dimensions) body.dimensions = a.dimensions
        if (a.encoding_format) body.encoding_format = a.encoding_format
        if (surface === 'router' && a.privacy !== undefined) body.privacy = a.privacy
        const estimate = await ctx.estimator.tokenCost(model, estimateInputTokens(a.input), 1, surface, a.privacy)
        const res = await paid(ctx, 'carpe_embeddings', estimate, {
          method: 'POST',
          path: surface === 'router' ? '/router/embeddings' : '/v1/embeddings',
          x402Path: '/v1/x402/embeddings',
          json: body,
          auth: 'paid',
          signal: extra.signal,
        })
        const out = res.json<{ data?: { index: number; embedding: number[] | string }[]; model?: string; usage?: unknown }>()
        const vectors = out.data ?? []
        const dims = Array.isArray(vectors[0]?.embedding) ? (vectors[0].embedding as number[]).length : null
        const structured = {
          model: out.model ?? model,
          count: vectors.length,
          dimensions: dims,
          embeddings: vectors.map((v) => v.embedding),
          usage: out.usage ?? null,
          cost: costInfo(res.meta, estimate, ctx.guard),
          route: routeInfo(ctx.client.mode === 'x402' ? 'carpe' : surface, res.meta, a.privacy),
        }
        return ok(JSON.stringify(structured), structured)
      }),
    },
    {
      name: 'carpe_web_search',
      title: 'Web search',
      description: 'Live web search through Carpe (Venice augment/search). Always on /v1 — no market arbitrates web search. Flat fee per call (see carpe_pricing, model augment-search).',
      paid: true,
      inputSchema: {
        query: z.string().min(1),
        extra: z.record(z.any()).optional().describe('Additional Venice augment/search parameters, passed through.'),
      },
      handler: safe(async (a, extra) => {
        const estimate = await ctx.estimator.fixedCost('augment-search')
        const res = await paid(ctx, 'carpe_web_search', estimate, {
          method: 'POST', path: '/v1/augment/search', x402Path: '/v1/x402/augment/search', json: { ...(a.extra ?? {}), query: a.query }, auth: 'paid', signal: extra.signal,
        })
        const out = res.json<Record<string, unknown>>()
        return ok(JSON.stringify(out, null, 2), { result: out, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('carpe', res.meta) })
      }),
    },
    {
      name: 'carpe_web_scrape',
      title: 'Web page scrape',
      description: 'Fetch one web page as text/markdown through Carpe (Venice augment/scrape). Always on /v1. Flat fee per call.',
      paid: true,
      inputSchema: {
        url: z.string().url(),
        extra: z.record(z.any()).optional(),
      },
      handler: safe(async (a, extra) => {
        const estimate = await ctx.estimator.fixedCost('augment-scrape')
        const res = await paid(ctx, 'carpe_web_scrape', estimate, {
          method: 'POST', path: '/v1/augment/scrape', x402Path: '/v1/x402/augment/scrape', json: { ...(a.extra ?? {}), url: a.url }, auth: 'paid', signal: extra.signal,
        })
        const out = res.isJson ? res.json<Record<string, unknown>>() : { content: res.text() }
        const content = typeof out.content === 'string' ? out.content : typeof out.markdown === 'string' ? out.markdown : JSON.stringify(out, null, 2)
        return ok(content, { result: out, cost: costInfo(res.meta, estimate, ctx.guard), route: routeInfo('carpe', res.meta) })
      }),
    },
  ]
}
