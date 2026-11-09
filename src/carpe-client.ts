/**
 * HTTP client for the Carpe Diem operator.
 *
 * - Always targets the public edge (`https://carpe-diem.xyz/api/operator`).
 * - Never follows redirects (credentials and bodies stay on the configured origin).
 * - Reads every body with a byte cap.
 * - Turns every error shape into a CarpeError (see errors.ts).
 * - Parses the cost / route / payment headers into `meta`.
 * - Pays either with the API key or, in x402 mode, with the session permit.
 * - Remote mode (`oauth`): relays the signed-in user's access token verbatim
 *   (`Authorization: Bearer <token>`) on account and paid routes only; the
 *   operator resolves it to the connector's own key. No key is held here.
 *
 * Retry policy — the one place double billing could come from, so it is strict:
 *   read  : GETs and free POSTs (quote): up to 2 retries on transient failures.
 *   paid  : one retry, ONLY when the operator certainly did not execute the call
 *           (429 / capacity 503 refusals), or when an Idempotency-Key makes a
 *           replay free (router routes). Never after a timeout or an ambiguous 5xx.
 *   none  : no retry.
 */
import type { Config, PaymentMode } from './config.js'
import { paymentMode } from './config.js'
import { CarpeError, LocalRefusal, RETRYABLE_CODES, errorFromBody } from './errors.js'
import type { X402Session } from './x402/session.js'

export type AuthKind = 'none' | 'optional' | 'account' | 'paid'
export type RetryKind = 'read' | 'paid' | 'none'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  json?: unknown
  form?: FormData
  auth: AuthKind
  /** Path of the x402 sibling, used instead of `path` in x402 mode. Absent → unavailable in x402 mode. */
  x402Path?: string
  maxBytes?: number
  timeoutMs?: number
  idempotencyKey?: string
  retry?: RetryKind
  signal?: AbortSignal
}

export interface CallMeta {
  status: number
  /** What this call cost, in USD (USDC), when the operator reported it. */
  costUsd?: number
  costSource?: 'x-carpe-cost' | 'router' | 'x402' | 'stream-usage'
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  availableCredits?: number
  routeMarket?: string
  routeReason?: string
  routeFallback?: string
  routeAttempts?: string
  routePin?: string
  routeSavedUsd?: number
  routeSticky?: string
  providerId?: string
  compat?: string
  lane?: string
  paymentTx?: string
  paymentSettlement?: string
  idempotentReplayed?: boolean
  rateLimitRemaining?: number
  imageStatus?: string
  audioStreaming?: string
}

export class CarpeResponse {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly body: Buffer,
    readonly meta: CallMeta,
  ) {}

  get contentType(): string {
    return (this.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  }

  get isJson(): boolean {
    return this.contentType === 'application/json' || this.contentType.endsWith('+json')
  }

  text(): string {
    return this.body.toString('utf8')
  }

  json<T = unknown>(): T {
    try {
      return JSON.parse(this.text()) as T
    } catch {
      throw new CarpeError({ status: this.status, code: 'INVALID_JSON', message: `Expected JSON from Carpe Diem, got ${this.contentType || 'no content type'}` })
    }
  }
}

type FetchLike = typeof fetch

