# carpe-diem-mcp

> Model Context Protocol server for **[Carpe Diem](https://carpe-diem.xyz)**: Venice AI models (text, image, video, speech, music, embeddings, web search), bought on the Carpe Diem marketplace — usually well below Venice list prices — with best-price routing, hard spend limits and optional **x402** pay-per-call from a wallet on Base.

Works with Claude Code, Claude Desktop, Cursor, Cline, LM Studio and any MCP host. Node.js ≥ 20.

- **33 tools**, 3 resources (`carpe://models`, `carpe://pricing`, `carpe://markets`), 3 prompts.
- Every result reports **the exact cost billed** and **who served it** (and whether it was a TEE).
- **Spend guard** in every mode: per-call and per-session limits checked *before* sending, from free quotes.
- Every tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.

## Quick start

1. Create an API key on [carpe-diem.xyz](https://carpe-diem.xyz/build?tab=keys) → **API → Keys** (`cdm_…`) and add credits in **API → Balance**.
2. Add the server to your MCP host.

**Claude Code**

```bash
claude mcp add carpe -e CARPE_API_KEY=cdm_your_key -- npx -y carpe-diem-mcp
```

**Claude Desktop / Cursor / others** (`claude_desktop_config.json`, `~/.cursor/mcp.json`, …)

```json
{
  "mcpServers": {
    "carpe": {
      "command": "npx",
      "args": ["-y", "carpe-diem-mcp"],
      "env": { "CARPE_API_KEY": "cdm_your_key", "CARPE_MAX_SPEND_USD": "5" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`, or `codex mcp add carpe --env CARPE_API_KEY=cdm_your_key -- npx -y carpe-diem-mcp`)

```toml
[mcp_servers.carpe]
command = "npx"
args = ["-y", "carpe-diem-mcp"]
env_vars = ["CARPE_API_KEY"]
```

**VS Code** (`.vscode/mcp.json`) — the key is asked once and stored securely

```json
{
  "inputs": [{ "type": "promptString", "id": "carpe-key", "description": "Carpe Diem API key", "password": true }],
  "servers": {
    "carpe": { "type": "stdio", "command": "npx", "args": ["-y", "carpe-diem-mcp"], "env": { "CARPE_API_KEY": "${input:carpe-key}" } }
  }
}
```

**OpenCode** (`opencode.json`)

```json
{ "mcp": { "carpe": { "type": "local", "command": ["npx", "-y", "carpe-diem-mcp"], "environment": { "CARPE_API_KEY": "{env:CARPE_API_KEY}" } } } }
```

**Gemini CLI** (`~/.gemini/settings.json`) — declare the key in `env`: Gemini CLI hides inherited variables named `*KEY*`.

Zed, Cline, Goose, Continue, LM Studio and others, with use cases and costs: **[carpe-diem.xyz/docs/integrations](https://carpe-diem.xyz/docs/integrations#mcp-install)**. ChatGPT and claude.ai on the web only accept remote MCP servers with OAuth, which this local server is not.

3. Restart the host and ask: *"Find the cheapest model to summarise this text, then do it."*

## Two surfaces: `/v1` and `/router`

Carpe Diem exposes **two different APIs**. They are not interchangeable, and this server never treats one as a prefix swap of the other. Tools that exist on both take a `route` argument:

| | `route: "carpe"` → **`/v1`** | `route: "router"` → **`/router`** |
|---|---|---|
| Served by | Carpe alone: Venice through provider keys held in Carpe's TEE | The cheapest market among Carpe, Surplus, AntSeed, OpenRouter, Chutes, Venice, Engy |
| Confidentiality | Always TEE | May leave the TEE. `privacy: true` restricts to TEE markets; `"private"` to no-retention markets |
| Price | Carpe price (Venice list × dynamic multiplier) | Winning market's price + router fee (external routes only) |
| Paths & shapes | Venice-style (`/v1/image/generate`, `/v1/video/queue`) | OpenAI-style (`/router/images/generations`, `/router/video/generations`) |
| Async jobs | A finished music track can be claimed **once** | Settled jobs stay readable 24 h |

Which tools have both surfaces:

| Capability | `/v1` | `/router` |
|---|---|---|
| `carpe_chat` | `/v1/chat/completions` | `/router/chat/completions` (+ `Idempotency-Key`, `privacy`, `provider`) |
| `carpe_embeddings` | `/v1/embeddings` | `/router/embeddings` |
| `carpe_image_generate` / `carpe_image_edit` | `/v1/image/{generate,edit}` (+ queue) | `/router/images/{generations,edits}` (+ retrieve) |
| `carpe_tts` / `carpe_transcribe` | `/v1/audio/{speech,transcriptions}` | `/router/audio/{speech,transcriptions}` |
| `carpe_video_generate` | `/v1/video/{quote,queue,retrieve}` | `/router/video/{generations,retrieve}` |
| `carpe_music_generate` | `/v1/audio/music/{queue,retrieve}` | `/router/audio/music/{queue,retrieve}` |
| multi-edit, upscale, voice clone, web search/scrape | **`/v1` only** | — (no market arbitrates them) |

Each result includes `route: { surface, endpoint_prefix, route_used, tee, reason?, fallback?, warning? }`. When the router served a request outside a TEE and you did not ask for `privacy`, a `warning` says so. Job ids are prefixed with the surface that created them (`v1:…`, `router:…`, `x402:…`) so status tools always poll the right one. The default surface is `CARPE_DEFAULT_ROUTE` (`carpe`).

## Payment modes

| Mode | Set | What happens |
|---|---|---|
| **API key** (recommended) | `CARPE_API_KEY=cdm_…` | Billed to your Carpe account (credits or prepaid rail). Account tools work. |
| **x402** (no account) | `CARPE_X402_PRIVATE_KEY=0x…` + `CARPE_X402_BUDGET_USD=2` | Pays per request in USDC on Base with the `carpe-session` scheme: **one** EIP-2612 permit to the Carpe escrow, reused for every call. The permit value is the remaining budget, so **the escrow can never pull more than `CARPE_X402_BUDGET_USD` in total** — re-signing never resets the cap (before re-signing, what the escrow really pulled under the last permit is read on-chain and counted if it exceeds what was billed), and spend is persisted in `~/.carpe-mcp/` across restarts. Before signing, the challenge's network, USDC address and escrow are checked against pinned values. |

The API key wins when both are set. Without either, free tools still work (catalogue, prices, quotes, markets, status).

Use a **dedicated** agent wallet holding only what you are willing to spend. The private key never leaves the process and is never logged.

## Spend guard

Before every paid call the server estimates its cost from free endpoints (`/router/quote` for tokens, `/pricing` for media, `/v1/video/quote` or the unpaid x402 challenge for video) and refuses locally — nothing is sent — if it exceeds:

- `CARPE_MAX_PER_CALL_USD` (default `0.50`), or
- what is left of `CARPE_MAX_SPEND_USD` for this session (default `5`).

A call whose cost cannot be estimated is assumed to cost the per-call limit. After each call the real cost from the operator's headers is added. `carpe_session_spend` shows the tally. `0` disables a limit.

Retries never risk double billing: paid calls are retried once only when the operator certainly did not run them (429 / capacity 503), or on `/router` where an `Idempotency-Key` makes a replay free. Never after a timeout or an ambiguous 5xx.

## Tools

| Group | Tools |
|---|---|
| Catalogue (free) | `carpe_list_models`, `carpe_model_details`, `carpe_pricing`, `carpe_quote`, `carpe_markets`, `carpe_status` |
| Account (free, API key) | `carpe_balance`, `carpe_usage_history`, `carpe_usage_summary`, `carpe_key_usage`, `carpe_routing_summary`, `carpe_rate_limits`, `carpe_purchases`, `carpe_topup_link` (checkout URL for a human), `carpe_session_spend`, `carpe_x402_status`, `carpe_revoke_this_key` (kill switch, destructive) |
| Text (paid) | `carpe_chat`, `carpe_embeddings`, `carpe_web_search`, `carpe_web_scrape` |
| Image (paid) | `carpe_image_generate`, `carpe_image_edit`, `carpe_image_multi_edit`, `carpe_image_upscale`, `carpe_image_status` |
| Audio | `carpe_tts`, `carpe_transcribe`, `carpe_voice_clone` (consent required) |
| Video / music | `carpe_video_generate`, `carpe_video_status`, `carpe_music_generate`, `carpe_music_status` |

Media inputs accept an `https://` URL, a `data:` URI, or (stdio only) a local path. Media outputs are returned inline when small (images ≤ 4 MiB, audio ≤ 8 MiB) and/or written to `CARPE_OUTPUT_DIR`; videos and music are always written to disk (the temp dir when `CARPE_OUTPUT_DIR` is unset), because the operator keeps a finished video only ~10 minutes and a `/v1` music track can be claimed only once.

`CARPE_READ_ONLY=1` removes every tool that can spend or change anything.

## Configuration

| Variable | Default | |
|---|---|---|
| `CARPE_API_KEY` | — | `cdm_…` key |
| `CARPE_X402_PRIVATE_KEY` / `CARPE_X402_BUDGET_USD` | — | x402 mode (budget ≥ 0.10, required with the key) |
| `CARPE_X402_RPC_URL` | `https://mainnet.base.org` | Reads the USDC permit nonce, balance and allowance to the escrow |
| `CARPE_MAX_SPEND_USD` / `CARPE_MAX_PER_CALL_USD` | `5` / `0.50` | Spend guard (`0` = off) |
| `CARPE_DEFAULT_ROUTE` | `carpe` | `carpe` (`/v1`) or `router` (`/router`) |
| `CARPE_DEFAULT_CHAT_MODEL` | `deepseek-v4-flash` | |
| `CARPE_OUTPUT_DIR` | — | Where media files are written |
| `CARPE_READ_ONLY` | `0` | `1` = free tools only |
| `CARPE_HTTP_TIMEOUT_MS` | `120000` | |
| `CARPE_MAX_MEDIA_BYTES` / `CARPE_MAX_VIDEO_BYTES` | 32 MiB / 64 MiB | Download caps |
| `CARPE_STATE_DIR` | `~/.carpe-mcp` | x402 spend state |
| `CARPE_MCP_HTTP` / `PORT` | `0` / `3333` | `1` starts the HTTP transport (same as `--http`), on `PORT` |
| `CARPE_MCP_HOST` | `127.0.0.1` | HTTP bind address; anything else requires `CARPE_MCP_AUTH_TOKEN` |
| `CARPE_MCP_AUTH_TOKEN` | — | Bearer token (≥ 16 chars) required by the HTTP transport off loopback |
| `CARPE_MCP_ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed on the HTTP transport |
| `CARPE_MCP_ALLOW_UNAUTHENTICATED_HTTP` | `0` | `1` drops the token requirement off loopback. **Only** behind a trusted proxy that authenticates callers: whoever reaches the server spends its credentials |

## HTTP mode

```bash
CARPE_API_KEY=cdm_… npx carpe-diem-mcp --http --port 3333     # http://127.0.0.1:3333/mcp
```

The HTTP server spends the configured credentials on behalf of whoever reaches it, so it binds to `127.0.0.1` by default; any other `CARPE_MCP_HOST` requires `CARPE_MCP_AUTH_TOKEN` (≥ 16 chars, sent as `Authorization: Bearer`). Browser origins are refused unless listed in `CARPE_MCP_ALLOWED_ORIGINS`. Local file inputs and private-network URLs are disabled in HTTP mode.

Carpe Diem refuses requests from sanctioned regions (HTTP 451). Buying inference from the United States is allowed.

## Development

```bash
npm install
npm test               # build + unit/integration tests against a mock operator
npm run test:contract  # free checks against the live API (catalogue, quotes, x402 challenges)
npm run test:e2e       # REAL calls, spends a few cents (CARPE_API_KEY in .env.local, capped at $0.90)
npx @modelcontextprotocol/inspector node dist/cli.js
```

Not covered yet: the Anthropic-shaped `/v1/messages` (use `carpe_chat`), JEV decisions, and key creation via wallet/email sessions (create keys on the website).

## Français

Serveur MCP pour Carpe Diem. Il donne à un agent l'accès aux modèles Venice (texte, image, vidéo, voix, musique, embeddings, recherche web) via la place de marché Carpe Diem.

- **Deux surfaces.** `route: "carpe"` passe par `/v1` : Carpe seul, toujours dans son TEE. `route: "router"` passe par `/router` : le marché le moins cher, éventuellement hors TEE. Chaque résultat indique le marché qui a servi la requête et si c'était un TEE.
- **Deux modes de paiement.** Avec une clé API `cdm_`, la dépense est facturée au compte. En x402, un seul permit USDC est signé, et sa valeur est un plafond dur côté blockchain.
- **Garde de dépense.** Le coût est estimé gratuitement avant chaque appel. L'appel est refusé localement au-delà de `CARPE_MAX_PER_CALL_USD` ou du budget de session `CARPE_MAX_SPEND_USD`.

## License

MIT. Not affiliated with Venice AI.
