#!/usr/bin/env node
/**
 * Entry point. Default: stdio (Claude Desktop / Claude Code / Cursor…).
 * `--http [--port N]`: Streamable HTTP on 127.0.0.1 (see transports/http.ts).
 */
import { ConfigError } from './config.js'
import { runHttp } from './transports/http.js'
import { runStdio } from './transports/stdio.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--version')) {
    const { loadConfig } = await import('./config.js')
    console.log(loadConfig({}).serverVersion)
    return
  }
  if (args.includes('--http') || process.env.CARPE_MCP_HTTP === '1') {
    const i = args.indexOf('--port')
    await runHttp({ port: i >= 0 ? Number(args[i + 1]) : Number(process.env.PORT ?? 3333) })
  } else {
    await runStdio()
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? `[carpe-mcp] configuration error: ${err.message}` : `[carpe-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
