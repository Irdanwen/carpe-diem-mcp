import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { TOOL_ANNOTATIONS } from '../src/tools/annotations.js'
import { CarpeClient } from '../src/carpe-client.js'
import { loadConfig } from '../src/config.js'
import { harness, type Harness } from './helpers/harness.js'
import { KEY, MP3, PNG, startMockCarpe, type MockCarpe } from './helpers/mock-carpe.js'

let mock: MockCarpe
before(async () => {
  mock = await startMockCarpe()
})
after(async () => {
  await mock.close()
})

const withKey = (env: Record<string, string> = {}) => harness(mock.base, { CARPE_API_KEY: KEY, ...env })
const lastCall = (pathPrefix: string) => [...mock.calls].reverse().find((c) => c.path.startsWith(pathPrefix))

describe('registration', () => {
  test('every tool has explicit annotations, and read-only mode hides spending tools', async () => {
    const h = await withKey()
    const { tools } = await h.client.listTools()
    assert.ok(tools.length >= 30)
    for (const t of tools) {
      assert.ok(TOOL_ANNOTATIONS[t.name], `missing annotations for ${t.name}`)
      for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) assert.equal(typeof t.annotations?.[k], 'boolean', `${t.name}.${k}`)
    }
    for (const name of Object.keys(TOOL_ANNOTATIONS)) assert.ok(tools.some((t) => t.name === name), `annotation for unknown tool ${name}`)
    await h.close()
    const ro = await withKey({ CARPE_READ_ONLY: '1' })
    const names = (await ro.client.listTools()).tools.map((t) => t.name)
    assert.ok(!names.includes('carpe_chat') && !names.includes('carpe_video_generate') && !names.includes('carpe_revoke_this_key'))
    assert.ok(names.includes('carpe_quote') && names.includes('carpe_balance'))
    await ro.close()
  })

  test('without a payment method, paid tools refuse before any network call', async () => {
    const h = await harness(mock.base)
    const before = mock.calls.length
    const r = await h.call('carpe_chat', { prompt: 'hi' })
    assert.equal(r.isError, true)
    assert.match(r.text, /NO_PAYMENT_METHOD/)
    assert.equal(mock.calls.length, before)
    await h.close()
  })
})

