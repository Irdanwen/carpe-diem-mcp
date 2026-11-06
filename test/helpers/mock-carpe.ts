/**
 * A fake Carpe Diem operator reproducing the shapes observed in the real one
 * (operator/src/app.ts, routes/*.ts on Lumen-labs-ch/Carpe-diem- main, and live
 * answers of https://carpe-diem.xyz/api/operator on 2026-11-06).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { recoverTypedDataAddress } from 'viem'

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
export const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)])
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 2)])
export const ESCROW = '0x15917768b31CB1DC61d9d858f2419BF45044005d'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const KEY = 'cdm_' + 'ab'.repeat(32)

export interface Recorded {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

export interface MockCarpe {
  url: string
  base: string
  calls: Recorded[]
  counters: Record<string, number>
  x402: { challengeOverride?: Record<string, unknown>; pricedMicros: number; billedMicros: number; payer?: string }
  close: () => Promise<void>
}

const challenge = (resource: string, micros: number, override?: Record<string, unknown>) => ({
  x402Version: 1,
  error: 'X-PAYMENT header required',
  accepts: [
    {
      network: 'base',
      maxAmountRequired: String(micros),
      payTo: ESCROW,
      asset: USDC,
      description: 'Carpe Diem inference',
      resource,
      maxTimeoutSeconds: 600,
      scheme: 'carpe-session',
      extra: { name: 'USD Coin', version: '2' },
      ...(override ?? {}),
    },
  ],
})

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks)
  const ct = req.headers['content-type'] ?? ''
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      return raw.toString('utf8')
    }
  }
  if (ct.includes('multipart/form-data')) return { multipart: raw.toString('latin1') }
  return raw.length ? raw.toString('utf8') : undefined
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'content-length': String(body.length), ...headers })
    res.end(body)
    return
  }
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(s)), ...headers })
  res.end(s)
}

function sse(res: ServerResponse, chunks: unknown[], headers: Record<string, string> = {}, comments: string[] = []) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
  for (const c of comments) res.write(`${c}\n\n`)
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const MODELS = [
  { id: 'llama-3.3-70b', carpe_diem_type: 'text', tier: 'premium', privacy: 'private', capabilities: { supportsFunctionCalling: true, supportsVision: false }, context_length: 131072 },
  { id: 'claude-opus-4-8', carpe_diem_type: 'text', tier: 'frontier', privacy: 'anonymized', capabilities: { supportsVision: true } },
  { id: 'text-embedding-bge-m3', carpe_diem_type: 'embedding' },
  { id: 'z-image-turbo', carpe_diem_type: 'image' },
  { id: 'gpt-image-2', carpe_diem_type: 'image' },
  { id: 'tts-kokoro', carpe_diem_type: 'tts', voices: ['af_bella', 'am_adam'] },
  { id: 'kling-2.5-turbo-pro-text-to-video', carpe_diem_type: 'video', constraints: { durations: ['5s', '10s'] } },
  { id: 'ace-step-15', carpe_diem_type: 'music' },
]

export async function startMockCarpe(): Promise<MockCarpe> {
  const calls: Recorded[] = []
  const counters: Record<string, number> = {}
  const x402: MockCarpe['x402'] = { pricedMicros: 261, billedMicros: 0 }
  let musicClaimed = false
  let imagePolls = 0
  const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1)

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname.replace(/^\/api\/operator/, '')
    const body = req.method === 'POST' ? await readBody(req) : undefined
    calls.push({ method: req.method ?? 'GET', path: p, headers: req.headers, body })
    const authed = req.headers.authorization === `Bearer ${KEY}`
    const needKey = () => {
      if (!authed) {
        send(res, 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' })
        return false
      }
      return true
    }
    const cost = (micro: number) => ({ 'x-carpe-cost-usdc-micro': String(micro), 'x-carpe-available-credits': '1234' })

    switch (`${req.method} ${p}`) {
      case 'GET /v1/models':
        return send(res, 200, { object: 'list', data: MODELS })
      case 'GET /router/models':
        return send(res, 200, { object: 'list', data: MODELS.map((m) => (m.carpe_diem_type === 'text' ? { ...m, carpe_router: { markets: ['carpe', 'openrouter'] } } : m)) })
      case 'GET /pricing':
        return send(res, 200, {
          models: [
            { model: 'llama-3.3-70b', inputPrice: 0.37, outputPrice: 1.49 },
            { model: 'tts-kokoro', inputPrice: 1.86 },
            { model: 'ace-step-15', inputPrice: 0.016 },
          ],
          fixedCost: [
            { model: 'z-image-turbo', type: 'image', costUsd: 0.0053 },
            { model: 'gpt-image-2', type: 'image', costUsd: 0.9 },
            { model: 'augment-search', type: 'augment', costUsd: 0.0053 },
          ],
          updatedAt: '2026-11-06T00:00:00Z',
        })
      case 'GET /health':
        return send(res, 200, { status: 'healthy', components: {} })
      case 'GET /v1/capacity':
        return send(res, 200, { headroomUsd: 10, multiplier: { total: 0.53 } })
      case 'GET /router/markets':
        return send(res, 200, { enabled: true, externalFeePct: 0.2, markets: ['carpe', 'openrouter'] })
      case 'POST /router/quote': {
        const out = Number(body?.max_tokens ?? 1000)
        const carpe = (out * 1.49 + Number(body?.input_tokens ?? 1000) * 0.37) / 1e6
        if (body?.model === 'expensive') return send(res, 200, { model: 'expensive', carpeCostUsd: 3, best: { market: 'carpe', costUsd: 3, available: true }, candidates: [{ market: 'carpe', available: true, costUsd: 3 }] })
        return send(res, 200, {
          model: body?.model,
          tokens: { input: body?.input_tokens, output: out },
          carpeCostUsd: carpe,
          veniceCostUsd: carpe * 2,
          best: { market: 'openrouter', costUsd: carpe / 2, available: true },
          candidates: [
            { market: 'carpe', available: true, costUsd: carpe, isTEE: true },
            { market: 'openrouter', available: true, costUsd: carpe / 2, isTEE: false },
          ],
          savedVsCarpeUsdc: carpe / 2,
          savedPct: 50,
        })
      }
      case 'GET /v1/credits':
        if (!needKey()) return
        return send(res, 200, { availableCredits: 1234, availableUsdc: '12.34', escrowCredits: 2000, pendingCredits: 766 })
      case 'GET /buyer/debt':
        if (!needKey()) return
        return send(res, 200, { pendingUsdc: '0.5', pendingUsdcMicro: '500000', pendingCredits: 50 })
      case 'GET /v1/prepaid/status':
        if (!needKey()) return
        return send(res, 200, { registered: false })
      case 'GET /v1/prepaid/rail':
        if (!needKey()) return
        return send(res, 200, { rail: 'auto', hasPrepaidAccount: false })
      case 'GET /buyer/usage':
        if (!needKey()) return
        return send(res, 200, { events: [{ id: 1, model: 'llama-3.3-70b', cost_usdc: 0.001 }], total: 1, query: Object.fromEntries(url.searchParams) })
      case 'GET /redirect':
        res.writeHead(302, { location: 'http://evil.example/' })
        return res.end()

      case 'POST /v1/chat/completions':
      case 'POST /router/chat/completions': {
        if (!needKey()) return
        const router = p.startsWith('/router')
        const model = body?.model
        if (model === 'bad') return send(res, 400, { error: { message: 'Unknown model: bad', type: 'invalid_request_error', code: 'INVALID_MODEL', param: 'model' }, code: 'INVALID_MODEL' })
        if (model === 'poor') return send(res, 402, { error: 'Payment rail cannot cover this request', code: 'PAYMENT_REQUIRED', tried: ['credits'], minRequired: '0.010000' })
        if (model === 'busy' && bump('busy') === 1) return send(res, 503, { error: 'No capacity', code: 'NO_PROVIDER_CAPACITY', retry_after_ms: 10 }, { 'retry-after': '0' })
        if (model === 'ambiguous') {
          bump('ambiguous')
          return send(res, 502, { error: 'Upstream failed', code: 'VENICE_ERROR' })
        }
        const routeHeaders: Record<string, string> = router ? { 'x-carpe-route-market': 'openrouter', 'x-carpe-route-reason': 'cheapest', 'x-carpe-route-saved-usdc': '0.0004' } : { 'x-provider-id': 'abcd1234' }
        if (!body?.stream) {
          return send(res, 200, { id: 'c1', model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, { ...routeHeaders, ...cost(1500) })
        }
        if (model === 'tooly') {
          return sse(res, [
            { id: 'c2', model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'get_', arguments: '{"a"' } }] } }] },
            { id: 'c2', model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'weather', arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
            { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, carpe_cost_usdc_micro: 777 } },
          ], routeHeaders)
        }
        return sse(
          res,
          [
            { id: 'c1', model, created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
            { id: 'c1', model, choices: [{ index: 0, delta: { content: 'lo!' }, finish_reason: 'stop' }] },
            { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, carpe_cost_usdc_micro: 1500, carpe_credits: 0.15 } },
          ],
          routeHeaders,
        )
      }

      case 'POST /v1/x402/chat/completions':
      case 'POST /router/x402/chat/completions': {
        const header = req.headers['x-payment'] as string | undefined
        if (!header) return send(res, 402, challenge(p, x402.pricedMicros, x402.challengeOverride))
        const pay = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
        const { owner, spender, value, nonce, deadline, signature } = pay.payload
        const recovered = await recoverTypedDataAddress({
          domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
          types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
          primaryType: 'Permit',
          message: { owner, spender, value: BigInt(value), nonce: BigInt(nonce), deadline: BigInt(deadline) },
          signature,
        })
        if (recovered.toLowerCase() !== String(owner).toLowerCase() || pay.scheme !== 'carpe-session' || spender !== ESCROW) {
          return send(res, 402, { error: 'bad permit', code: 'X402_INVALID' })
        }
        if (BigInt(value) < BigInt(x402.billedMicros + x402.pricedMicros)) return send(res, 402, { error: 'authorized budget exhausted', code: 'X402_INVALID' })
        x402.payer = owner
        x402.billedMicros += x402.pricedMicros
        bump('x402-paid')
        return send(res, 200, { id: 'x1', model: body?.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Paid hello' }, finish_reason: 'stop' }] }, {
          'x-payment-amount-usdc': (x402.pricedMicros / 1e6).toFixed(6),
          'x-payment-settlement': 'batched',
          ...(p.startsWith('/router') ? { 'x-carpe-route-market': 'carpe' } : {}),
        })
      }

      case 'POST /v1/embeddings':
      case 'POST /router/embeddings':
        if (!needKey()) return
        return send(res, 200, { object: 'list', model: body.model, data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3 } }, { ...cost(10), ...(p.startsWith('/router') ? { 'x-carpe-route-market': 'carpe' } : {}) })

      case 'POST /v1/augment/search':
        if (!needKey()) return
        return send(res, 200, { query: body.query, results: [{ title: 'A', url: 'https://a.example' }] }, cost(5300))

      case 'POST /v1/image/generate':
        if (!needKey()) return
        return send(res, 200, { images: [PNG.toString('base64')], format: 'png' }, cost(5300))
      case 'POST /v1/image/generate/queue':
        if (!needKey()) return
        return send(res, 202, { queue_id: 'img-q1', status: 'pending' }, cost(900000))
      case 'POST /v1/image/generate/retrieve':
        if (!needKey()) return
        if (++imagePolls < 2) return send(res, 200, { status: 'pending', queue_id: body.queue_id })
        return send(res, 200, PNG, { 'content-type': 'image/png', 'x-carpe-image-status': 'completed' })
      case 'POST /v1/image/generate/complete':
        return send(res, 200, { status: 'released' })
      case 'POST /router/images/generations':
        if (!needKey()) return
        return send(res, 202, { queue_id: 'rimg-1', market: 'carpe', status: 'pending' }, { 'x-carpe-route-market': 'carpe' })
      case 'POST /router/images/retrieve':
        if (!needKey()) return
        return send(res, 200, PNG, { 'content-type': 'image/png' })

      case 'POST /v1/audio/speech':
      case 'POST /router/audio/speech':
        if (!needKey()) return
        if (p.startsWith('/router') && String(body.voice ?? '').startsWith('vv_')) return send(res, 400, { error: 'v1 only', code: 'VOICE_HANDLE_V1_ONLY' })
        return send(res, 200, MP3, { 'content-type': 'audio/mpeg', ...cost(200) })

      case 'POST /v1/video/quote':
        if (!needKey()) return
        if (body.duration === '7s') return send(res, 400, { error: 'This model does not accept these values', code: 'VIDEO_PARAM_REJECTED', details: { issues: [{ param: 'duration', value: '7s', accepted: ['5s', '10s'] }] } })
        return send(res, 200, { cost_usdc: body.model === 'pricey' ? 2.5 : 0.21, quote: 0.21, venice_quote_usd: 0.4, multiplier: 0.53 })
      case 'POST /v1/video/queue':
        if (!needKey()) return
        return send(res, 200, { model: body.model, queue_id: 'vid-1' }, cost(210000))
      case 'POST /router/video/generations':
        if (!needKey()) return
        return send(res, 200, { queue_id: 'rvid-1', market: 'surplus', status: 'queued' }, { 'x-carpe-route-market': 'surplus' })
      case 'POST /v1/video/retrieve':
        if (!needKey()) return
        if (bump('video-poll') < 2) return send(res, 200, { status: 'processing' })
        return send(res, 200, { status: 'completed', video_url: '/v1/video/file/abc123' })
      case 'POST /router/video/retrieve':
        if (!needKey()) return
        return send(res, 200, MP4, { 'content-type': 'video/mp4' })
      case 'GET /v1/video/file/abc123':
        return send(res, 200, MP4, { 'content-type': 'video/mp4' })

      case 'POST /v1/audio/music/queue':
        if (!needKey()) return
        return send(res, 200, { queue_id: 'mus-1' }, cost(16000))
      case 'POST /v1/audio/music/retrieve':
        if (!needKey()) return
        if (musicClaimed) return send(res, 404, { error: 'Not found', code: 'JOB_NOT_FOUND' })
        musicClaimed = true
        return send(res, 200, MP3, { 'content-type': 'audio/mpeg' })
    }
    send(res, 404, { error: `mock: no route ${req.method} ${p}`, code: 'NOT_FOUND' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    base: `${url}/api/operator`,
    calls,
    counters,
    x402,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
