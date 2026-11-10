# Hosted MCP server (remote mode) — https://mcp.carpe-diem.xyz/mcp
# Build from a release's commit (checked against its tag), never from a working copy:
#   docker build -t carpe-diem-mcp:<version> https://github.com/Lumen-labs-ch/carpe-diem-mcp.git#<commit sha>
# See deploy/README.md ("Releases", "Install").

ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
# The V8 heap is capped (sessions + parsed bodies, see deploy/README.md "Memory"); deploy/compose.yml
# sets the same value next to its mem_limit.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=576 \
    CARPE_MCP_REMOTE=1 \
    CARPE_MCP_HOST=0.0.0.0 \
    PORT=3333
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json ./
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
# Code owned by root, process runs as the unprivileged `node` user: it cannot rewrite itself.
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/cli.js", "--remote"]
