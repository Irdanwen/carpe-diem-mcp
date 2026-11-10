# Deploying the hosted server (`mcp.carpe-diem.xyz`)

One container running `carpe-diem-mcp --remote`, behind the host's Nginx, on the VPS that serves the Carpe Diem website. Lot B4 of `docs/CARPE_DIEM_PLAN_mcp-heberge.md` (Carpe-diem- repository).

The server holds no credential and no durable data: each user's OAuth access token is checked on every request and relayed to the operator, which maps it to that connector's own `cdm_` key. It can be rebuilt and replaced at any time; sessions are in memory, so a restart only makes clients re-initialize. The one thing a restart loses is the temporary media store: outputs too large to return inline, kept in memory for an hour and served at `https://mcp.carpe-diem.xyz/media/<id>` (see the main README, "Paid outputs are never thrown away"). Their links stop working (`404`) after a restart.

## Prerequisites

1. **DNS**: `mcp.carpe-diem.xyz` → this VPS (A/AAAA). `compte.carpe-diem.xyz` must be live too: it is the authorization server (`docs/oidc-provider.md`).
2. **Operator** deployed with the MCP connectors on: `MCP_OAUTH_ENABLED=true`, `OPERATOR_VAULT_KEY` and `OIDC_SIGNING_KEY` set, `MCP_OAUTH_RESOURCE=https://mcp.carpe-diem.xyz` (the default). Check: `curl -s https://compte.carpe-diem.xyz/.well-known/oauth-authorization-server | jq .issuer` → `"https://compte.carpe-diem.xyz"`.
3. Docker with the compose plugin, Nginx, certbot.

## Releases

A release is a tag `vX.Y.Z` **and** its commit, written in the release notes on GitHub (`Commit: <40-character sha>`). The procedures below take the commit from the release notes, check that the tag still names it (a tag can be moved; a commit cannot), then build the image and download every file from that commit.

## Install

Run as root, in bash. The block is a subshell with `set -euo pipefail`: the first failing command stops it (in particular before a half-installed Nginx site is enabled) without closing your SSH session.

```bash
(
set -euo pipefail
MCP_VERSION=X.Y.Z                                  # the release to install
MCP_SHA=<the 40-character commit of vX.Y.Z, from its release notes>
REPO=Lumen-labs-ch/carpe-diem-mcp

# 0. The tag must still name that commit; everything below uses the commit itself.
[[ $MCP_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "MCP_SHA must be a 40-character commit sha"; exit 1; }
TAG_SHA=$(git ls-remote "https://github.com/$REPO.git" "refs/tags/v$MCP_VERSION" "refs/tags/v$MCP_VERSION^{}" | awk 'END { print $1 }')
[ "$TAG_SHA" = "$MCP_SHA" ] || { echo "v$MCP_VERSION names ${TAG_SHA:-nothing}, not $MCP_SHA: stop."; exit 1; }
RAW="https://raw.githubusercontent.com/$REPO/$MCP_SHA/deploy"

# 1. Image, built from that commit (never from a working copy; BuildKit, the default builder, fetches a commit directly).
docker build -t "carpe-diem-mcp:$MCP_VERSION" "https://github.com/$REPO.git#$MCP_SHA"

# 2. Compose AND Nginx files, all from the same commit.
mkdir -p /opt/carpe-mcp && cd /opt/carpe-mcp
for f in compose.yml mcp.env.example nginx-http.conf nginx-mcp.carpe-diem.xyz.conf; do curl -fsSL "$RAW/$f" -o "$f"; done
if [ ! -e mcp.env ]; then
  install -m 600 mcp.env.example mcp.env
  sed -i "s/^CARPE_MCP_LOG_SALT=.*/CARPE_MCP_LOG_SALT=$(openssl rand -hex 32)/" mcp.env
fi
echo "MCP_VERSION=$MCP_VERSION" > .env

# 3. Start, then check locally.
docker compose up -d
for i in $(seq 30); do curl -fsS http://127.0.0.1:3333/health && break; sleep 1; done
curl -fsS http://127.0.0.1:3333/health                                 # {"ok":true}

# 4. Nginx + certificate. A configuration nginx refuses is removed again, so nginx keeps reloading.
cp nginx-http.conf /etc/nginx/conf.d/carpe-mcp.conf
cp nginx-mcp.carpe-diem.xyz.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz
ln -sf /etc/nginx/sites-available/mcp.carpe-diem.xyz /etc/nginx/sites-enabled/mcp.carpe-diem.xyz
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/mcp.carpe-diem.xyz /etc/nginx/conf.d/carpe-mcp.conf
  echo "nginx -t failed: the site was not enabled."; exit 1
fi
systemctl reload nginx
certbot --nginx -d mcp.carpe-diem.xyz
)
docker inspect --format '{{.State.Health.Status}}' carpe-mcp           # healthy (after ~30 s)
```

