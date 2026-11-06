import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** Every hint is explicit: the MCP spec defaults an omitted hint to destructive and open-world. */
export type ToolHints = Required<Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>

/** Free lookups in Carpe's catalogue or account, no side effect. */
const READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Polls a job; may download and write a file locally, never spends. */
const STATUS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Paid calls that create something new. */
const GENERATE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** Paid calls that may fetch URLs, search the web, or route to external markets. */
const OPEN_GENERATE: ToolHints = { ...GENERATE, openWorldHint: true }
/** Creates an object on the account without spending (checkout ticket, cloned voice). */
const CREATE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** Irreversible. */
const DESTRUCTIVE: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

/** Keyed by tool name; a registered tool without an entry fails the tests. */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  // catalogue (free)
  carpe_list_models: READ,
  carpe_model_details: READ,
  carpe_pricing: READ,
  carpe_quote: READ,
  carpe_markets: READ,
  carpe_status: READ,

  // account (free)
  carpe_balance: READ,
  carpe_usage_history: READ,
  carpe_usage_summary: READ,
  carpe_key_usage: READ,
  carpe_routing_summary: READ,
  carpe_rate_limits: READ,
  carpe_purchases: READ,
  carpe_session_spend: READ,
  carpe_x402_status: READ,
  carpe_topup_link: CREATE,
  carpe_revoke_this_key: DESTRUCTIVE,

  // text (paid)
  carpe_chat: OPEN_GENERATE,
  carpe_embeddings: OPEN_GENERATE,
  carpe_web_search: OPEN_GENERATE,
  carpe_web_scrape: OPEN_GENERATE,

  // image (paid)
  carpe_image_generate: OPEN_GENERATE,
  carpe_image_edit: OPEN_GENERATE,
  carpe_image_multi_edit: OPEN_GENERATE,
  carpe_image_upscale: OPEN_GENERATE,
  carpe_image_status: STATUS,

  // audio
  carpe_tts: OPEN_GENERATE,
  carpe_transcribe: OPEN_GENERATE,
  carpe_voice_clone: CREATE,

  // video / music
  carpe_video_generate: OPEN_GENERATE,
  carpe_video_status: STATUS,
  carpe_music_generate: OPEN_GENERATE,
  carpe_music_status: STATUS,
}
