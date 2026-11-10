# Deploying the hosted server (`mcp.carpe-diem.xyz`)

One container running `carpe-diem-mcp --remote`, behind the host's Nginx, on the VPS that serves the Carpe Diem website. Lot B4 of `docs/CARPE_DIEM_PLAN_mcp-heberge.md` (Carpe-diem- repository).

The server holds no credential and no data: each user's OAuth access token is checked on every request and relayed to the operator, which maps it to that connector's own `cdm_` key. It can be rebuilt and replaced at any time; sessions are in memory, so a restart only makes clients re-initialize.

## Prerequisites

1. **DNS**: `mcp.carpe-diem.xyz` → this VPS (A/AAAA). `compte.carpe-diem.xyz` must be live too: it is the authorization server (`docs/oidc-provider.md`).
2. **Operator** deployed with the MCP connectors on: `MCP_OAUTH_ENABLED=true`, `OPERATOR_VAULT_KEY` and `OIDC_SIGNING_KEY` set, `MCP_OAUTH_RESOURCE=https://mcp.carpe-diem.xyz` (the default). Check: `curl -s https://compte.carpe-diem.xyz/.well-known/oauth-authorization-server | jq .issuer` → `"https://compte.carpe-diem.xyz"`.
3. Docker with the compose plugin, Nginx, certbot.

## Install

```bash
# 1. Image, built from a release tag (never from a working copy).
MCP_VERSION=0.2.0
docker build -t carpe-diem-mcp:$MCP_VERSION "https://github.com/Lumen-labs-ch/carpe-diem-mcp.git#v$MCP_VERSION"

# 2. Compose files.
mkdir -p /opt/carpe-mcp && cd /opt/carpe-mcp
curl -fsSLO "https://raw.githubusercontent.com/Lumen-labs-ch/carpe-diem-mcp/v$MCP_VERSION/deploy/compose.yml"
curl -fsSL "https://raw.githubusercontent.com/Lumen-labs-ch/carpe-diem-mcp/v$MCP_VERSION/deploy/mcp.env.example" -o mcp.env
chmod 600 mcp.env
sed -i "s/^CARPE_MCP_LOG_SALT=.*/CARPE_MCP_LOG_SALT=$(openssl rand -hex 32)/" mcp.env
echo "MCP_VERSION=$MCP_VERSION" > .env

# 3. Start, then check locally.
docker compose up -d
curl -s http://127.0.0.1:3333/health                                   # {"ok":true}
docker inspect --format '{{.State.Health.Status}}' carpe-mcp           # healthy

# 4. Nginx + certificate.
cp nginx-http.conf /etc/nginx/conf.d/carpe-mcp.conf                     # from deploy/ of the same tag
cp nginx-mcp.carpe-diem.xyz.conf /etc/nginx/sites-available/mcp.carpe-diem.xyz
ln -s /etc/nginx/sites-available/mcp.carpe-diem.xyz /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d mcp.carpe-diem.xyz
```

## Checks after install

```bash
curl -s https://mcp.carpe-diem.xyz/health
# {"ok":true}

curl -s https://mcp.carpe-diem.xyz/.well-known/oauth-protected-resource/mcp | jq '{resource, authorization_servers}'
# {"resource": "https://mcp.carpe-diem.xyz", "authorization_servers": ["https://compte.carpe-diem.xyz"]}

curl -si -X POST https://mcp.carpe-diem.xyz/mcp -H 'content-type: application/json' -d '{}' | grep -i '^www-authenticate'
# WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://mcp.carpe-diem.xyz/.well-known/oauth-protected-resource"
```

Then the end-to-end checks of lot B6 (MCP Inspector in OAuth mode, a real claude.ai connector and a real ChatGPT server on a capped test account).

## Monitoring

- `https://mcp.carpe-diem.xyz/health` answers `{"ok":true}` and nothing else: add it to the same uptime/Telegram alerting as the website and the operator.
- The container has a Docker `HEALTHCHECK` and `restart: unless-stopped`.
- Logs: `docker logs carpe-mcp` (JSON lines: method, tool, status, duration, error code, HMAC of the user id; never prompts, outputs or tokens). Nginx: `/var/log/nginx/mcp.access.log`, without query strings.

## Update and rollback

```bash
cd /opt/carpe-mcp
MCP_VERSION=0.2.1
docker build -t carpe-diem-mcp:$MCP_VERSION "https://github.com/Lumen-labs-ch/carpe-diem-mcp.git#v$MCP_VERSION"
echo "MCP_VERSION=$MCP_VERSION" > .env && docker compose up -d
# Rollback: put the previous version back in .env and `docker compose up -d` (old images stay until pruned).
```

## Hardening in place

- Port 3333 published on loopback only; Nginx is the only way in, with a per-IP request ceiling in front of token verification.
- Read-only root filesystem, `/tmp` as a small tmpfs, all capabilities dropped, `no-new-privileges`, memory and PID limits. The code is owned by root and runs as `node`.
- The base image is pinned by digest (`ARG NODE_IMAGE` in the `Dockerfile`).
- The server refuses to start with any credential in its environment (`CARPE_API_KEY`, `CARPE_X402_*`, `CARPE_MCP_AUTH_TOKEN`) or with `CARPE_OUTPUT_DIR`.