## Checks after install

```bash
curl -s https://mcp.carpe-diem.xyz/health
# {"ok":true}

curl -s https://mcp.carpe-diem.xyz/.well-known/oauth-protected-resource/mcp | jq '{resource, authorization_servers}'
# {"resource": "https://mcp.carpe-diem.xyz", "authorization_servers": ["https://compte.carpe-diem.xyz"]}

curl -si -X POST https://mcp.carpe-diem.xyz/mcp -H 'content-type: application/json' -d '{}' | grep -i '^www-authenticate'
# WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://mcp.carpe-diem.xyz/.well-known/oauth-protected-resource"

curl -s -o /dev/null -w '%{http_code}\n' https://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
# 404 (unknown or expired media id)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
# 403 (GET only)
```

Then the end-to-end checks of lot B6 (MCP Inspector in OAuth mode, a real claude.ai connector and a real ChatGPT server on a capped test account).

## Monitoring

- `https://mcp.carpe-diem.xyz/health` answers `{"ok":true}` and nothing else: add it to the same uptime/Telegram alerting as the website and the operator.
- The container has a Docker `HEALTHCHECK` and `restart: unless-stopped`.
- Logs: `docker logs carpe-mcp` (JSON lines: method, tool, status, duration, error code, HMAC of the user id; never prompts, outputs, tokens or media ids). Nginx: `/var/log/nginx/mcp.access.log`, without query strings, and `/media/<id>` logged as `/media/-` (the id is the capability). `/var/log/nginx/mcp.error.log` (level `warn`) does record the request line, **query string included**, of the requests it reports about (over a rate limit, container unreachable): MCP clients put nothing secret in the URL (the token travels in `Authorization`), and `/media/` logs only at `crit` there. Set `error_log … crit;` in the vhost to keep request lines out of it altogether.

## Memory

`compose.yml` sets `mem_limit: 1g` and a V8 heap of 576 MiB (`NODE_OPTIONS`). Measured on the application (macOS, Node 22, mock operator; Linux in a container is a little lower):

| | Default | Measured | Budgeted |
|---|---|---|---|
| Baseline (built CLI, idle) | | ~126 MiB RSS | ~130 MiB |
| Live sessions (`CARPE_MCP_MAX_SESSIONS`) | 200 | ~660 KiB of heap, ~760 KiB RSS each (300 sessions) | ~150 MiB |
| Request bodies in memory (`CARPE_MCP_BODY_BUDGET_MB`) | 128 MB | 3 × 39 MB bodies admitted out of 8 sent at once: heap +256 MiB, RSS +320 MiB (~107 MiB each) | ~320 MiB |
| Media store (`CARPE_MCP_MEDIA_STORE_MB`, outside the heap) | 256 MiB | | 256 MiB |
| **Total** | | | **~856 MiB of 1 GiB** |

Heap at most: ~40 (baseline) + ~130 (sessions) + ~256 (bodies) ≈ 430 MiB, under the 576 MiB cap. Raising one of the budgets means raising `mem_limit` (and, for sessions or bodies, `--max-old-space-size`) by as much.

## Update and rollback

