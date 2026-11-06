/** Spawn the built server over stdio and talk to it like an MCP host would. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function connect(env: Record<string, string | undefined>): Promise<Client> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, ...env })) if (v !== undefined) clean[k] = v
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'cli.js')], env: clean, stderr: 'pipe' })
  const client = new Client({ name: 'carpe-mcp-e2e', version: '0.0.0' })
  await client.connect(transport)
  return client
}

export interface CallOutcome {
  isError: boolean
  text: string
  structured: Record<string, any>
  content: any[]
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as any
  return {
    isError: !!r.isError,
    text: (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
    structured: r.structuredContent ?? {},
    content: r.content ?? [],
  }
}
