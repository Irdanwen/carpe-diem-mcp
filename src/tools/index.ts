import { accountTools } from './account.js'
import { asyncMediaTools } from './async-media.js'
import { audioTools } from './audio.js'
import { catalogTools } from './catalog.js'
import { fail, type ToolContext, type ToolDef } from './context.js'
import { LocalRefusal } from '../errors.js'
import { imageTools } from './image.js'
import { textTools } from './text.js'

export function buildTools(ctx: ToolContext): ToolDef[] {
  const all = [...catalogTools(ctx), ...accountTools(ctx), ...textTools(ctx), ...imageTools(ctx), ...audioTools(ctx), ...asyncMediaTools(ctx)].map((t) =>
    t.paid && ctx.client.mode === 'none'
      ? {
          ...t,
          // Refuse before any network call (quotes included) when nothing can pay.
          handler: async () =>
            fail(new LocalRefusal('NO_PAYMENT_METHOD', 'This tool spends money and no payment method is configured.', 'Set CARPE_API_KEY (a cdm_ key), or CARPE_X402_PRIVATE_KEY with CARPE_X402_BUDGET_USD for x402 pay-per-call.')),
        }
      : t,
  )
  // CARPE_READ_ONLY=1 removes every tool that can spend money.
  return ctx.cfg.readOnly ? all.filter((t) => !t.paid && t.name !== 'carpe_revoke_this_key' && t.name !== 'carpe_topup_link' && t.name !== 'carpe_voice_clone') : all
}

export type { ToolContext, ToolDef } from './context.js'
