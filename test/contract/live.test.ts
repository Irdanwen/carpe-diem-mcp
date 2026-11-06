/**
 * Contract test against the LIVE operator. Free: only public endpoints and
 * unpaid x402 challenges. Catches API or catalogue drift on Carpe's side.
 *   npm run test:contract
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CarpeClient } from '../../src/carpe-client.js'
import { loadConfig } from '../../src/config.js'
import { CarpeError } from '../../src/errors.js'
import { X402Session, type X402Accept } from '../../src/x402/session.js'

const cfg = loadConfig({ CARPE_TEST_BASE_URL: process.env.CARPE_CONTRACT_BASE_URL })
const client = new CarpeClient(cfg)

const DEFAULT_MODELS = ['deepseek-v4-flash', 'text-embedding-bge-m3', 'z-image-turbo', 'qwen-image-2-edit', 'flux-2-max-edit', 'upscaler', 'tts-kokoro', 'tts-chatterbox-hd', 'openai/whisper-large-v3', 'ace-step-15']

test('catalogue: shape and every default model of this server exists', async () => {
  const { data } = (await client.request({ path: '/v1/models', auth: 'none' })).json<{ data: { id: string; carpe_diem_type?: string }[] }>()
  assert.ok(data.length > 50)
  for (const m of data.slice(0, 20)) assert.equal(typeof m.carpe_diem_type, 'string', m.id)
  const ids = new Set(data.map((m) => m.id))
  const missing = DEFAULT_MODELS.filter((m) => !ids.has(m))
  assert.deepEqual(missing, [], `default models missing from the live catalogue: ${missing.join(', ')}`)
})

test('/router/models adds carpe_router.markets to text models', async () => {
  const { data } = (await client.request({ path: '/router/models', auth: 'none' })).json<{ data: { carpe_diem_type?: string; carpe_router?: { markets: string[] } }[] }>()
  const text = data.filter((m) => m.carpe_diem_type === 'text')
  assert.ok(text.some((m) => Array.isArray(m.carpe_router?.markets) && m.carpe_router!.markets[0] === 'carpe'))
})

test('pricing and quote shapes', async () => {
  const p = (await client.request({ path: '/pricing', auth: 'none' })).json<{ models: unknown[]; fixedCost: { model: string; costUsd: number }[] }>()
  assert.ok(p.models.length > 50 && p.fixedCost.some((f) => f.model === 'augment-search'))
  const q = (await client.request({ method: 'POST', path: '/router/quote', auth: 'none', json: { model: 'llama-3.3-70b', input_tokens: 100, max_tokens: 100 } })).json<Record<string, any>>()
  assert.equal(typeof q.carpeCostUsd, 'number')
  assert.ok(Array.isArray(q.candidates) && q.candidates.some((c: any) => c.market === 'carpe'))
  const m = (await client.request({ path: '/router/markets', auth: 'none' })).json<Record<string, any>>()
  assert.ok(Array.isArray(m.markets) && m.markets.includes('carpe'))
  assert.equal(typeof m.externalFeePct, 'number')
})

test('x402: live challenges validate against the pinned USDC and escrow', async () => {
  const session = new X402Session({ ...cfg, x402PrivateKey: ('0x' + '22'.repeat(32)) as `0x${string}`, x402BudgetUsd: 1 }, { stateDir: null })
  for (const path of ['/v1/x402/chat/completions', '/router/x402/chat/completions']) {
    try {
      await client.request({ method: 'POST', path, auth: 'none', retry: 'none', json: { model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 } })
      assert.fail('expected a 402 challenge')
    } catch (err) {
      assert.ok(err instanceof CarpeError && err.code === 'X402_PAYMENT_REQUIRED', String(err))
      const accepts = (err.details as { accepts: X402Accept[] }).accepts
      const acc = accepts.find((a) => a.scheme === 'carpe-session')
      assert.ok(acc, `${path}: no carpe-session accept`)
      session.validateAccept(acc)
      assert.ok(Number(acc.maxAmountRequired) > 0)
    }
  }
})

test('errors: unknown model and missing auth come back normalised', async () => {
  await assert.rejects(
    client.request({ method: 'POST', path: '/v1/x402/chat/completions', auth: 'none', retry: 'none', json: { model: 'no-such-model-xyz', messages: [] } }),
    (e: unknown) => e instanceof CarpeError && e.code === 'INVALID_MODEL',
  )
  await assert.rejects(client.request({ path: '/v1/credits', auth: 'optional', retry: 'none' }), (e: unknown) => e instanceof CarpeError && e.code === 'AUTH_REQUIRED')
})
