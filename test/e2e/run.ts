/**
 * Real end-to-end run against production, through the built stdio server.
 * SPENDS REAL CREDITS (a few cents; hard-capped by CARPE_MAX_SPEND_USD=0.90).
 *
 *   CARPE_API_KEY=cdm_… npm run test:e2e            # all tiers
 *   CARPE_E2E_TIERS=free,cheap npm run test:e2e     # subset
 *
 * The key is read from the environment or from ./.env.local (CARPE_API_KEY=…).
 */
import { existsSync, readFileSync } from 'node:fs'
import { connect, call, type CallOutcome } from './client.js'

function keyFromEnvFile(): string | undefined {
  if (!existsSync('.env.local')) return undefined
  const m = /^CARPE_API_KEY=["']?([^"'\s]+)/m.exec(readFileSync('.env.local', 'utf8'))
  return m?.[1]
}

const key = process.env.CARPE_API_KEY ?? keyFromEnvFile()
if (!key) {
  console.error('Set CARPE_API_KEY (or put CARPE_API_KEY=cdm_… in .env.local).')
  process.exit(2)
}
const tiers = new Set((process.env.CARPE_E2E_TIERS ?? 'free,cheap,media,async').split(','))
const outDir = process.env.CARPE_OUTPUT_DIR ?? `${process.cwd()}/out/e2e`

const client = await connect({ CARPE_API_KEY: key, CARPE_MAX_SPEND_USD: '0.90', CARPE_MAX_PER_CALL_USD: '0.40', CARPE_OUTPUT_DIR: outDir })
const results: { tool: string; label: string; ok: boolean; usd: number | null; route?: string; note?: string }[] = []

async function step(label: string, tool: string, args: Record<string, unknown>, check?: (r: CallOutcome) => string | void): Promise<CallOutcome> {
  const t0 = Date.now()
  const r = await call(client, tool, args)
  let note = r.isError ? r.text.slice(0, 300) : undefined
  if (!r.isError && check) note = check(r) ?? undefined
  const ok = !r.isError && !note
  const usd = r.structured?.cost?.usd ?? null
  const route = r.structured?.route ? `${r.structured.route.endpoint_prefix}→${r.structured.route.route_used}${r.structured.route.tee === false ? ' (no TEE)' : ''}` : undefined
  results.push({ tool, label, ok, usd, route, note })
  console.log(`${ok ? '✔' : '✘'} ${label.padEnd(34)} ${usd !== null ? `$${Number(usd).toFixed(6)}` : '        -'}  ${route ?? ''}  ${((Date.now() - t0) / 1000).toFixed(1)}s${note ? `\n    ${note}` : ''}`)
  return r
}

if (tiers.has('free')) {
  await step('catalogue', 'carpe_list_models', { type: 'text', limit: 5 }, (r) => (r.structured.total > 10 ? undefined : 'too few models'))
  await step('router catalogue', 'carpe_list_models', { type: 'text', limit: 5, route: 'router' })
  await step('quote', 'carpe_quote', { model: 'llama-3.3-70b', prompt: 'Say hi', max_tokens: 20 })
  await step('balance', 'carpe_balance', {}, (r) => (r.structured.credits ? undefined : 'no credits block'))
  await step('rate limits', 'carpe_rate_limits', {})
  await step('usage history', 'carpe_usage_history', { limit: 3 })
}

let speechFile: string | undefined
let imageFile: string | undefined
if (tiers.has('cheap')) {
  await step('chat /v1', 'carpe_chat', { prompt: 'Reply with exactly: pong', model: 'llama-3.3-70b', max_tokens: 10, route: 'carpe' }, (r) =>
    r.structured.route.tee === true && /pong/i.test(String(r.structured.content)) ? undefined : `unexpected: ${JSON.stringify(r.structured.content)}`,
  )
  await step('chat /router', 'carpe_chat', { prompt: 'Reply with exactly: pong', model: 'llama-3.3-70b', max_tokens: 10, route: 'router' }, (r) =>
    r.structured.route.surface === 'router' ? undefined : 'not routed',
  )
  await step('chat /router privacy:true', 'carpe_chat', { prompt: 'Reply with exactly: pong', model: 'llama-3.3-70b', max_tokens: 10, route: 'router', privacy: true }, (r) =>
    r.structured.route.tee === false ? 'privacy:true served outside a TEE' : undefined,
  )
  await step('chat tool call', 'carpe_chat', {
    prompt: 'What is the weather in Paris? Use the tool.',
    model: 'llama-3.3-70b',
    max_tokens: 100,
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
  }, (r) => (r.structured.tool_calls?.[0]?.function?.name === 'get_weather' ? undefined : 'no tool call'))
  await step('embeddings /v1', 'carpe_embeddings', { input: ['hello', 'world'], route: 'carpe' }, (r) => (r.structured.count === 2 ? undefined : 'wrong count'))
  await step('embeddings /router', 'carpe_embeddings', { input: 'hello', route: 'router' })
  await step('web search', 'carpe_web_search', { query: 'Base L2 USDC' })
  const tts = await step('tts /v1', 'carpe_tts', { input: 'Bonjour, ceci est un test de Carpe Diem.', model: 'tts-kokoro', route: 'carpe' })
  speechFile = tts.structured?.audio?.file
  await step('tts /router', 'carpe_tts', { input: 'Hello from the router.', model: 'tts-kokoro', route: 'router' })
  const img = await step('image /v1 (z-image-turbo)', 'carpe_image_generate', { prompt: 'a small red fox, flat illustration', model: 'z-image-turbo', route: 'carpe', format: 'png' })
  imageFile = img.structured?.images?.[0]?.file
  await step('image /router', 'carpe_image_generate', { prompt: 'a small blue bird, flat illustration', model: 'z-image-turbo', route: 'router' })
}

if (tiers.has('media')) {
  if (speechFile) await step('transcribe (tts output)', 'carpe_transcribe', { audio: speechFile, route: 'carpe' }, (r) => (/carpe|test|bonjour/i.test(r.text) ? undefined : `transcript: ${r.text.slice(0, 80)}`))
  if (imageFile) {
    await step('image edit', 'carpe_image_edit', { prompt: 'make the fox blue', image: imageFile, model: 'qwen-image-2-1-turbo-edit', wait_seconds: 180 })
    await step('upscale', 'carpe_image_upscale', { image: imageFile, scale: 2 })
  }
}

if (tiers.has('async')) {
  const music = await step('music queue', 'carpe_music_generate', { prompt: 'calm lo-fi piano loop', model: 'ace-step-15', duration_seconds: 60 })
  if (music.structured?.job_id) await step('music status', 'carpe_music_status', { job_id: music.structured.job_id, wait_seconds: 300 }, (r) => (r.structured.status === 'completed' ? undefined : `status ${r.structured.status}`))
  const model = process.env.CARPE_E2E_VIDEO_MODEL ?? 'grok-imagine-1-5-lite-text-to-video'
  const video = await step(`video queue (${model})`, 'carpe_video_generate', { model, prompt: 'a paper boat on a calm lake', duration: process.env.CARPE_E2E_VIDEO_DURATION ?? '1s' })
  if (video.structured?.job_id) await step('video status', 'carpe_video_status', { job_id: video.structured.job_id, wait_seconds: 600 }, (r) => (r.structured.status === 'completed' ? undefined : `status ${r.structured.status}`))
}

const spend = await call(client, 'carpe_session_spend')
const history = await call(client, 'carpe_usage_history', { limit: 30 })
await client.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed — session spend $${spend.structured.spent_usd} (limit $${spend.structured.session_limit_usd})`)
console.log(`Operator usage history shows ${history.structured.events?.length ?? '?'} recent events (compare with the costs above).`)
process.exit(failed.length ? 1 : 0)
