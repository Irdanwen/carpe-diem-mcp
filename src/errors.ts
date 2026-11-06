/**
 * One error type for every failure shape the operator produces, with a hint an
 * agent can act on. Shapes handled (all observed in the operator source):
 *   - Carpe:     { error: "<msg>", code: "<CODE>", retry_after_ms?, ... }
 *   - OpenAI:    { error: { message, type, code, param }, code }   (chat routes)
 *   - Anthropic: { type: "error", error: { type, message } }       (/messages)
 *   - Fastify:   { statusCode, code: "FST_ERR_VALIDATION", error, message }
 *   - 451 geo:   { error, message }                                 (no code)
 *   - 402 rail:  { error, code: "PAYMENT_REQUIRED", tried, minRequired }
 *   - 402 x402:  { x402Version, error, accepts: [...] }
 *   - job:       200 { status: "failed", queue_id, error, code, details? }
 */

export interface CarpeErrorInit {
  status: number
  code: string
  message: string
  retryAfterMs?: number
  details?: unknown
  hint?: string
  /** True when the operator certainly did not execute (nor bill) the request. */
  notExecuted?: boolean
}

export class CarpeError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | undefined
  readonly details: unknown
  readonly hint: string | undefined
  readonly notExecuted: boolean

  constructor(init: CarpeErrorInit) {
    super(init.message)
    this.name = 'CarpeError'
    this.status = init.status
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs
    this.details = init.details
    this.hint = init.hint ?? hintFor(init.code, init.status, init.details)
    this.notExecuted = init.notExecuted ?? false
  }

  toJSON(): Record<string, unknown> {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      ...(this.retryAfterMs !== undefined ? { retry_after_ms: this.retryAfterMs } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    }
  }
}

/** Local refusals (spend guard, read-only mode, bad input): never reached the operator. */
export class LocalRefusal extends CarpeError {
  constructor(code: string, message: string, hint?: string) {
    super({ status: 0, code, message, hint, notExecuted: true })
    this.name = 'LocalRefusal'
  }
}

type Json = Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** Build a CarpeError from a non-2xx response (or a 200 failed-job envelope). */
export function errorFromBody(status: number, body: unknown, headers?: Headers): CarpeError {
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after'))
  if (body === null || typeof body !== 'object') {
    const text = typeof body === 'string' ? body.slice(0, 500).trim() : ''
    return new CarpeError({
      status,
      code: status === 451 ? 'GEO_RESTRICTED' : `HTTP_${status}`,
      message: text || `Carpe Diem answered HTTP ${status}`,
      retryAfterMs,
      notExecuted: status === 429 || status === 451,
    })
  }
  const b = body as Json
  let code: string | undefined
  let message: string | undefined
  let details: unknown

  if (Array.isArray(b.accepts) && b.x402Version !== undefined) {
    // An x402 payment challenge reaching the caller means no usable payment was sent.
    return new CarpeError({
      status,
      code: 'X402_PAYMENT_REQUIRED',
      message: str(b.error) ?? 'x402 payment required',
      details: { accepts: b.accepts },
      notExecuted: true,
    })
  }

  if (b.error && typeof b.error === 'object') {
    // OpenAI { error: { message, type, code } } or Anthropic { type:"error", error:{ type, message } }
    const e = b.error as Json
    message = str(e.message)
    code = str(b.code) ?? str(e.code) ?? str(e.type)
  } else {
    message = str(b.error) ?? str(b.message)
    code = str(b.code)
    if (code === 'FST_ERR_VALIDATION') message = str(b.message) ?? message
  }
  if (status === 451) code = code ?? 'GEO_RESTRICTED'
  if (b.details !== undefined) details = b.details
  const extra: Json = {}
  for (const k of ['tried', 'minRequired', 'market', 'why', 'attemptsLeft', 'model', 'consent', 'consent_flow', 'face_media_roles', 'expectedAccount']) {
    if (b[k] !== undefined) extra[k] = b[k]
  }
  if (Object.keys(extra).length) details = details === undefined ? extra : { ...extra, details }

  const bodyRetry = typeof b.retry_after_ms === 'number' ? b.retry_after_ms : undefined
  const resolvedCode = code ?? `HTTP_${status}`
  return new CarpeError({
    status,
    code: resolvedCode,
    message: message ?? `Carpe Diem answered HTTP ${status}`,
    retryAfterMs: bodyRetry ?? retryAfterMs,
    details,
    notExecuted: status === 429 || status === 451 || status === 401 || status === 402 || status === 403 || NOT_EXECUTED_CODES.has(resolvedCode),
  })
}

/** Codes the operator returns before holding, serving or billing anything. */
const NOT_EXECUTED_CODES = new Set([
  'RATE_LIMITED', 'ENDPOINT_RATE_LIMITED', 'WALLET_LANES_SATURATED', 'MODEL_INFRA_SATURATED',
  'NO_PROVIDERS', 'NO_PROVIDER_CAPACITY', 'INSUFFICIENT_PROVIDER_CAPACITY', 'TEE_NOT_READY',
  'BALANCE_CHECK_FAILED', 'PRICE_UNAVAILABLE', 'QUEUE_FULL', 'IDEMPOTENCY_IN_FLIGHT',
  'INVALID_MODEL', 'BAD_REQUEST', 'FST_ERR_VALIDATION', 'VIDEO_PARAM_REJECTED', 'MUSIC_PARAM_REJECTED',
  'PIN_UNDELIVERABLE', 'MAX_PRICE_EXCEEDED', 'DATA_COLLECTION_NO_MARKET', 'PRIVATE_MODEL_NO_MARKET',
  'X402_INVALID', 'X402_UNSUPPORTED_SCHEME', 'X402_UNPAID_BALANCE', 'X402_PREFLIGHT_FAILED',
])

