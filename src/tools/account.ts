/** Account tools (need CARPE_API_KEY), session spend, x402 status, kill switch. */
import { z } from 'zod'
import { json, ok, safe, type ToolContext, type ToolDef } from './context.js'

export function accountTools(ctx: ToolContext): ToolDef[] {
  const get = async (path: string, query?: Record<string, string | number | undefined>) =>
    (await ctx.client.request({ path, query, auth: 'account' })).json<Record<string, unknown>>()

  return [
    {
      name: 'carpe_balance',
      title: 'Account balance',
      description:
        'Spendable balance of the Carpe Diem account behind CARPE_API_KEY: credits (1 credit = $0.01; escrow = purchased, pending = spent not yet settled, holds = reserved for in-flight requests, available = spendable), unsettled debt, prepaid account and the active payment rail. Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => {
        const [credits, debt, prepaid, rail] = await Promise.allSettled([get('/v1/credits'), get('/buyer/debt'), get('/v1/prepaid/status'), get('/v1/prepaid/rail')])
        if (credits.status === 'rejected') throw credits.reason
        const c = credits.value
        const val = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null)
        return json(
          { credits: c, debt: val(debt), prepaid: val(prepaid), rail: val(rail) },
          `Available: ${c.availableCredits ?? '?'} credits ($${c.availableUsdc ?? '?'})`,
        )
      }),
    },
    {
      name: 'carpe_usage_history',
      title: 'Usage history',
      description: 'Per-request history of the account, newest first: model, provider pseudonym, tokens, cost (USDC), market that served, routing reason, latency, savings. Free.',
      paid: false,
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        offset: z.number().int().min(0).optional(),
        days: z.number().int().min(1).max(365).optional().describe('Only the last N days.'),
        market: z.string().optional().describe('Only requests served by this market (carpe, surplus, antseed, openrouter, chutes, venice, engy).'),
      },
      handler: safe(async (a) => json(await get('/buyer/usage', { limit: a.limit ?? 20, offset: a.offset, days: a.days, market: a.market }))),
    },
    {
      name: 'carpe_usage_summary',
      title: 'Usage summary',
      description: 'Account spend aggregated by model and by day over the last N days (1–90, default 7). Free.',
      paid: false,
      inputSchema: { days: z.number().int().min(1).max(90).optional() },
      handler: safe(async (a) => json(await get('/buyer/usage/summary', { days: a.days ?? 7 }))),
    },
    {
      name: 'carpe_key_usage',
      title: 'Usage per API key',
      description: 'Requests, tokens and cost per API key of the account over the last N days, with each key\'s rail and status. Free.',
      paid: false,
      inputSchema: { days: z.number().int().min(1).max(90).optional() },
      handler: safe(async (a) => json(await get('/buyer/api-keys/usage', { days: a.days ?? 30 }))),
    },
    {
      name: 'carpe_routing_summary',
      title: 'Router savings summary',
      description: 'How the account\'s /router requests were served: wins per market and savings versus Carpe-only pricing. Free.',
      paid: false,
      inputSchema: { days: z.number().int().min(1).max(90).optional() },
      handler: safe(async (a) => json(await get('/buyer/routing/summary', { days: a.days }))),
    },
    {
      name: 'carpe_rate_limits',
      title: 'Rate limits',
      description: 'The operator rate limit applied to this key right now (max per window, remaining, reset), separate read budget, and parallel lanes. Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => json(await get('/v1/rate_limits'))),
    },
    {
      name: 'carpe_purchases',
      title: 'Card purchases',
      description: 'Credit purchases made by card on the account. Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => json(await get('/v1/billing/purchases'))),
    },
    {
      name: 'carpe_topup_link',
      title: 'Top-up link',
      description:
        'Card top-up for this account. Nothing is charged by this tool: with create: true it returns a checkout URL that a HUMAN must open to pay (valid for a limited time); otherwise it only lists the credit tiers. Never open or pay the link yourself.',
      paid: false,
      inputSchema: {
        create: z.boolean().optional().describe('true = create a checkout URL. Default false = list tiers only.'),
        tier_id: z.string().optional().describe('Preselect a tier (e.g. credits_500). Omit to let the user choose on the page.'),
      },
      handler: safe(async (a) => {
        const tiers = (await ctx.client.request({ path: '/v1/billing/tiers', auth: 'none' })).json<Record<string, unknown>>()
        if (!a.create) return json({ ...tiers, next: 'Call again with create: true (and optionally tier_id) to get a checkout URL for the user.' })
        const res = await ctx.client.request({ method: 'POST', path: '/v1/billing/checkout-ticket', auth: 'account', json: a.tier_id ? { tier: a.tier_id } : {}, retry: 'none' })
        const t = res.json<{ url?: string; ticketId?: string; expiresAt?: string }>()
        return json({ ...t, instructions: 'Give this URL to the user; they complete the card payment in their browser. Credits appear in carpe_balance once paid.' }, t.url ? `Checkout URL (for the user): ${t.url}` : undefined)
      }),
    },
    {
      name: 'carpe_session_spend',
      title: 'Spend in this session',
      description: 'What this MCP server has spent since it started, per tool, against the CARPE_MAX_SPEND_USD and CARPE_MAX_PER_CALL_USD guards. Local, free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => json(ctx.guard.snapshot())),
    },
    {
      name: 'carpe_x402_status',
      title: 'x402 wallet status',
      description: 'x402 mode only: the agent wallet address, its USDC balance on Base, the permit budget, what was billed and what is left. Free.',
      paid: false,
      inputSchema: {},
      handler: safe(async () => {
        const s = ctx.client.x402Session
        if (!s) return json({ x402: 'disabled', payment_mode: ctx.client.mode, hint: 'Set CARPE_X402_PRIVATE_KEY and CARPE_X402_BUDGET_USD (and no CARPE_API_KEY) to pay per request from a wallet.' })
        return json(await s.status())
      }),
    },
    {
      name: 'carpe_revoke_this_key',
      title: 'Revoke this API key (kill switch)',
      description:
        'IRREVERSIBLE: permanently revokes the API key this server uses (CARPE_API_KEY). Every later call with it fails. Use only if the user explicitly asks, or if the key leaked. Requires confirm: "REVOKE".',
      paid: false,
      inputSchema: { confirm: z.literal('REVOKE').describe('Must be exactly "REVOKE".') },
      handler: safe(async () => {
        const res = await ctx.client.request({ method: 'POST', path: '/v1/keys/self/revoke', auth: 'account', retry: 'none', json: {} })
        return ok('The API key is revoked. Create a new one on carpe-diem.xyz and update CARPE_API_KEY.', { revoked: true, response: res.isJson ? res.json() : res.text() })
      }),
    },
  ]
}
