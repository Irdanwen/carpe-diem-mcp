# Deploying the hosted server (`mcp.carpe-diem.xyz`)

One container running `carpe-diem-mcp --remote`, behind the host's Nginx, on the VPS that serves the Carpe Diem website. Lot B4 of `docs/CARPE_DIEM_PLAN_mcp-heberge.md` (Carpe-diem- repository).

The server holds no credential and no durable data: each user's OAuth access token is checked on every request and relayed to the operator, which maps it to that connector's own `cdm_` key. It can be rebuilt and replaced at any time; sessions are in memory, so a restart only makes clients re-initialize. The one thing a restart loses is the temporary media store: outputs too large to return inline, kept in memory for an hour and served at `https://mcp.carpe-diem.xyz/media/<id>` (see the main README, "Paid outputs are never thrown away"). Their links stop working (`404`) after a restart.

## Prerequisites

1. **DNS**: `mcp.carpe-diem.xyz` → this VPS (A/AAAA). `compte.carpe-diem.xyz` must be live too: it is the authorization server (`docs/oidc-provider.md`).
2. **Operator** deployed with the MCP connectors on: `MCP_OAUTH_ENABLED=true`, `OPERATOR_VAULT_KEY` and `OIDC_SIGNING_KEY` set, `MCP_OAUTH_RESOURCE=https://mcp.carpe-diem.xyz` (the default). Check: `curl -s https://compte.carpe-diem.xyz/.well-known/oauth-authorization-server | jq .issuer` → `"https://compte.carpe-diem.xyz"`.
3. Docker with the compose plugin, Nginx, certbot.

## Releases

A release is a tag `vX.Y.Z` **and** its commit, written in the release notes on GitHub (`Commit: <40-character sha>`). Pushing the tag runs `.github/workflows/release.yml`: once the tests pass and the npm version is staged, it creates the GitHub release of that tag with `Commit: <the sha the tag named when it was pushed>` in its notes (a re-run never rewrites them). The procedures below take the commit from the release notes, check that the tag still names it (a tag can be moved; a commit cannot), then build the image and download every file from that commit.