function headerNum(h: Headers, name: string): number | undefined {
  const v = h.get(name)
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function headerStr(h: Headers, name: string): string | undefined {
  const v = h.get(name)
  return v === null || v.trim() === '' ? undefined : v
}

export function parseMeta(status: number, h: Headers): CallMeta {
  const meta: CallMeta = { status }
  const x402Amount = headerNum(h, 'x-payment-amount-usdc')
  const routeCost = headerNum(h, 'x-carpe-route-cost-usdc')
  const carpeCostMicro = headerNum(h, 'x-carpe-cost-usdc-micro')
  if (x402Amount !== undefined) {
    meta.costUsd = x402Amount
    meta.costSource = 'x402'
  } else if (routeCost !== undefined) {
    meta.costUsd = routeCost
    meta.costSource = 'router'
  } else if (carpeCostMicro !== undefined) {
    meta.costUsd = carpeCostMicro / 1e6
    meta.costSource = 'x-carpe-cost'
  }
  meta.inputTokens = headerNum(h, 'x-carpe-input-tokens')
  meta.outputTokens = headerNum(h, 'x-carpe-output-tokens')
  meta.cachedTokens = headerNum(h, 'x-carpe-cached-tokens')
  meta.availableCredits = headerNum(h, 'x-carpe-available-credits')
  meta.routeMarket = headerStr(h, 'x-carpe-route-market')
  meta.routeReason = headerStr(h, 'x-carpe-route-reason')
  meta.routeFallback = headerStr(h, 'x-carpe-route-fallback')
  meta.routeAttempts = headerStr(h, 'x-carpe-route-attempts')
  meta.routePin = headerStr(h, 'x-carpe-route-pin')
  meta.routeSavedUsd = headerNum(h, 'x-carpe-route-saved-usdc')
  meta.routeSticky = headerStr(h, 'x-carpe-route-sticky')
  meta.providerId = headerStr(h, 'x-provider-id')
  meta.compat = headerStr(h, 'x-carpe-compat')
  meta.lane = headerStr(h, 'x-carpe-lane')
  meta.paymentTx = headerStr(h, 'x-payment-tx')
  meta.paymentSettlement = headerStr(h, 'x-payment-settlement')
  meta.idempotentReplayed = h.get('idempotent-replayed') === 'true' ? true : undefined
  meta.rateLimitRemaining = headerNum(h, 'x-ratelimit-remaining')
  meta.imageStatus = headerStr(h, 'x-carpe-image-status')
  meta.audioStreaming = headerStr(h, 'x-carpe-audio-streaming')
  for (const k of Object.keys(meta) as (keyof CallMeta)[]) if (meta[k] === undefined) delete meta[k]
  return meta
}

async function readBounded(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw new CarpeError({ status: res.status, code: 'RESPONSE_TOO_LARGE', message: `Response of ${declared} bytes exceeds the ${maxBytes}-byte limit.` })
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new CarpeError({ status: res.status, code: 'RESPONSE_TOO_LARGE', message: `Response exceeds the ${maxBytes}-byte limit.` })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const MAX_RETRY_WAIT_MS = 10_000

/** Remote mode: returns the access token of the user this client acts for (undefined = none). */
export type BearerSource = () => string | undefined

export class CarpeClient {
  readonly mode: PaymentMode
  private readonly userAgent: string

  constructor(
    readonly cfg: Config,
    private readonly x402: X402Session | undefined = undefined,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly userToken: BearerSource | undefined = undefined,
  ) {
    this.mode = paymentMode(cfg)
    this.userAgent = `${cfg.serverName}/${cfg.serverVersion}`
  }

  /** API key or relayed OAuth token: the operator's Bearer routes (streaming, quotes) are available. */
  get usesBearer(): boolean {
    return this.mode === 'api_key' || this.mode === 'oauth'
  }

  /**
   * The Bearer credential for account / paid routes. Remote mode never falls
   * back to a server-held key: only the user's token is ever sent.
   */
  private bearer(): string | undefined {
    if (this.mode === 'oauth') return this.userToken?.() || undefined
    return this.cfg.apiKey
  }

  /** Absolute URL for a path the operator returned relative (e.g. video_url). */
  absoluteUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path
    return `${this.cfg.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
  }

  get x402Session(): X402Session | undefined {
    return this.x402
  }

  async request(opts: RequestOptions): Promise<CarpeResponse> {
    const retry = opts.retry ?? (opts.auth === 'paid' ? 'paid' : 'read')
    const maxAttempts = retry === 'read' ? 3 : retry === 'paid' ? 2 : 1
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.once(opts)
        if (res.status >= 200 && res.status < 300) return res
        throw this.toError(res)
      } catch (err) {
        lastErr = err
        if (err instanceof LocalRefusal) throw err
        if (attempt >= maxAttempts || !this.shouldRetry(err, retry, opts)) throw err
        const wait = err instanceof CarpeError && err.retryAfterMs !== undefined ? err.retryAfterMs : 500 * 2 ** (attempt - 1)
        if (wait > MAX_RETRY_WAIT_MS) throw err
        await sleep(wait)
      }
    }
    throw lastErr
  }

  private shouldRetry(err: unknown, retry: RetryKind, opts: RequestOptions): boolean {
    if (retry === 'none') return false
    const isNetwork = !(err instanceof CarpeError) && err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'AbortError'
    if (retry === 'read') {
      if (isNetwork) return true
      return err instanceof CarpeError && (RETRYABLE_CODES.has(err.code) || err.status === 502 || err.status === 503 || err.status === 429)
    }
    // paid
    if (err instanceof CarpeError) {
      if (err.code === 'IDEMPOTENCY_KEY_SPENT' || err.code === 'IDEMPOTENCY_KEY_REUSED') return false
      if (err.notExecuted && RETRYABLE_CODES.has(err.code)) return true
      // A provider's own Venice key hit its spend limit: refused before serving, another key may take it.
      if (err.status === 402 && err.code === 'VENICE_ERROR') return true
      // With an Idempotency-Key the operator replays the first answer instead of re-running it.
      if (opts.idempotencyKey && (err.status === 502 || err.status === 503 || err.code === 'IDEMPOTENCY_IN_FLIGHT')) return true
      return false
    }
    return isNetwork && opts.idempotencyKey !== undefined
  }

  private toError(res: CarpeResponse): CarpeError {
    let body: unknown = res.text()
    if (res.isJson || /^\s*[{[]/.test(body as string)) {
      try {
        body = JSON.parse(body as string)
      } catch {
        /* keep text */
      }
    }
    const err = errorFromBody(res.status, body, res.headers)
    if (this.mode === 'oauth' && err.status === 401) {
      // The API-key hint (set CARPE_API_KEY) means nothing to a hosted connector's user.
      return new CarpeError({
        status: err.status,
        code: err.code,
        message: err.message,
        retryAfterMs: err.retryAfterMs,
        details: err.details,
        notExecuted: err.notExecuted,
        hint: 'Carpe Diem refused this connection (expired, revoked, or not allowed for this route). Reconnect the Carpe Diem connector in your client; connectors are listed and revocable in API → Keys.',
      })
    }
    return err
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.cfg.baseUrl + path)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    return url.toString()
  }

  private async once(opts: RequestOptions): Promise<CarpeResponse> {
    const headers: Record<string, string> = { 'user-agent': this.userAgent, accept: '*/*' }
    let path = opts.path
    let usingX402 = false

    if (this.mode === 'oauth') {
      // The user's token goes only to the routes that need an account; public reads stay anonymous.
      if (opts.auth === 'account' || opts.auth === 'paid') {
        const token = this.bearer()
        if (!token) throw new LocalRefusal('NOT_AUTHENTICATED', 'No signed-in Carpe Diem account for this request.', 'Reconnect the Carpe Diem connector in your client.')
        headers.authorization = `Bearer ${token}`
      }
    } else if (opts.auth === 'account' || opts.auth === 'optional' || (opts.auth === 'paid' && this.mode === 'api_key')) {
      if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`
      else if (opts.auth === 'account') {
        throw new LocalRefusal('API_KEY_REQUIRED', 'This tool reads a Carpe Diem account and needs CARPE_API_KEY (x402 wallets have no account).')
      }
    }
    if (opts.auth === 'paid' && !this.usesBearer) {
      if (this.mode === 'none' || !this.x402) {
        throw new LocalRefusal(
          'NO_PAYMENT_METHOD',
          'This tool spends money and no payment method is configured.',
          'Set CARPE_API_KEY (a cdm_ key), or CARPE_X402_PRIVATE_KEY with CARPE_X402_BUDGET_USD for x402 pay-per-call.',
        )
      }
      if (!opts.x402Path) {
        throw new LocalRefusal('NOT_AVAILABLE_IN_X402', `${opts.path} has no x402 equivalent on Carpe Diem; it needs CARPE_API_KEY.`)
      }
      path = opts.x402Path
      usingX402 = true
    }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey

    let body: BodyInit | undefined
    if (opts.form) body = opts.form
    else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['content-type'] = 'application/json'
    }
    const url = this.buildUrl(path, opts.query)
    const send = async (paymentHeader?: string): Promise<CarpeResponse> => {
      const h = { ...headers, ...(paymentHeader ? { 'x-payment': paymentHeader } : {}) }
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs)])
        : AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs)
      const res = await this.fetchImpl(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers: h, body, redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined)
        throw new CarpeError({ status: res.status, code: 'REDIRECT_REFUSED', message: 'Carpe Diem answered with a redirect; refusing to follow it with credentials.', notExecuted: true })
      }
      const buf = await readBounded(res, res.ok ? opts.maxBytes ?? this.cfg.maxJsonBytes : 1024 * 1024)
      return new CarpeResponse(res.status, res.headers, buf, parseMeta(res.status, res.headers))
    }

    if (!usingX402) return send()
    return this.x402!.pay(send)
  }

  /**
   * POST with an API key and hand back the live body (SSE). A refusal before the
   * stream starts (non-2xx) is thrown as a CarpeError and retried once when the
   * operator certainly did not execute it. A JSON answer is returned as `json`.
   */
  async openStream(opts: Omit<RequestOptions, 'auth'>): Promise<{ meta: CallMeta; headers: Headers; stream?: ReadableStream<Uint8Array>; json?: unknown }> {
    const token = this.bearer()
    if (!token) {
      if (this.mode === 'oauth') throw new LocalRefusal('NOT_AUTHENTICATED', 'No signed-in Carpe Diem account for this request.', 'Reconnect the Carpe Diem connector in your client.')
      throw new LocalRefusal('API_KEY_REQUIRED', 'Streaming needs CARPE_API_KEY.')
    }
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = {
        'user-agent': this.userAgent,
        accept: 'text/event-stream, application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      }
      const res = await this.fetchImpl(this.buildUrl(opts.path, opts.query), {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.json),
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs),
      })
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined)
        throw new CarpeError({ status: res.status, code: 'REDIRECT_REFUSED', message: 'Refusing to follow a redirect.', notExecuted: true })
      }
      const meta = parseMeta(res.status, res.headers)
      const ct = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!res.ok) {
        const buf = await readBounded(res, 1024 * 1024)
        const err = this.toError(new CarpeResponse(res.status, res.headers, buf, meta))
        if (attempt < 2 && this.shouldRetry(err, 'paid', opts as RequestOptions)) {
          const wait = err.retryAfterMs ?? 500
          if (wait <= MAX_RETRY_WAIT_MS) {
            await sleep(wait)
            continue
          }
        }
        throw err
      }
      if (ct.includes('application/json')) {
        const buf = await readBounded(res, opts.maxBytes ?? this.cfg.maxJsonBytes)
        return { meta, headers: res.headers, json: JSON.parse(buf.toString('utf8')) }
      }
      if (!res.body) throw new CarpeError({ status: res.status, code: 'EMPTY_STREAM', message: 'Empty response body.' })
      return { meta, headers: res.headers, stream: res.body }
    }
  }
}
