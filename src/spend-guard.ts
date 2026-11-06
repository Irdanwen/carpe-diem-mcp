/**
 * Client-side spending guard, in every payment mode.
 *
 * Before a paid call: an estimate (router quote for tokens, the published fixed
 * cost for media, the video quote for video) is compared with
 * CARPE_MAX_PER_CALL_USD and with what is left of CARPE_MAX_SPEND_USD. A call
 * whose cost cannot be estimated is only allowed while at least one full
 * per-call allowance is left, i.e. it is assumed to cost the per-call cap.
 *
 * After the call: the cost the operator reported in its headers is added.
 * A limit of 0 disables that limit.
 */
import type { Config, Surface } from './config.js'
import type { CallMeta, CarpeClient } from './carpe-client.js'
import { CarpeError, LocalRefusal } from './errors.js'

export interface SpendRecord {
  tool: string
  usd: number
  estimated: boolean
  at: string
}

export interface SpendHold {
  tool: string
  amount: number
  estimateUsd: number | undefined
  open: boolean
}

export class SpendGuard {
  private spent = 0
  /** Reserved by calls in flight, so concurrent calls cannot overshoot the session limit together. */
  private pending = 0
  private readonly history: SpendRecord[] = []

  constructor(private readonly cfg: Config) {}

  get spentUsd(): number {
    return this.spent
  }

  get remainingUsd(): number | null {
    return this.cfg.maxSpendUsd > 0 ? Math.max(0, this.cfg.maxSpendUsd - this.spent - this.pending) : null
  }

  /** Check the limits and reserve the estimate (or the per-call cap when unknown) until settle/fail. */
  reserve(tool: string, estimateUsd: number | undefined): SpendHold {
    this.check(tool, estimateUsd)
    const amount = estimateUsd ?? (this.cfg.maxPerCallUsd > 0 ? this.cfg.maxPerCallUsd : 0)
    this.pending += amount
    return { tool, amount, estimateUsd, open: true }
  }

  settle(hold: SpendHold, meta: CallMeta | undefined): number | undefined {
    this.close(hold)
    return this.record(hold.tool, meta, hold.estimateUsd)
  }

  /** A failed call: free the reservation; if it may still have been billed (timeout, ambiguous 5xx), count the estimate. */
  fail(hold: SpendHold, err: unknown): void {
    this.close(hold)
    const certainlyNotRun = err instanceof CarpeError && err.notExecuted
    // Fail closed: without an estimate, count what was reserved (the per-call cap).
    const usd = hold.estimateUsd ?? (hold.amount > 0 ? hold.amount : undefined)
    if (!certainlyNotRun && usd !== undefined) this.record(`${hold.tool} (failed, possibly billed)`, undefined, usd)
  }

  private close(hold: SpendHold): void {
    if (!hold.open) return
    hold.open = false
    this.pending = Math.max(0, this.pending - hold.amount)
  }

  check(tool: string, estimateUsd: number | undefined): void {
    const perCall = this.cfg.maxPerCallUsd
    const remaining = this.remainingUsd
    const raise = 'Raise CARPE_MAX_PER_CALL_USD / CARPE_MAX_SPEND_USD in the MCP server configuration if this spend is intended.'
    if (estimateUsd !== undefined) {
      if (perCall > 0 && estimateUsd > perCall) {
        throw new LocalRefusal('SPEND_LIMIT_PER_CALL', `${tool} is estimated at $${estimateUsd.toFixed(4)}, above the per-call limit of $${perCall.toFixed(2)}. Nothing was sent.`, raise)
      }
      if (remaining !== null && estimateUsd > remaining) {
        throw new LocalRefusal('SPEND_LIMIT_SESSION', `${tool} is estimated at $${estimateUsd.toFixed(4)} but only $${remaining.toFixed(4)} of the session budget ($${this.cfg.maxSpendUsd.toFixed(2)}) is left. Nothing was sent.`, raise)
      }
      return
    }
    if (remaining !== null && perCall > 0 && remaining < perCall) {
      throw new LocalRefusal('SPEND_LIMIT_SESSION', `The cost of ${tool} cannot be estimated in advance and less than one per-call allowance ($${perCall.toFixed(2)}) is left of the session budget. Nothing was sent.`, raise)
    }
  }

  record(tool: string, meta: CallMeta | undefined, estimateUsd?: number): number | undefined {
    const usd = meta?.costUsd ?? estimateUsd
    if (usd === undefined) return undefined
    this.spent += usd
    this.history.push({ tool, usd, estimated: meta?.costUsd === undefined, at: new Date().toISOString() })
    if (this.history.length > 200) this.history.shift()
    return usd
  }

