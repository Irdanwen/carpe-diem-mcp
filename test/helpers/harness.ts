import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.js'
import { buildServer, type BuiltServer } from '../../src/server.js'
import type { X402Deps } from '../../src/x402/session.js'

export interface Harness {
  client: Client
  built: BuiltServer
  outDir: string
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; structured: any; content: any[] }>
  close: () => Promise<void>
}

export async function harness(base: string, env: Record<string, string> = {}, opts: { x402Deps?: X402Deps; allowLocalFiles?: boolean } = {}): Promise<Harness> {
  const outDir = mkdtempSync(join(tmpdir(), 'carpe-mcp-test-'))
  const cfg = loadConfig({ CARPE_TEST_BASE_URL: base, CARPE_OUTPUT_DIR: outDir, ...env })
  const built = buildServer({ config: cfg, x402Deps: { stateDir: null, ...opts.x402Deps }, allowLocalFiles: opts.allowLocalFiles ?? true })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await built.server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return {
    client,
    built,
    outDir,
    call: async (name, args = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as any
      return {
        isError: !!r.isError,
        text: (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
        structured: r.structuredContent ?? {},
        content: r.content ?? [],
      }
    },
    close: async () => {
      await client.close()
      await built.server.close()
    },
  }
}
