/** Which tools exist in remote mode, and which OAuth scope each one needs. */
import { SCOPE_ACCOUNT_READ, SCOPE_INFERENCE } from './config.js'

/**
 * Removed from the hosted server:
 *   - carpe_revoke_this_key: a connector is revoked on the website (API → Keys);
 *   - carpe_voice_clone: the recorded person's consent is collected on the website;
 *   - carpe_x402_status: there is no wallet on the server.
 */
export const REMOTE_REMOVED_TOOLS: ReadonlySet<string> = new Set(['carpe_revoke_this_key', 'carpe_voice_clone', 'carpe_x402_status'])

/** Read the signed-in account (and the top-up link, which only returns a URL for the human). */
const ACCOUNT_TOOLS: ReadonlySet<string> = new Set([
  'carpe_balance',
  'carpe_usage_history',
  'carpe_usage_summary',
  'carpe_key_usage',
  'carpe_routing_summary',
  'carpe_rate_limits',
  'carpe_purchases',
  'carpe_topup_link',
])

/** Free, but they fetch the results of paid jobs with the user's credential. */
const JOB_TOOLS: ReadonlySet<string> = new Set(['carpe_image_status', 'carpe_video_status', 'carpe_music_status'])

/** The scope a tool needs, or undefined for free catalogue tools (models, prices, quotes, status). */
export function requiredScope(tool: { name: string; paid: boolean }): string | undefined {
  if (tool.paid || JOB_TOOLS.has(tool.name)) return SCOPE_INFERENCE
  if (ACCOUNT_TOOLS.has(tool.name)) return SCOPE_ACCOUNT_READ
  return undefined
}