/** Transient codes worth a retry when the request is known not to have run. */
export const RETRYABLE_CODES = new Set([
  'RATE_LIMITED', 'ENDPOINT_RATE_LIMITED', 'UPSTREAM_RATE_LIMIT', 'WALLET_LANES_SATURATED',
  'MODEL_INFRA_SATURATED', 'NO_PROVIDERS', 'NO_PROVIDER_CAPACITY', 'INSUFFICIENT_PROVIDER_CAPACITY',
  'TEE_NOT_READY', 'BALANCE_CHECK_FAILED', 'PRICE_UNAVAILABLE', 'QUEUE_FULL', 'IDEMPOTENCY_IN_FLIGHT',
  'NO_MARKET',
])

function hintFor(code: string, status: number, details: unknown): string | undefined {
  const d = (details ?? {}) as Json
  switch (code) {
    case 'PAYMENT_REQUIRED':
    case 'insufficient_quota':
      return `The account balance cannot pay for this request${d.minRequired ? ` (needs at least $${d.minRequired})` : ''}. Check carpe_balance, then top up with carpe_topup_link (a card checkout URL for a human to open).`
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
      return 'The API key is missing, revoked or invalid. Set CARPE_API_KEY to a valid cdm_ key (create one on carpe-diem.xyz → Build → API keys).'
    case 'INVALID_MODEL':
      return 'Unknown model id. List valid ids with carpe_list_models (filter by type) — ids change as Venice updates its catalogue.'
    case 'VIDEO_PARAM_REJECTED':
    case 'MUSIC_PARAM_REJECTED':
      return 'A parameter is outside what this model accepts; details.issues lists each refused field with its accepted values. carpe_model_details shows the model constraints.'
    case 'GEO_RESTRICTED':
      return 'Carpe Diem refuses requests from this region (sanctioned countries). Run the MCP server from an allowed region.'
    case 'OFAC_BLOCKED':
      return 'This wallet is blocked by the operator sanctions screening.'
    case 'EDGE_REQUIRED':
      return 'The operator only answers through https://carpe-diem.xyz/api/operator — do not call the TEE gateway directly.'
    case 'RATE_LIMITED':
    case 'ENDPOINT_RATE_LIMITED':
    case 'UPSTREAM_RATE_LIMIT':
    case 'WALLET_LANES_SATURATED':
      return 'Rate limited. Wait for retry_after_ms, run fewer requests in parallel, or check carpe_rate_limits.'
    case 'MODEL_INFRA_SATURATED':
    case 'NO_PROVIDERS':
    case 'NO_PROVIDER_CAPACITY':
    case 'INSUFFICIENT_PROVIDER_CAPACITY':
    case 'NO_MARKET':
      return 'No capacity for this model right now. Retry later, pick another model, or try route "router" (best-price markets) for text models.'
    case 'PRIVATE_MODEL_NO_MARKET':
    case 'DATA_COLLECTION_NO_MARKET':
      return 'No market satisfying the privacy constraint can serve this model. Use route "carpe" (/v1, always TEE) or relax the privacy option.'
    case 'MAX_PRICE_EXCEEDED':
      return 'No market serves this request under max_price. Raise it or shorten the request.'
    case 'VOICE_HANDLE_V1_ONLY':
      return 'Cloned voices (vv_…) only work on route "carpe" (/v1/audio/speech) with the same model they were cloned for.'
    case 'VOICE_EXPIRED':
      return 'The cloned voice handle expired. Clone the sample again with carpe_voice_clone.'
    case 'NEEDS_CONSENT':
      return 'The media contains a human face and the model requires an attestation. Show details.consent.policy_text to the user and only resubmit with consents if they explicitly agree.'
    case 'JOB_NOT_FOUND':
    case 'VIDEO_JOB_NOT_FOUND':
      return 'Unknown or expired job id. Jobs expire (images ~15 min, video files ~10 min after completion).'
    case 'X402_UNPAID_BALANCE':
      return 'The wallet owes USDC from earlier x402 requests. Fund the wallet with USDC on Base, wait for the collection, then retry.'
    case 'X402_PREFLIGHT_FAILED':
      return 'The agent wallet cannot cover this request: send USDC (on Base) to the wallet shown by carpe_x402_status, then retry.'
    case 'X402_INVALID':
      return 'The x402 permit was refused (expired, spent, or under the 0.10 USDC minimum). Check carpe_x402_status; restart the server with a new CARPE_X402_BUDGET_USD to sign a fresh permit.'
    case 'BROWSER_KEY_RAIL_REFUSED':
      return 'Browser-bound keys cannot use /router or x402. Use route "carpe" or a regular API key.'
    case 'PARTNER_KEY_NOT_ALLOWED':
      return 'Partner keys cannot read wallet activity. Use a regular API key created on carpe-diem.xyz.'
    case 'VENICE_ERROR':
      if (status === 402) return 'A Carpe provider key hit its own upstream spend limit — not your balance. Retry in a few seconds; another provider usually takes it.'
      return 'Upstream (Venice) error. Retrying later usually works; check details for refused parameters.'
    default:
      if (status >= 500) return 'Transient operator or upstream failure. Retrying later usually works.'
      return undefined
  }
}

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof CarpeError) return err.toJSON()
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return {
        code: 'TIMEOUT',
        message: 'The request timed out. For paid calls the operator may still have executed (and billed) it — check carpe_usage_history before retrying.',
      }
    }
    return { code: 'CLIENT_ERROR', message: err.message }
  }
  return { code: 'CLIENT_ERROR', message: String(err) }
}