What this check gives, plainly: **consistency** between the tag and the release notes, so a tag moved after the release (by mistake, or by someone who did not also edit the notes) stops the procedure, and everything is built and downloaded from one fixed commit. It is **not an independent verification**: the same GitHub accounts (maintainers, or a stolen token with `contents: write`) can move the tag and edit the notes alike, and then both agree on the wrong commit. The next step would be signed tags (`git tag -s`, checked with `git verify-tag` against the maintainers' keys before building), or the sha published somewhere those accounts cannot write.

A tag pushed before the workflow created releases (`v0.2.0`) has none: install from the next release, or create it by hand from the sha the tag names (`git ls-remote https://github.com/Lumen-labs-ch/carpe-diem-mcp.git 'refs/tags/v0.2.0^{}' 'refs/tags/v0.2.0'`), with `gh release create v0.2.0 --verify-tag --notes "Commit: <sha>"`.

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

# 2. Compose AND Nginx files, all from the same commit, downloaded into a temporary directory first.
mkdir -p /opt/carpe-mcp && cd /opt/carpe-mcp
NEW=$(mktemp -d /opt/carpe-mcp/.new.XXXXXX)
trap 'rm -rf "$NEW"' EXIT
for f in compose.yml mcp.env.example nginx-http.conf nginx-mcp.carpe-diem.xyz.conf; do curl -fsSL "$RAW/$f" -o "$NEW/$f"; done
mv -f "$NEW"/* .
if [ ! -e mcp.env ]; then
  install -m 600 mcp.env.example mcp.env
  sed -i "s/^CARPE_MCP_LOG_SALT=.*/CARPE_MCP_LOG_SALT=$(openssl rand -hex 32)/" mcp.env
fi
echo "MCP_VERSION=$MCP_VERSION" > .env

# 3. Start, then check locally.
docker compose up -d
for i in $(seq 30); do curl -fsS http://127.0.0.1:3333/health && break; sleep 1; done
curl -fsS http://127.0.0.1:3333/health                                 # {"ok":true}

# 4. Nginx, then the certificate. The vhost is complete (its own port-80 block serving the ACME
#    challenge from /var/www/acme, the https lines): certbot only obtains and renews the certificate, by
#    webroot (no nginx plugin needed), and never edits it. Until the first certificate, a temporary
#    self-signed pair lets nginx load the https block. A configuration nginx refuses is removed again,
#    so nginx keeps reloading.
SSL=/etc/nginx/ssl/mcp.carpe-diem.xyz
mkdir -p /var/www/acme "$SSL"
[ -e "$SSL/fullchain.pem" ] || openssl req -x509 -nodes -newkey rsa:2048 -days 2 -subj /CN=mcp.carpe-diem.xyz \
  -keyout "$SSL/privkey.pem" -out "$SSL/fullchain.pem" 2>/dev/null
cp nginx-http.conf /etc/nginx/conf.d/carpe-mcp.conf
cp nginx-mcp.carpe-diem.xyz.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz
ln -sf /etc/nginx/sites-available/mcp.carpe-diem.xyz /etc/nginx/sites-enabled/mcp.carpe-diem.xyz
if ! nginx -t; then
  rm -f /etc/nginx/sites-enabled/mcp.carpe-diem.xyz /etc/nginx/conf.d/carpe-mcp.conf
  echo "nginx -t failed: the site was not enabled."; exit 1
fi
systemctl reload nginx
[ -e /etc/letsencrypt/live/mcp.carpe-diem.xyz/fullchain.pem ] ||
  certbot certonly --webroot -w /var/www/acme -d mcp.carpe-diem.xyz --deploy-hook 'systemctl reload nginx'
ln -sf /etc/letsencrypt/live/mcp.carpe-diem.xyz/fullchain.pem /etc/letsencrypt/live/mcp.carpe-diem.xyz/privkey.pem "$SSL/"
nginx -t && systemctl reload nginx
)
docker inspect --format '{{.State.Health.Status}}' carpe-mcp           # healthy (after ~30 s)
```

Do not run `certbot --nginx` (install mode) on this site: it would add its own port-80 block, which logs the whole request line (`/media/<id>` included), next to ours. The webroot `/var/www/acme` can be shared with the other sites of the host (it only holds challenge files for a few seconds).

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
curl -s -o /dev/null -w '%{http_code}\n' -I https://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
# 404 (HEAD is allowed: the same status and headers as GET, no body)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
# 403 (GET and HEAD only)

curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
# 301 https://mcp.carpe-diem.xyz/media/AAAAAAAAAAAAAAAAAAAAAA
tail -n 2 /var/log/nginx/mcp.access.log
# … "GET /media/- HTTP/1.1" 301 …  (port 80 too: the id is not logged)
```

Then the end-to-end checks of lot B6 (MCP Inspector in OAuth mode, a real claude.ai connector and a real ChatGPT server on a capped test account).

## Monitoring

- `https://mcp.carpe-diem.xyz/health` answers `{"ok":true}` and nothing else: add it to the same uptime/Telegram alerting as the website and the operator.
- The container has a Docker `HEALTHCHECK` and `restart: unless-stopped`.
- Logs: `docker logs carpe-mcp` (JSON lines: method, tool, status, duration, error code, HMAC of the user id; never prompts, outputs, tokens or media ids). Nginx: `/var/log/nginx/mcp.access.log`, without query strings, and `/media/<id>` logged as `/media/-` (the id is the capability), on port 443 and on the port-80 redirect alike (the vhost brings its own port-80 block, logged in the same format). `/var/log/nginx/mcp.error.log` (level `warn`) does record the request line, **query string included**, of the requests it reports about (over a rate limit, container unreachable): MCP clients put nothing secret in the URL (the token travels in `Authorization`), and `/media/` logs only at `crit` there. Set `error_log … crit;` in the vhost to keep request lines out of it altogether.

## Memory