describe('two surfaces: /v1 vs /router', () => {
  test('chat on route carpe hits /v1, streams, reports cost from the usage chunk and tee: true', async () => {
    const h = await withKey()
    const r = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b' })
    assert.equal(r.isError, false, r.text)
    assert.equal(r.structured.content, 'Hello!')
    assert.equal(r.structured.cost.usd, 0.0015)
    assert.equal(r.structured.route.endpoint_prefix, '/v1')
    assert.equal(r.structured.route.tee, true)
    const c = lastCall('/v1/chat/completions')!
    assert.equal(c.body.stream, true)
    assert.equal(c.headers['idempotency-key'], undefined)
    assert.equal(h.built.guard.spentUsd, 0.0015)
    await h.close()
  })

  test('chat on route router hits /router, sends an Idempotency-Key and warns when served outside a TEE', async () => {
    const h = await withKey()
    const r = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', route: 'router' })
    assert.equal(r.isError, false, r.text)
    assert.equal(r.structured.route.surface, 'router')
    assert.equal(r.structured.route.route_used, 'openrouter')
    assert.equal(r.structured.route.tee, false)
    assert.match(r.structured.route.warning, /outside a TEE/)
    const c = lastCall('/router/chat/completions')!
    assert.match(String(c.headers['idempotency-key']), /^[0-9a-f-]{36}$/)
    await h.close()
  })

  test('router-only options are sent to /router and ignored (with a note) on /v1', async () => {
    const h = await withKey()
    await h.call('carpe_chat', { prompt: 'hi', route: 'router', privacy: true, provider: { sort: 'latency' } })
    const rc = lastCall('/router/chat/completions')!
    assert.equal(rc.body.privacy, true)
    assert.equal(rc.body.provider.sort, 'latency')
    assert.equal(rc.headers['idempotency-key'], undefined, 'no replay cache for private requests')
    const r = await h.call('carpe_chat', { prompt: 'hi', route: 'carpe', privacy: true })
    assert.equal(lastCall('/v1/chat/completions')!.body.privacy, undefined)
    assert.match(r.structured.notes[0], /privacy ignored/)
    await h.close()
  })

  test('CARPE_DEFAULT_ROUTE=router changes the default surface', async () => {
    const h = await withKey({ CARPE_DEFAULT_ROUTE: 'router' })
    const r = await h.call('carpe_chat', { prompt: 'hi' })
    assert.equal(r.structured.route.surface, 'router')
    await h.close()
  })

  test('streamed tool calls are reassembled', async () => {
    const h = await withKey()
    const r = await h.call('carpe_chat', { prompt: 'weather?', model: 'tooly', tools: [{ type: 'function', function: { name: 'weather' } }] })
    assert.equal(r.structured.tool_calls[0].function.name, 'get_weather')
    assert.equal(r.structured.tool_calls[0].function.arguments, '{"a":1}')
    assert.equal(r.structured.finish_reason, 'tool_calls')
    await h.close()
  })

  test('images: /v1 sync, /v1 queue for heavy models, /router OpenAI paths with queue fallback', async () => {
    const h = await withKey()
    const sync = await h.call('carpe_image_generate', { prompt: 'a cat' })
    assert.equal(sync.isError, false, sync.text)
    assert.equal(lastCall('/v1/image/')!.path, '/v1/image/generate')
    assert.ok(sync.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'))
    assert.ok(existsSync(sync.structured.images[0].file))

    const heavy = await h.call('carpe_image_generate', { prompt: 'a cat', model: 'gpt-image-2', wait_seconds: 30 })
    assert.equal(heavy.isError, true, 'refused: estimate 0.9 > per-call 0.5')
    assert.match(heavy.text, /SPEND_LIMIT_PER_CALL/)
    await h.close()

    const big = await withKey({ CARPE_MAX_PER_CALL_USD: '2' })
    const q = await big.call('carpe_image_generate', { prompt: 'a cat', model: 'gpt-image-2', wait_seconds: 30 })
    assert.equal(q.isError, false, q.text)
    assert.ok(mock.calls.some((c) => c.path === '/v1/image/generate/queue'))
    assert.ok(mock.calls.some((c) => c.path === '/v1/image/generate/retrieve'))
    assert.equal(q.structured.status, 'completed')
    assert.match(q.structured.job_id, /^v1:image:/)

    const r = await big.call('carpe_image_generate', { prompt: 'a cat', route: 'router', wait_seconds: 10 })
    assert.equal(r.isError, false, r.text)
    assert.ok(mock.calls.some((c) => c.path === '/router/images/generations'))
    assert.ok(mock.calls.some((c) => c.path === '/router/images/retrieve'))
    assert.match(r.structured.job_id, /^router:image:/)
    await big.close()
  })

  test('multi-edit and upscale never go to /router (no market arbitrates them)', async () => {
    const h = await withKey({ CARPE_DEFAULT_ROUTE: 'router' })
    const from = mock.calls.length
    // The mock has no multi-edit / upscale route: only the surface that was called matters here.
    await h.call('carpe_image_multi_edit', { prompt: 'merge', images: [`data:image/png;base64,${PNG.toString('base64')}`], wait_seconds: 0 })
    await h.call('carpe_image_upscale', { image: `data:image/png;base64,${PNG.toString('base64')}` })
    const paths = mock.calls.slice(from).map((c) => c.path)
    assert.ok(paths.includes('/v1/image/multi-edit/queue'), paths.join(','))
    assert.ok(paths.includes('/v1/image/upscale'), paths.join(','))
    assert.ok(!paths.some((p) => p.startsWith('/router/')), paths.join(','))
    await h.close()
  })

  test('tts: a cloned voice is forced onto /v1', async () => {
    const h = await withKey()
    const r = await h.call('carpe_tts', { input: 'bonjour', voice: 'vv_abc', route: 'router' })
    assert.equal(r.isError, false, r.text)
    assert.equal(lastCall('/v1/audio/speech')!.body.voice, 'vv_abc')
    assert.match(r.structured.notes[0], /Cloned voice/)
    assert.ok(r.content.some((c) => c.type === 'audio'))
    await h.close()
  })

  test('video: quote first, absolute file URL downloaded, job polled on its own surface', async () => {
    const h = await withKey()
    const refused = await h.call('carpe_video_generate', { model: 'pricey', prompt: 'x', duration: '5s' })
    assert.match(refused.text, /SPEND_LIMIT_PER_CALL/)
    assert.ok(!mock.calls.some((c) => c.path === '/v1/video/queue'), 'nothing queued after a refused quote')

    const bad = await h.call('carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'x', duration: '7s' })
    assert.match(bad.text, /VIDEO_PARAM_REJECTED/)
    assert.match(bad.text, /10s/)

    const q = await h.call('carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'a cat', duration: '5s' })
    assert.equal(q.isError, false, q.text)
    assert.match(q.structured.job_id, /^v1:video:vid-1:/)
    const s = await h.call('carpe_video_status', { job_id: q.structured.job_id, wait_seconds: 20 })
    assert.equal(s.isError, false, s.text)
    assert.equal(s.structured.status, 'completed')
    assert.equal(s.structured.remote_url, `${mock.base}/v1/video/file/abc123`)
    assert.ok(existsSync(s.structured.video.file))

    const rq = await h.call('carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'a cat', duration: '5s', route: 'router' })
    assert.match(rq.structured.job_id, /^router:video:/)
    assert.equal(rq.structured.route.route_used, 'surplus')
    const rs = await h.call('carpe_video_status', { job_id: rq.structured.job_id })
    assert.equal(rs.structured.status, 'completed')
    assert.ok(mock.calls.some((c) => c.path === '/router/video/retrieve'))
    await h.close()
  })

  test('music: a track that can be claimed once is always saved to disk', async () => {
    const h = await withKey()
    const q = await h.call('carpe_music_generate', { prompt: 'lofi' })
    assert.equal(q.isError, false, q.text)
    const s = await h.call('carpe_music_status', { job_id: q.structured.job_id })
    assert.equal(s.structured.status, 'completed')
    assert.deepEqual(readFileSync(s.structured.audio.file), MP3)
    await h.close()
  })
})

describe('account, quote, errors, retries', () => {
  test('balance merges credits, debt, prepaid and rail', async () => {
    const h = await withKey()
    const r = await h.call('carpe_balance')
    assert.equal(r.structured.credits.availableCredits, 1234)
    assert.equal(r.structured.debt.pendingCredits, 50)
    assert.equal(r.structured.rail.rail, 'auto')
    await h.close()
  })

  test('quote shows both surfaces', async () => {
    const h = await harness(mock.base)
    const r = await h.call('carpe_quote', { prompt: 'hello world', max_tokens: 100 })
    assert.equal(r.structured.surfaces.carpe.endpoint_prefix, '/v1')
    assert.equal(r.structured.surfaces.carpe.tee, true)
    assert.equal(r.structured.surfaces.router.best.market, 'openrouter')
    assert.equal(r.structured.surfaces.router.best.tee, false)
    await h.close()
  })

  test('errors carry actionable hints', async () => {
    const h = await withKey()
    const bad = await h.call('carpe_chat', { prompt: 'x', model: 'bad' })
    assert.equal(bad.isError, true)
    assert.equal(bad.structured.error.code, 'INVALID_MODEL')
    assert.match(bad.structured.error.hint, /carpe_list_models/)
    const poor = await h.call('carpe_chat', { prompt: 'x', model: 'poor' })
    assert.equal(poor.structured.error.code, 'PAYMENT_REQUIRED')
    assert.match(poor.structured.error.hint, /carpe_topup_link/)
    await h.close()
  })

  test('a capacity refusal is retried once; an ambiguous 502 on /v1 is never retried', async () => {
    const h = await withKey()
    const busy = await h.call('carpe_chat', { prompt: 'x', model: 'busy' })
    assert.equal(busy.isError, false, busy.text)
    assert.equal(mock.counters.busy, 2)
    const amb = await h.call('carpe_chat', { prompt: 'x', model: 'ambiguous' })
    assert.equal(amb.isError, true)
    assert.equal(mock.counters.ambiguous, 1, 'no blind retry of a paid call')
    await h.close()
  })

  test("a provider key's upstream spend limit (402 VENICE_ERROR) is retried once", async () => {
    const h = await withKey()
    const r = await h.call('carpe_web_search', { query: 'provider-limit' })
    assert.equal(r.isError, false, r.text)
    assert.equal(mock.counters['provider-limit'], 2)
    await h.close()
  })

  test('the session budget stops a looping agent', async () => {
    const h = await withKey({ CARPE_MAX_SPEND_USD: '0.003', CARPE_MAX_PER_CALL_USD: '0.002' })
    const first = await h.call('carpe_chat', { prompt: 'x', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.equal(first.isError, false, first.text)
    const second = await h.call('carpe_chat', { prompt: 'x', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.equal(second.isError, false, second.text)
    const third = await h.call('carpe_chat', { prompt: 'x', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.equal(third.isError, true)
    assert.match(third.text, /SPEND_LIMIT_SESSION/)
    const spend = await h.call('carpe_session_spend')
    assert.equal(spend.structured.by_tool.carpe_chat.calls, 2)
    await h.close()
  })

  test('redirects are refused and never followed with credentials', async () => {
    const cfg = loadConfig({ CARPE_TEST_BASE_URL: mock.base, CARPE_API_KEY: KEY })
    const client = new CarpeClient(cfg)
    await assert.rejects(client.request({ path: '/redirect', auth: 'account', retry: 'none' }), /REDIRECT|redirect/)
  })

  test('the API key never appears in tool output', async () => {
    const h = await withKey()
    for (const [n, a] of [['carpe_chat', { prompt: 'x', model: 'bad' }], ['carpe_balance', {}], ['carpe_status', {}]] as const) {
      const r = await h.call(n, a as any)
      assert.ok(!JSON.stringify(r).includes(KEY.slice(4)), `${n} leaked the key`)
    }
    await h.close()
  })

  test('forged job ids never reach the operator', async () => {
    const h = await withKey()
    const from = mock.calls.length
    for (const job_id of ['v1:image:x:..%2F..%2Fadmin', 'v1:image:q1:..%2Fadmin', 'v1:image:..:generate', 'v1:image:q%2F1:generate', 'router:video:a%3Fb=1:', 'v1:image:q1:complete']) {
      const r = await h.call(job_id.includes('video') ? 'carpe_video_status' : 'carpe_image_status', { job_id, wait_seconds: 0 })
      assert.match(r.text, /BAD_JOB_ID/, job_id)
    }
    assert.equal(mock.calls.length, from)
    await h.close()
  })

  test('concurrent paid calls reserve their estimate: the session limit holds under parallelism', async () => {
    const h = await withKey({ CARPE_MAX_SPEND_USD: '0.012', CARPE_MAX_PER_CALL_USD: '0.01' })
    const rs = await Promise.all([1, 2, 3, 4].map(() => h.call('carpe_image_generate', { prompt: 'x', model: 'z-image-turbo', mode: 'sync' })))
    const okCount = rs.filter((r) => !r.isError).length
    assert.equal(okCount, 2, rs.map((r) => r.text.slice(0, 60)).join(' | '))
    assert.ok(h.built.guard.spentUsd <= 0.012)
    await h.close()
  })

  test('remote downloads are capped while streaming', async () => {
    const { fetchBounded } = await import('../src/media.js')
    await assert.rejects(fetchBounded(new URL(`${mock.base}/big`), 1024 * 1024, false), /MEDIA_TOO_LARGE|above/)
    const ok = await fetchBounded(new URL(`${mock.base}/big`), 4 * 1024 * 1024, false)
    assert.equal(ok.bytes.length, 40 * 64 * 1024)
    await assert.rejects(fetchBounded(new URL(`${mock.base}/big`), 4 * 1024 * 1024, true), /private|loopback/i)
  })

  test('HTTP mode refuses local files and private hosts', async () => {
    const h = await harness(mock.base, { CARPE_API_KEY: KEY }, { allowLocalFiles: false })
    const f = join(h.outDir, 'x.png')
    writeFileSync(f, PNG)
    const local = await h.call('carpe_image_edit', { prompt: 'x', image: f })
    assert.match(local.text, /LOCAL_FILES_DISABLED/)
    const priv = await h.call('carpe_image_edit', { prompt: 'x', image: 'http://127.0.0.1:1/x.png' })
    assert.match(priv.text, /URL_REFUSED/)
    await h.close()
  })
})

describe('x402 carpe-session', () => {
  const pk = generatePrivateKey()
  const env = { CARPE_X402_PRIVATE_KEY: pk, CARPE_X402_BUDGET_USD: '0.10' }
  const deps = { readNonce: async () => 0n, readUsdcBalance: async () => 5_000_000n }

  test('challenge → one signed permit (value = budget) → reused; price billed from X-Payment-Amount-Usdc', async () => {
    mock.x402.billedMicros = 0
    const h = await harness(mock.base, env, { x402Deps: deps })
    const r1 = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.equal(r1.isError, false, r1.text)
    assert.equal(r1.structured.content, 'Paid hello')
    assert.equal(r1.structured.cost.source, 'x402')
    assert.equal(mock.x402.payer, privateKeyToAccount(pk).address)
    const paidCalls = mock.calls.filter((c) => c.path === '/v1/x402/chat/completions')
    assert.equal(paidCalls.length, 2, 'unpaid probe + paid request')
    const r2 = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.equal(r2.isError, false)
    assert.equal(mock.calls.filter((c) => c.path === '/v1/x402/chat/completions').length, 3, 'cached permit: no second probe')
    const permit = JSON.parse(Buffer.from(String(lastCall('/v1/x402/chat/completions')!.headers['x-payment']), 'base64').toString())
    assert.equal(permit.payload.value, '100000')
    const st = await h.call('carpe_x402_status')
    assert.equal(st.structured.billed_usd, 0.000522)
    assert.equal(st.structured.usdc_balance, '5.000000')
    const routed = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10, route: 'router' })
    assert.equal(routed.isError, false)
    assert.ok(mock.calls.some((c) => c.path === '/router/x402/chat/completions'))
    await h.close()
  })

  test('a challenge naming another payee or asset is never signed', async () => {
    mock.x402.challengeOverride = { payTo: '0x000000000000000000000000000000000000dEaD' }
    const h = await harness(mock.base, env, { x402Deps: deps })
    const r = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.match(r.text, /X402_UNEXPECTED_PAYEE/)
    mock.x402.challengeOverride = { asset: '0x000000000000000000000000000000000000bEEF' }
    const r2 = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.match(r2.text, /X402_UNEXPECTED_ASSET/)
    mock.x402.challengeOverride = undefined
    await h.close()
  })

  test('a price above the remaining budget is refused before signing', async () => {
    mock.x402.pricedMicros = 200_000
    const h = await harness(mock.base, env, { x402Deps: deps })
    const r = await h.call('carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b', max_tokens: 10 })
    assert.match(r.text, /X402_BUDGET_EXHAUSTED/)
    mock.x402.pricedMicros = 261
    await h.close()
  })

  test('account tools explain they need an API key; the private key never leaks', async () => {
    const h = await harness(mock.base, env, { x402Deps: deps })
    const r = await h.call('carpe_balance')
    assert.match(r.text, /API_KEY_REQUIRED/)
    const st = await h.call('carpe_x402_status')
    assert.ok(!JSON.stringify(st).includes(pk.slice(2)))
    await h.close()
  })
})

test('package: the built CLI exists and declares a shebang', () => {
  const cli = join(fileURLToPath(new URL('..', import.meta.url)), 'dist', 'cli.js')
  assert.ok(existsSync(cli), 'run npm run build first')
  assert.match(readFileSync(cli, 'utf8'), /^#!\/usr\/bin\/env node/)
})
