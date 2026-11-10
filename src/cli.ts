#!/usr/bin/env node
/**
 * Entry point. Default: stdio (Claude Desktop / Claude Code / Cursor…).
 * `--http [--port N]`: Streamable HTTP on 127.0.0.1 (see transports/http.ts).
 * `--remote [--port N]`: hosted multi-user mode with OAuth (see transports/remote.ts).
 */
import { ConfigError, isRemoteEnv } from './config.js'
import { runHttp } from './transports/http.js'
import { runRemote } from './transports/remote.js'
import { runStdio } from './transports/stdio.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--version')) {
    const { loadConfig } = await import('./config.js')
    console.log(loadConfig({}).serverVersion)
    return
  }
  const i = args.indexOf('--port')
  const port = i >= 0 ? Number(args[i + 1]) : Number(process.env.PORT ?? 3333)
  if (args.includes('--remote')) process.env.CARPE_MCP_REMOTE = '1'
  if (isRemoteEnv()) {
    await runRemote({ port })
  } else if (args.includes('--http') || process.env.CARPE_MCP_HTTP === '1') {
    await runHttp({ port })
  } else {
    await runStdio()
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `[carpe-mcp] configuration error: ${err.message}` : `[carpe-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