`compose.yml` sets `mem_limit: 1536m` and a V8 heap of 576 MiB (`NODE_OPTIONS`, the same value as the `Dockerfile`'s default). Measured with the built CLI under that heap flag, a mock operator that holds each call 3 s so they overlap, and the peak RSS of the process sampled every 50 ms (macOS, Node 24; Linux in a container is a little lower):

| | Default | Measured | Budgeted |
|---|---|---|---|
| Baseline (built CLI, idle) | | ~125 MiB RSS | ~125 MiB |
| Live sessions (`CARPE_MCP_MAX_SESSIONS`) | 200 | 200 sessions: RSS +210 MiB (~1.05 MiB each), ~660 KiB of heap each | ~210 MiB |
| Request bodies being processed (`CARPE_MCP_BODY_BUDGET_MB`) | 64 MB | `carpe_transcribe` of a 19 MiB file (25.3 MiB body): ~160–167 MiB RSS each, 2 to 4 at once (~195 for the very first call, which also loads code); a 38.7 MiB video input passed through to the operator: ~200–220 MiB each. So ~6.7 × the body size, heap ≤ 3 × | 64 MB × 6.7 ≈ 430 MiB |
| Media store (`CARPE_MCP_MEDIA_STORE_MB`, outside the heap) | 256 MiB | stored outputs and the room held for downloads in flight; a download read without `Content-Length` is held twice for a moment while its chunks are joined | 2 × 256 = 512 MiB |
| **Total** | | | **~1277 MiB of 1536** (~260 MiB of headroom) |

Heap at most: ~40 (baseline) + ~130 (sessions) + ~185 (bodies, 3 × 61 MiB) ≈ 355 MiB, under the 576 MiB cap. The value count bounds what a body of small JSON values holds (see the main README, `CARPE_MCP_MAX_JSON_VALUES`: ~6 MiB at the limit, charged to the body budget).

With the previous defaults (128 MB of bodies, `mem_limit: 1g`), four accounts each sending a 19 MiB transcription (100 MB, within the budget) took the process to ~950 MiB RSS with 200 sessions, before any media stored: the container was killed. Raising a budget means raising `mem_limit` by what it costs (bodies: ~6.7 × the MB added; media store: 2 × the MiB added) and, for sessions or bodies, `--max-old-space-size` too (in `compose.yml`).

## Update and rollback

An update re-syncs the compose file and both Nginx files from the new release's commit, not only the image. Every file is downloaded into a temporary directory first: a download failing halfway leaves the installation as it was. Each file then replaces the old one by a rename (`mv` within one filesystem: never a half-written file). The vhost is complete as published (certbot only renews the certificate), so it is replaced as is. `mcp.env` is never overwritten: the new `mcp.env.example` comes next to it and the variable names are compared. After `docker compose up -d`, the procedure waits for `/health` **and** the container's Docker health; if they do not come, it stops with an error and you roll back (below).

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

# 1. Everything fetched first: the image, and the four files into a temporary directory.
docker build -t "carpe-diem-mcp:$MCP_VERSION" "https://github.com/$REPO.git#$MCP_SHA"
NEW=$(mktemp -d /opt/carpe-mcp/.new.XXXXXX)
trap 'rm -rf "$NEW"' EXIT
for f in compose.yml mcp.env.example nginx-http.conf nginx-mcp.carpe-diem.xyz.conf; do curl -fsSL "$RAW/$f" -o "$NEW/$f"; done

# New or removed variables (names only, no values printed): copy what you need into mcp.env by hand.
diff <(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' mcp.env | sort -u) <(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$NEW/mcp.env.example" | sort -u) || true

# 2. Previous files kept for a rollback.
OLD=$(sed -n 's/^MCP_VERSION=//p' .env)
mkdir -p "previous/$OLD"
cp compose.yml .env /etc/nginx/conf.d/carpe-mcp.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz "previous/$OLD/"

# 3. Nginx: each file replaced by a rename (the .new names are not loaded by nginx); refused by nginx -t →
#    the previous files are put back and the container is left as it is.
cp "$NEW/nginx-http.conf" /etc/nginx/conf.d/carpe-mcp.conf.new
mv -f /etc/nginx/conf.d/carpe-mcp.conf.new /etc/nginx/conf.d/carpe-mcp.conf
cp "$NEW/nginx-mcp.carpe-diem.xyz.conf" /etc/nginx/sites-available/mcp.carpe-diem.xyz.new
mv -f /etc/nginx/sites-available/mcp.carpe-diem.xyz.new /etc/nginx/sites-available/mcp.carpe-diem.xyz
if ! nginx -t; then
  cp "previous/$OLD/carpe-mcp.conf" /etc/nginx/conf.d/carpe-mcp.conf
  cp "previous/$OLD/mcp.carpe-diem.xyz" /etc/nginx/sites-available/mcp.carpe-diem.xyz
  nginx -t && systemctl reload nginx
  echo "nginx -t refused the new configuration: previous one restored, container not updated."; exit 1
fi
systemctl reload nginx
# From here Nginx serves the new configuration: any failure below (docker compose included) must lead to
# the rollback, so say it instead of stopping silently.
trap 'echo "Update to v$MCP_VERSION failed after Nginx was reloaded: roll back to $OLD (next block)."' ERR

# 4. Compose file and version (renames), then the container.
mv -f "$NEW/compose.yml" compose.yml
mv -f "$NEW/mcp.env.example" mcp.env.example
echo "MCP_VERSION=$MCP_VERSION" > .env.new && mv -f .env.new .env
docker compose up -d

# 5. Healthy? /health locally and Docker's own healthcheck (its first run is ~30 s after the start).
for i in $(seq 60); do
  if curl -fsS http://127.0.0.1:3333/health >/dev/null 2>&1 &&
     [ "$(docker inspect --format '{{.State.Health.Status}}' carpe-mcp)" = healthy ]; then
    curl -fsS https://mcp.carpe-diem.xyz/health && echo && echo "v$MCP_VERSION is up."; exit 0
  fi
  sleep 2
done
docker compose logs --tail 50 carpe-mcp
echo "v$MCP_VERSION is not healthy after 2 minutes: roll back to $OLD (next block)."; exit 1
)
```

Rollback (the previous version's files are in `previous/<version>/`, its image is still there until pruned):

```bash
(
set -euo pipefail
cd /opt/carpe-mcp
OLD=<the version to go back to: a directory under previous/>
cp "previous/$OLD/carpe-mcp.conf" /etc/nginx/conf.d/carpe-mcp.conf
cp "previous/$OLD/mcp.carpe-diem.xyz" /etc/nginx/sites-available/mcp.carpe-diem.xyz
nginx -t && systemctl reload nginx
cp "previous/$OLD/compose.yml" compose.yml
cp "previous/$OLD/.env" .env
docker compose up -d
for i in $(seq 60); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' carpe-mcp)" = healthy ] && curl -fsS http://127.0.0.1:3333/health && exit 0
  sleep 2
done
echo "still not healthy: docker compose logs carpe-mcp"; exit 1
)
```

A restart (update or rollback) empties the temporary media store: its links answer `404` afterwards.

## Hardening in place

- Port 3333 published on loopback only; Nginx is the only way in, with per-IP request ceilings in front of token verification (`/mcp` and the metadata, `/media/`, `/health`; all answer `429`). Nginx replaces the client's `X-Forwarded-For` / `X-Real-IP` with the real address instead of passing them on.
- Read-only root filesystem, `/tmp` as a small tmpfs, all capabilities dropped, `no-new-privileges`, memory and PID limits. The code is owned by root and runs as `node`, under a minimal init (`init: true`) so a stop or an update does not wait 10 s for SIGKILL.
- Request bodies: a global and a per-user budget (64 MB and 48 MB by default), a 30 s receive deadline, the server's own `headersTimeout` / `requestTimeout`, and a count of JSON values before any parsing (`413` above 100 000, so a body of millions of tiny values never reaches `JSON.parse`). Tool calls in progress are capped per user, each call of a batch counted. See the main README, "Rate and memory limits".
- The base image is pinned by digest (`ARG NODE_IMAGE` in the `Dockerfile`).
- The server refuses to start with any credential in its environment (`CARPE_API_KEY`, `CARPE_X402_*`, `CARPE_MCP_AUTH_TOKEN`) or with `CARPE_OUTPUT_DIR`.
