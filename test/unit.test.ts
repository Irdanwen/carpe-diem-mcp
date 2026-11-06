import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, loadConfig, paymentMode } from '../src/config.js'
import { errorFromBody } from '../src/errors.js'
import { aggregateChatStream } from '../src/sse.js'
import { estimateInputTokens, SpendGuard } from '../src/spend-guard.js'
import { decodeJob, encodeJob, routeInfo } from '../src/tools/context.js'
import { sniffMime } from '../src/media.js'
import { parseMeta } from '../src/carpe-client.js'
import { isAuthorized, isLoopbackHost, validateHttpConfig } from '../src/transports/http.js'
import { KEY, MP3, MP4, PNG } from './helpers/mock-carpe.js'

test('config: defaults, API key wins, x402 needs a budget ≥ 0.10', () => {
  const d = loadConfig({})
  assert.equal(d.baseUrl, 'https://carpe-diem.xyz/api/operator')
  assert.equal(d.defaultRoute, 'carpe')
  assert.equal(paymentMode(d), 'none')
  assert.equal(paymentMode(loadConfig({ CARPE_API_KEY: KEY })), 'api_key')
  const pk = '0x' + '11'.repeat(32)
  assert.throws(() => loadConfig({ CARPE_X402_PRIVATE_KEY: pk }), ConfigError)
  assert.throws(() => loadConfig({ CARPE_X402_PRIVATE_KEY: pk, CARPE_X402_BUDGET_USD: '0.05' }), ConfigError)
  assert.equal(paymentMode(loadConfig({ CARPE_X402_PRIVATE_KEY: pk, CARPE_X402_BUDGET_USD: '1' })), 'x402')
  assert.equal(paymentMode(loadConfig({ CARPE_API_KEY: KEY, CARPE_X402_PRIVATE_KEY: pk })), 'api_key')
  assert.throws(() => loadConfig({ CARPE_API_KEY: 'sk-nope' }), ConfigError)
  assert.throws(() => loadConfig({ CARPE_DEFAULT_ROUTE: 'v1' }), ConfigError)
})

test('errors: every operator error shape is normalised', () => {
  const carpe = errorFromBody(402, { error: 'Payment rail cannot cover this request', code: 'PAYMENT_REQUIRED', tried: ['credits'], minRequired: '0.01' })
  assert.equal(carpe.code, 'PAYMENT_REQUIRED')
  assert.match(carpe.hint ?? '', /carpe_topup_link/)
  assert.deepEqual((carpe.details as any).minRequired, '0.01')
  assert.equal(carpe.notExecuted, true)

  const openai = errorFromBody(400, { error: { message: 'Unknown model', type: 'invalid_request_error', code: 'INVALID_MODEL' }, code: 'INVALID_MODEL' })
  assert.equal(openai.code, 'INVALID_MODEL')
  assert.equal(openai.message, 'Unknown model')

  const anthropic = errorFromBody(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } })
  assert.equal(anthropic.code, 'invalid_request_error')

  const fastify = errorFromBody(400, { statusCode: 400, code: 'FST_ERR_VALIDATION', error: 'Bad Request', message: 'body/model must be string' })
  assert.equal(fastify.message, 'body/model must be string')

  const geo = errorFromBody(451, { error: 'Unavailable For Legal Reasons', message: 'region' })
  assert.equal(geo.code, 'GEO_RESTRICTED')

  const x = errorFromBody(402, { x402Version: 1, error: 'X-PAYMENT header required', accepts: [{}] })
  assert.equal(x.code, 'X402_PAYMENT_REQUIRED')

  const h = new Headers({ 'retry-after': '3' })
  assert.equal(errorFromBody(429, { error: 'slow down', code: 'RATE_LIMITED' }, h).retryAfterMs, 3000)
  assert.equal(errorFromBody(502, { error: 'x', code: 'VENICE_ERROR' }).notExecuted, false)
})

test('meta: cost headers by precedence (x402 > router > carpe)', () => {
  assert.equal(parseMeta(200, new Headers({ 'x-carpe-cost-usdc-micro': '1500' })).costUsd, 0.0015)
  const r = parseMeta(200, new Headers({ 'x-carpe-cost-usdc-micro': '1500', 'x-carpe-route-cost-usdc': '0.0007', 'x-carpe-route-market': 'chutes' }))
  assert.equal(r.costUsd, 0.0007)
  assert.equal(r.costSource, 'router')
  assert.equal(parseMeta(200, new Headers({ 'x-payment-amount-usdc': '0.000261' })).costSource, 'x402')
})