  snapshot(): Record<string, unknown> {
    const byTool: Record<string, { calls: number; usd: number }> = {}
    for (const h of this.history) {
      byTool[h.tool] ??= { calls: 0, usd: 0 }
      byTool[h.tool].calls++
      byTool[h.tool].usd += h.usd
    }
    return {
      spent_usd: round(this.spent),
      session_limit_usd: this.cfg.maxSpendUsd > 0 ? this.cfg.maxSpendUsd : null,
      remaining_usd: this.remainingUsd === null ? null : round(this.remainingUsd),
      per_call_limit_usd: this.cfg.maxPerCallUsd > 0 ? this.cfg.maxPerCallUsd : null,
      by_tool: Object.fromEntries(Object.entries(byTool).map(([k, v]) => [k, { calls: v.calls, usd: round(v.usd) }])),
      recent: this.history.slice(-10).map((h) => ({ ...h, usd: round(h.usd) })),
      note: 'Session = since this MCP server started. Costs come from the operator response headers; entries marked estimated had no reported cost.',
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

interface PricingRow {
  model: string
  inputPrice?: number
  outputPrice?: number
}
interface FixedCostRow {
  model: string
  type: string
  costUsd: number
}
export interface PricingSnapshot {
  models: PricingRow[]
  fixedCost: FixedCostRow[]
  updatedAt?: string
}

/** Cost estimation from the operator's free endpoints, cached for a few minutes. */
export class Estimator {
  private pricing: { at: number; data: PricingSnapshot } | undefined

  constructor(private readonly client: CarpeClient) {}

  async getPricing(): Promise<PricingSnapshot> {
    if (this.pricing && Date.now() - this.pricing.at < 5 * 60_000) return this.pricing.data
    const res = await this.client.request({ path: '/pricing', auth: 'none' })
    const data = res.json<PricingSnapshot>()
    this.pricing = { at: Date.now(), data }
    return data
  }

  /** Per-unit fixed cost (image, edit, augment), already including the multiplier. */
  async fixedCost(model: string): Promise<number | undefined> {
    try {
      const p = await this.getPricing()
      return p.fixedCost.find((f) => f.model === model)?.costUsd
    } catch {
      return undefined
    }
  }

  /** The /pricing row of a model (token, character or representative-job price). */
  async row(model: string): Promise<PricingRow | undefined> {
    try {
      return (await this.getPricing()).models.find((r) => r.model === model)
    } catch {
      return undefined
    }
  }

  /** TTS: inputPrice is USD per 1M input characters. */
  async ttsCost(model: string, chars: number): Promise<number | undefined> {
    const r = await this.row(model)
    return r?.inputPrice !== undefined ? (r.inputPrice * chars) / 1e6 : undefined
  }

  /** Token cost estimate from POST /router/quote, for the given surface. */
  async tokenCost(model: string, inputTokens: number, outputTokens: number, surface: Surface, privacy?: unknown): Promise<number | undefined> {
    try {
      const res = await this.client.request({
        method: 'POST',
        path: '/router/quote',
        auth: 'none',
        json: { model, input_tokens: Math.max(1, Math.round(inputTokens)), max_tokens: Math.max(1, Math.round(outputTokens)), ...(privacy !== undefined ? { privacy } : {}) },
        timeoutMs: 15_000,
      })
      const q = res.json<{ carpeCostUsd?: number | null; best?: { costUsd?: number | null } | null; candidates?: { market: string; available: boolean; costUsd: number | null }[] }>()
      const carpe = q.candidates?.find((c) => c.market === 'carpe')
      if (surface === 'carpe') {
        if (carpe && !carpe.available) return undefined
        return q.carpeCostUsd ?? undefined
      }
      return q.best?.costUsd ?? q.carpeCostUsd ?? undefined
    } catch {
      return undefined
    }
  }
}

/** Rough token count of a chat payload: ~4 characters per token, plus ~1000 tokens per image. */
export function estimateInputTokens(payload: unknown): number {
  let chars = 0
  let images = 0
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith('data:image/') || /^https?:\/\/.+\.(png|jpe?g|webp|gif)(\?|$)/i.test(v)) images++
      else chars += v.length
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (o.type === 'image_url') {
        images++
        return
      }
      Object.values(o).forEach(walk)
    }
  }
  walk(payload)
  return Math.ceil(chars / 4) + images * 1000 + 16
}