An update re-syncs the compose file and both Nginx files from the new release's commit, not only the image. `mcp.env` is never overwritten: the new `mcp.env.example` is downloaded next to it and the variable names are compared.

```bash
(
set -euo pipefail
cd /opt/carpe-mcp
MCP_VERSION=X.Y.Z
MCP_SHA=<the 40-character commit of vX.Y.Z, from its release notes>
REPO=Lumen-labs-ch/carpe-diem-mcp
[[ $MCP_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "MCP_SHA must be a 40-character commit sha"; exit 1; }
TAG_SHA=$(git ls-remote "https://github.com/$REPO.git" "refs/tags/v$MCP_VERSION" "refs/tags/v$MCP_VERSION^{}" | awk 'END { print $1 }')
[ "$TAG_SHA" = "$MCP_SHA" ] || { echo "v$MCP_VERSION names ${TAG_SHA:-nothing}, not $MCP_SHA: stop."; exit 1; }
RAW="https://raw.githubusercontent.com/$REPO/$MCP_SHA/deploy"

docker build -t "carpe-diem-mcp:$MCP_VERSION" "https://github.com/$REPO.git#$MCP_SHA"

# Previous files kept for a rollback.
OLD=$(sed -n 's/^MCP_VERSION=//p' .env)
mkdir -p "previous/$OLD"
cp compose.yml /etc/nginx/conf.d/carpe-mcp.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz "previous/$OLD/"
for f in compose.yml mcp.env.example nginx-http.conf nginx-mcp.carpe-diem.xyz.conf; do curl -fsSL "$RAW/$f" -o "$f"; done

# New or removed variables (names only, no values printed): copy what you need into mcp.env by hand.
diff <(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' mcp.env | sort -u) <(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' mcp.env.example | sort -u) || true

# Nginx: certbot's lines (listen 443, certificate) live in the vhost, so they are put back after replacing it.
cp nginx-http.conf /etc/nginx/conf.d/carpe-mcp.conf
cp nginx-mcp.carpe-diem.xyz.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz
if ! certbot install --nginx --cert-name mcp.carpe-diem.xyz; then   # runs nginx -t and reloads
  cp "previous/$OLD/carpe-mcp.conf" /etc/nginx/conf.d/carpe-mcp.conf
  cp "previous/$OLD/mcp.carpe-diem.xyz" /etc/nginx/sites-available/mcp.carpe-diem.xyz
  cp "previous/$OLD/compose.yml" compose.yml
  nginx -t && systemctl reload nginx
  echo "Nginx update failed: previous configuration restored, container not updated."; exit 1
fi

echo "MCP_VERSION=$MCP_VERSION" > .env
docker compose up -d
)
```

Rollback: copy `previous/<old version>/compose.yml` back, the two Nginx files back to `/etc/nginx/` (then `nginx -t && systemctl reload nginx`), put the old version in `.env` and `docker compose up -d`. Old images stay until pruned. A restart (update or rollback) empties the temporary media store: its links answer `404` afterwards.

## Hardening in place

- Port 3333 published on loopback only; Nginx is the only way in, with per-IP request ceilings in front of token verification (`/mcp` and the metadata, `/media/`, `/health`; all answer `429`). Nginx replaces the client's `X-Forwarded-For` / `X-Real-IP` with the real address instead of passing them on.
- Read-only root filesystem, `/tmp` as a small tmpfs, all capabilities dropped, `no-new-privileges`, memory and PID limits. The code is owned by root and runs as `node`, under a minimal init (`init: true`) so a stop or an update does not wait 10 s for SIGKILL.
- Request bodies: a global and a per-user budget, a 30 s receive deadline, and the server's own `headersTimeout` / `requestTimeout` (see the main README, "Rate and memory limits").
- The base image is pinned by digest (`ARG NODE_IMAGE` in the `Dockerfile`).
- The server refuses to start with any credential in its environment (`CARPE_API_KEY`, `CARPE_X402_*`, `CARPE_MCP_AUTH_TOKEN`) or with `CARPE_OUTPUT_DIR`.