test('route info: /v1 is TEE; router reports the market and warns outside a TEE', () => {
  assert.deepEqual(routeInfo('carpe', undefined), { surface: 'carpe', endpoint_prefix: '/v1', route_used: 'carpe', tee: true })
  const r = routeInfo('router', { status: 200, routeMarket: 'openrouter' })
  assert.equal(r.tee, false)
  assert.match(String(r.warning), /outside a TEE/)
  assert.equal(routeInfo('router', { status: 200, routeMarket: 'openrouter' }, true).warning, undefined)
  assert.equal(routeInfo('router', { status: 200, routeMarket: 'chutes' }).tee, true)
})

test('job ids carry their surface and refuse foreign handles', () => {
  const h = encodeJob('router', 'video', 'q:1/2', 'kling')
  assert.deepEqual(decodeJob(h, 'video'), { surface: 'router', queueId: 'q:1/2', model: 'kling' })
  assert.throws(() => decodeJob(h, 'music'))
  assert.throws(() => decodeJob('q-123', 'video'))
})

test('spend guard: per-call and session limits, unknown costs', () => {
  const cfg = loadConfig({ CARPE_MAX_SPEND_USD: '1', CARPE_MAX_PER_CALL_USD: '0.5' })
  const g = new SpendGuard(cfg)
  assert.throws(() => g.check('t', 0.6), /per-call/)
  g.check('t', 0.4)
  g.record('t', { status: 200, costUsd: 0.4 })
  g.record('t', { status: 200, costUsd: 0.3 })
  assert.throws(() => g.check('t', 0.31), /session budget/)
  assert.throws(() => g.check('t', undefined), /cannot be estimated/)
  const unlimited = new SpendGuard(loadConfig({ CARPE_MAX_SPEND_USD: '0', CARPE_MAX_PER_CALL_USD: '0' }))
  unlimited.check('t', 1000)
})

test('token estimate counts text and images', () => {
  assert.ok(estimateInputTokens('a'.repeat(400)) >= 100)
  assert.ok(estimateInputTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]) >= 1000)
})

test('sse aggregation: content, tool calls, Carpe usage cost, router comment, in-stream error', async () => {
  const stream = (lines: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(l))
        c.close()
      },
    })
  const a = await aggregateChatStream(
    stream([
      ': carpe-route market=antseed reason="slow start" attempts=antseed:ok\n\n',
      'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"He"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"y","tool_calls":[{"index":0,"id":"t","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n',
      '\ndata: {"choices":[],"usage":{"prompt_tokens":1,"carpe_cost_usdc_micro":250}}\n\ndata: [DONE]\n\n',
    ]),
    1e6,
  )
  const msg = (a.completion.choices as any)[0].message
  assert.equal(msg.content, 'Hey')
  assert.equal(msg.tool_calls[0].function.name, 'f')
  assert.equal(a.costUsd, 0.00025)
  assert.equal(a.route?.market, 'antseed')
  await assert.rejects(aggregateChatStream(stream(['data: {"error":{"message":"no market","code":"NO_MARKET"}}\n\n', 'data: [DONE]\n\n']), 1e6), /no market/)
  await assert.rejects(aggregateChatStream(stream(['data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n']), 1e6), /ended before completion/)
})

test('mime sniffing', () => {
  assert.equal(sniffMime(PNG), 'image/png')
  assert.equal(sniffMime(MP3), 'audio/mpeg')
  assert.equal(sniffMime(MP4), 'video/mp4')
})

test('http transport: loopback only without a token; bearer compared in constant time', () => {
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && isLoopbackHost('localhost'))
  assert.ok(!isLoopbackHost('0.0.0.0'))
  validateHttpConfig('127.0.0.1', undefined, false)
  assert.throws(() => validateHttpConfig('0.0.0.0', undefined, false))
  assert.throws(() => validateHttpConfig('0.0.0.0', 'short', false))
  validateHttpConfig('0.0.0.0', 'x'.repeat(16), false)
  assert.ok(isAuthorized('Bearer ' + 'x'.repeat(16), 'x'.repeat(16)))
  assert.ok(!isAuthorized('Bearer nope', 'x'.repeat(16)))
  assert.ok(!isAuthorized(undefined, 'x'.repeat(16)))
})
