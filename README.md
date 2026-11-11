# carpe-diem-mcp

> Model Context Protocol server for **[Carpe Diem](https://carpe-diem.xyz)**: Venice AI models (text, image, video, speech, music, embeddings, web search), bought on the Carpe Diem marketplace — usually well below Venice list prices — with best-price routing, hard spend limits and optional **x402** pay-per-call from a wallet on Base.

Works with Claude Code, Claude Desktop, Cursor, Cline, LM Studio and any MCP host (Node.js ≥ 20) — and, hosted by Carpe Diem with nothing to install, with **claude.ai and ChatGPT**: `https://mcp.carpe-diem.xyz/mcp`.

- **33 tools**, 3 resources (`carpe://models`, `carpe://pricing`, `carpe://markets`), 3 prompts.
- Every result reports **the exact cost billed** and **who served it** (and whether it was a TEE).
- **Spend guard** in every mode: per-call and per-session limits checked *before* sending, from free quotes.
- Every tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`.

## Quick start

**claude.ai or ChatGPT: nothing to install.** Add `https://mcp.carpe-diem.xyz/mcp` as a custom connector, sign in with your Carpe Diem account (a code sent by email) and choose a daily spending limit. No API key: the connector gets its own, billed to your credits and revocable in **API → Keys**.

- **Claude** (web, desktop, mobile): **Customize → Connectors → + Add → Add custom connector**, paste the URL, **Add**, then **Connect**. On Team and Enterprise, an Owner adds it under **Organization settings → Connectors**. In a chat: **+ → Connectors**.
- **ChatGPT** (web, developer mode on Plus, Pro, Business, Enterprise, Edu): **Settings → Apps → Advanced settings → Developer mode**, then **Create app** with the URL and **OAuth**.

Step by step, and what differs from the local server (29 tools, no disk, credits only): **[carpe-diem.xyz/docs/integrations#web-assistants](https://carpe-diem.xyz/docs/integrations#web-assistants)**. The hosted connector accepts sign-ins from claude.ai and ChatGPT only; every other client runs the server locally:

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

Zed, Cline, Goose, Continue, LM Studio and others, with use cases and costs: **[carpe-diem.xyz/docs/integrations](https://carpe-diem.xyz/docs/integrations#mcp-install)**. ChatGPT and claude.ai only accept remote MCP servers with OAuth: use the hosted connector above.

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
| **x402** (no account) | `CARPE_X402_PRIVATE_KEY=0x…` + `CARPE_X402_BUDGET_USD=2` | Pays per request in USDC on Base with the `carpe-session` scheme: **one** EIP-2612 permit to the Carpe escrow, reused for every call. The operator pulls from the allowance already open before it applies a new permit, and a permit replaces the allowance instead of adding to it. So each permit is signed for the budget minus what was spent and minus the allowance still open to the escrow (both read at one block), and **the escrow can never pull more than `CARPE_X402_BUDGET_USD` in total through this server's permits**. "Spent" is what was billed, raised to what the chain shows was really pulled, so a relay that under-reports prices and forces re-signs gets nothing more. Two limits: the cap is the highest budget this wallet has had, since lowering it does not shrink an allowance already open or a permit already signed (valid 30 days); and spend lives in `~/.carpe-mcp/` (`CARPE_STATE_DIR`), so deleting that file starts a new budget. If the wallet already lets the escrow pull through an allowance this server did not grant (an `approve` or a permit from another app), nothing is signed until you revoke it. Before signing, the challenge's network, USDC address and escrow are checked against pinned values, and the RPC's chainId against the network. |

The API key wins when both are set. Without either, free tools still work (catalogue, prices, quotes, markets, status).

Use a **dedicated** agent wallet holding only what you are willing to spend, and give it to **this server only**. The cap is computed from the permits this server signed: a permit to the Carpe escrow signed elsewhere with the same wallet is detected when it raises the allowance above what this server could have left open, but one that sets it lower looks like this server's own and goes unnoticed, and the cap can then under-count what was pulled. The private key never leaves the process and is never logged.

The permit nonce and allowance are read at one pinned block; when the RPC node serving the read does not know that block yet (an RPC spread over several nodes), the read is retried once, 2 s later, and any other failure refuses to sign. When the operator's dry run of the pull fails (`X402_PREFLIGHT_FAILED`) because the USDC balance is too low, the server does not re-sign (a new permit would not help) and the error says to fund the wallet; any other dry-run failure drops the cached permit and fetches a fresh challenge, once.

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
| `CARPE_X402_RPC_URL` | `https://mainnet.base.org` | Reads the chainId (checked before signing), the USDC permit nonce and allowance to the escrow (at one block), and the balance |
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
| `CARPE_MCP_REMOTE` | `0` | `1` = hosted multi-user mode (same as `--remote`), see [Remote mode](#remote-mode-hosted) |

## HTTP mode

```bash
CARPE_API_KEY=cdm_… npx carpe-diem-mcp --http --port 3333     # http://127.0.0.1:3333/mcp
```

The HTTP server spends the configured credentials on behalf of whoever reaches it, so it binds to `127.0.0.1` by default; any other `CARPE_MCP_HOST` requires `CARPE_MCP_AUTH_TOKEN` (≥ 16 chars, sent as `Authorization: Bearer`). Browser origins are refused unless listed in `CARPE_MCP_ALLOWED_ORIGINS`. Local file inputs and private-network URLs are disabled in HTTP mode.

Carpe Diem refuses requests from sanctioned regions (HTTP 451). Buying inference from the United States is allowed.

## Remote mode (hosted)

> **Live** at `https://mcp.carpe-diem.xyz/mcp` since 2026-11-11, for claude.ai and ChatGPT (the authorization server, `compte.carpe-diem.xyz`, accepts sign-ins from those two clients only). This section describes the server side, to review it or run your own against an OAuth issuer that behaves as described below; to *use* it, see [Quick start](#quick-start).

```bash
CARPE_MCP_HOST=127.0.0.1 npx carpe-diem-mcp --remote --port 3333   # behind a TLS reverse proxy
```

`--remote` (or `CARPE_MCP_REMOTE=1`) turns the server into an OAuth 2.1 **protected resource**, one process for many users:

- **No credential on the server.** It refuses to start if `CARPE_API_KEY`, `CARPE_X402_PRIVATE_KEY`, `CARPE_X402_BUDGET_USD`, `CARPE_MCP_AUTH_TOKEN` or `CARPE_OUTPUT_DIR` is set. Each user signs in on the authorization server; their access token is relayed verbatim (`Authorization: Bearer`) to the operator on account and paid routes, and the operator resolves it to the connector's own `cdm_` key (usage per connector in **API → Usage**, revocation in **API → Keys**, daily cap chosen at consent). Public reads (models, prices, quotes) are sent without it, so they all count on the operator's anonymous rate limit for the server's IP (catalogue reads are cached for that reason; price quotes are not). The operator now accepts connector tokens on those routes too, counted per account: sending them is the next step here.
- **Discovery.** `GET /.well-known/oauth-protected-resource` (also under `/mcp`, RFC 9728) names the issuer and the scopes. A request without a valid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`, which starts the OAuth flow in the client.
- **Token checks, on every request.** JWT signature against the issuer's JWKS (ES256 by default, cached, refetched on an unknown `kid`), `iss` = the issuer, `aud` contains this server's URL (RFC 8707; a token minted for anything else is refused), header `typ: at+jwt` (RFC 9068: an id_token is refused), `exp` enforced to the second (as the operator does), `nbf` / `iat` with 30 s of skew, a `sub`.
- **Scopes.** `carpe:inference` for paid tools (and their job-status tools), `carpe:account.read` for balance, usage and the top-up link. Tools a token does not cover are hidden; calling one answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` so the client can ask for more.
- **Revocation.** When the operator refuses a relayed token as invalid (the connector was revoked in **API → Keys**), the server answers that token `401 invalid_token` itself until it expires, so the client signs in again instead of keeping a session whose every call fails.
- **Per-user isolation.** A session belongs to the `sub` that opened it (another account presenting its id gets `403`). Each user has their own spend guard (`CARPE_MAX_PER_CALL_USD` per call; `CARPE_MAX_SPEND_USD` per UTC day, off by default because the connector's daily cap on the operator is authoritative), their own rate limit and a cap on live sessions.
- **Rate and memory limits.** Per user: a token bucket in which every message of a JSON-RPC batch counts (a batch larger than the burst is refused with `400`), and at most `CARPE_MCP_MAX_INFLIGHT_PER_USER` tool calls being processed at once (`429` + `Retry-After`). That cap is counted per JSON-RPC message, not per HTTP request: the messages of a batch run in parallel, so each `tools/call` in it counts as one (a batch with more tool calls than the cap is refused with `400`), and the other requests of a body count as one more, together. A body of notifications or responses only (`notifications/cancelled`…) is never refused by it, so a client at the cap can still cancel; once every request of a POST is answered or cancelled, the server ends that POST's stream (the SDK never answers a cancelled request), which frees its slots. The GET event stream does not count. For everyone together: a budget of request-body bytes held in memory, counted from `Content-Length` before the body is read (a body without `Content-Length` counts as the 40 MB per-request maximum), `503` + `Retry-After` when it is spent, of which each user may hold at most `CARPE_MCP_BODY_BUDGET_PER_USER_MB` (`429` beyond); a body must be fully received within `CARPE_MCP_BODY_TIMEOUT_S` (`408`, and its bytes are freed), so a stalled upload cannot hold the budget; and a cap on live sessions (about 1 MiB of memory each). What a body costs once parsed depends on its number of JSON values, not its size (40 MB of `[{},{},…]` is ~14 million objects, more than the whole heap): before parsing, a linear scan counts the `{`, `[` and `,` outside strings, and a body with more than `CARPE_MCP_MAX_JSON_VALUES` is refused with `413` without being parsed. A media `data:` URI is one string, so it counts for nothing; the values of an accepted body are charged to the body budget on top of its bytes (16 bytes each). A compressed body (`Content-Encoding`) is inflated before parsing and counts as the 40 MB maximum. The public catalogue reads (`/v1/models`, `/router/models`, `/pricing`, `/router/markets`) are cached for 60 s and shared by all sessions.
- **Removed tools:** `carpe_revoke_this_key` (revoke the connector on the website), `carpe_voice_clone` (consent is collected on the website), `carpe_x402_status` (no wallet), `carpe_topup_link` (connector tokens cannot start a payment; top up on the website). 29 tools remain.
- **No disk.** Media inputs are `https://` URLs (public hosts only, redirects included) or `data:` URIs; local paths are refused. Images up to 4 MiB and audio up to 8 MiB come back inline. A larger image comes back as a link from the operator's `/v1/image/share` (up to 10 MiB, about 1 hour). A video or a track the operator hands over as a link (a Carpe video stays about 10 minutes) comes back as that link.
- **Paid outputs are never thrown away.** Anything else too large to return inline (speech above 8 MiB, a router video served as a file by Surplus, a track above 8 MiB, an image the share refused or above 10 MiB) is kept **in memory** by the server for **one hour** and returned as a link `CARPE_MCP_PUBLIC_URL/media/<id>` with its expiry (`expires_at`). The link needs no sign-in: its id is 128 random bits and goes only into the result of the user who paid; it is served with its content type (image, audio or video only; anything else as an `application/octet-stream` attachment), `Content-Disposition`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and `404` once expired. `GET` and `HEAD` are served (`HEAD`: the same status and headers, `Content-Length` included, no body), nothing else (`403` at Nginx). A job's output is stored once per user: polling the same finished job again returns the same link and expiry, without asking the operator again. The store is bounded by `CARPE_MCP_MEDIA_STORE_MB`, and each user by a share of it, `CARPE_MCP_MEDIA_STORE_PER_USER_MB` (stored files and room held, together), so one user cannot fill it for the others. When it (or the user's share) is full:
  - a call whose output comes back only once (speech, a synchronous image or upscale, a Carpe-served track) is refused **before** anything is paid or fetched (`MEDIA_STORE_FULL`): room for its largest possible output (32 MiB for speech and music, 16 MiB for a synchronous image) is held while it runs;
  - a router video (which Surplus hands over as the file itself, up to `CARPE_MAX_VIDEO_BYTES`, 64 MiB) is not downloaded without room for it either: each retrieve holds that much first, and a full store answers `MEDIA_STORE_FULL` before downloading, naming the job, which stays retrievable on the operator;
  - an output the operator serves again (queued image) is an error that names the job: the user polls it again later and gets it. A queued `/v1` image is released on the operator (`/complete`) only after it was delivered.

  Concurrent polls of the same job by the same user (a batch, several sessions) share one retrieve: one download, one reservation, one stored copy.
- **Logs** are JSON lines on stderr with the method, tool name, status, duration, error code and an HMAC of the user's `sub`: never prompts, arguments, outputs, error messages, tokens or media ids. `/health` answers `{"ok":true}` and nothing else.

| Variable | Default | |
|---|---|---|
| `CARPE_OAUTH_ISSUER` | `https://compte.carpe-diem.xyz` | Authorization server (`iss` of every token) |
| `CARPE_MCP_PUBLIC_URL` | `https://mcp.carpe-diem.xyz` | This server's resource URL: advertised in the metadata, required in the token `aud` |
| `CARPE_OAUTH_JWKS_URL` | from the issuer metadata | Signing keys (RFC 8414 `jwks_uri`, then OpenID discovery) |
| `CARPE_OAUTH_ALGORITHMS` / `CARPE_OAUTH_CLOCK_SKEW_S` | `ES256` / `30` | Accepted JWS algorithms (asymmetric only), clock skew on `nbf` / `iat` (never on `exp`) |
| `CARPE_MCP_RATE_PER_MIN` / `CARPE_MCP_RATE_BURST` | `120` / `30` | Requests per user (token bucket) |
| `CARPE_MCP_MAX_SESSIONS_PER_USER` / `CARPE_MCP_MAX_SESSIONS` | `5` / `200` | Live sessions (about 1 MiB of memory each); a user's least recently used session is closed beyond the cap |
| `CARPE_MCP_MAX_INFLIGHT_PER_USER` | `4` | Tool calls of one user being processed at once, each `tools/call` of a batch counted (`429` beyond; a batch with more is refused with `400`); notifications never count |
| `CARPE_MCP_BODY_BUDGET_MB` | `64` | Request-body bytes held in memory, all users together (`503` beyond); at least `40`, the per-request maximum. A body being processed holds ~6.7 times its size (`deploy/README.md`, "Memory"): raise `mem_limit` with it |
| `CARPE_MCP_BODY_BUDGET_PER_USER_MB` | `48` | Each user's share of it (`429` beyond): one largest request and a few small ones; at least `40` |
| `CARPE_MCP_BODY_TIMEOUT_S` | `30` | Delay to receive a whole request body (`408` beyond; 40 MB needs ~1.4 MB/s) |
| `CARPE_MCP_MAX_JSON_VALUES` | `100000` | JSON values of one request body (`{`, `[` and `,` outside strings), counted before parsing (`413` beyond). ~64 bytes of heap per parsed value: ~6 MiB at the limit; a real request has at most a few thousand. At least `100` |
| `CARPE_MCP_LOG_SALT` | random per process | Key of the hashed user id in the logs (set it to correlate across restarts) |
| `CARPE_MCP_MEDIA_STORE_MB` | `256` | Memory budget of the temporary media store (stored outputs plus room held for one-shot calls in flight); at least the largest single output (64) |
| `CARPE_MCP_MEDIA_STORE_PER_USER_MB` | `96` | Each user's share of the media store, room held included (the largest output, 64, plus one synchronous call); at least `64` |

`CARPE_MCP_HOST`, `PORT` and `CARPE_MCP_ALLOWED_ORIGINS` apply as in HTTP mode. Run it behind a TLS reverse proxy; http URLs are accepted for the issuer and the resource only on loopback (tests).

Deployment (Docker image built from a release's commit, compose file, Nginx vhost with `/media/`, memory sizing, checks, monitoring, update and rollback): [`deploy/README.md`](deploy/README.md). The release workflow writes each release's commit in its notes (`Commit: <sha>`), and the procedures check that the tag still names it: a consistency check between tag and notes, not an independent verification (both are editable by the same accounts; signed tags would be the next step).

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
- **Deux modes de paiement.** Avec une clé API `cdm_`, la dépense est facturée au compte. En x402, un permit USDC est signé pour ce qui reste du budget, allowance encore ouverte comprise : l'escrow ne peut pas prélever plus que le budget au total. Utilisez un wallet dédié à ce serveur : un permit signé ailleurs avec le même wallet peut passer inaperçu.
- **Garde de dépense.** Le coût est estimé gratuitement avant chaque appel. L'appel est refusé localement au-delà de `CARPE_MAX_PER_CALL_USD` ou du budget de session `CARPE_MAX_SPEND_USD`.
- **Connecteur hébergé pour claude.ai et ChatGPT.** En ligne depuis le 11/11/2026 : `https://mcp.carpe-diem.xyz/mcp`. Rien à installer : on l'ajoute comme connecteur personnalisé (Claude : Customize → Connectors → Add custom connector ; ChatGPT : mode développeur → Create app, OAuth), on se connecte avec son compte Carpe Diem (code par email) et on choisit un plafond de dépense quotidien. Mode d'emploi : [carpe-diem.xyz/docs/fr/integrations](https://carpe-diem.xyz/docs/fr/integrations#web-assistants). Les autres clients (Claude Code, Codex, Cursor, VS Code…) utilisent le serveur local avec une clé.
- **Mode distant.** C'est ce connecteur : `--remote` sert plusieurs utilisateurs derrière OAuth. Le serveur ne détient aucune clé : il relaie le jeton de chaque utilisateur à l'operator, n'écrit rien sur disque et ne journalise ni prompts ni jetons.

## License

MIT. Not affiliated with Venice AI.
