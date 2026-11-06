import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from '../server.js'

export async function runStdio(): Promise<void> {
  const { server, client } = buildServer({ allowLocalFiles: true })
  await server.connect(new StdioServerTransport())
  // stderr only: stdout carries the protocol.
  console.error(`[carpe-mcp] ready on stdio — payment mode: ${client.mode}`)
}
