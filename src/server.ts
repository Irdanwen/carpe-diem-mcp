/**
 * Build a configured MCP server. Pure factory: transports live in src/transports/.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CarpeClient } from './carpe-client.js'
import { loadConfig, paymentMode, type Config } from './config.js'
import { buildPrompts } from './prompts.js'
import { buildResources } from './resources.js'
import { Estimator, SpendGuard } from './spend-guard.js'
import { TOOL_ANNOTATIONS } from './tools/annotations.js'
import { buildTools } from './tools/index.js'
import type { ToolDef } from './tools/context.js'
import { X402Session, type X402Deps } from './x402/session.js'

export interface BuildOptions {
  config?: Config
  /** Inject a fetch implementation (tests). */
  fetchImpl?: typeof fetch
  x402Deps?: X402Deps
  /** Local file inputs and private-host URLs: true for stdio, false for HTTP. */
  allowLocalFiles?: boolean
  /** Share one payment session and spend guard across several MCP sessions (HTTP mode). */
  core?: ServerCore
}

export interface BuiltServer {
  server: McpServer
  client: CarpeClient
  guard: SpendGuard
  tools: ToolDef[]
}

export function instructions(cfg: Config): string {
  const mode = paymentMode(cfg)
  return [
    'Carpe Diem MCP: Venice AI models (text, image, video, audio, music, embeddings, web search) bought on the Carpe Diem marketplace, usually below Venice list prices.',
    'Two API surfaces, chosen per call with route: "carpe" = /v1, served only by Carpe inside its TEE (private); "router" = /router, the cheapest market, which may be outside a TEE (each result says route_used and tee).',
    'Use carpe_quote before expensive text calls, carpe_model_details for model constraints, carpe_balance for funds. Results report the exact cost billed.',
    `Payment: ${mode === 'api_key' ? 'API key' : mode === 'x402' ? 'x402 wallet permit (pay per call, hard budget)' : 'none configured — paid tools will refuse; set CARPE_API_KEY'}. Spend guard: max $${cfg.maxPerCallUsd} per call, $${cfg.maxSpendUsd} per session (0 = no limit).`,
  ].join(' ')
}

/** The stateful part — payment session, spend guard, estimator — shared by every MCP session of a process. */
export interface ServerCore {
  cfg: Config
  client: CarpeClient
  guard: SpendGuard
  estimator: Estimator
}

export function buildCore(opts: Omit<BuildOptions, 'allowLocalFiles' | 'core'> = {}): ServerCore {
  const cfg = opts.config ?? loadConfig()
  const x402 = paymentMode(cfg) === 'x402' ? new X402Session(cfg, opts.x402Deps) : undefined
  const client = new CarpeClient(cfg, x402, opts.fetchImpl)
  return { cfg, client, guard: new SpendGuard(cfg), estimator: new Estimator(client) }
}

export function buildServer(opts: BuildOptions = {}): BuiltServer {
  const { cfg, client, guard, estimator } = opts.core ?? buildCore(opts)
  const tools = buildTools({
    client,
    cfg,
    guard,
    estimator,
    media: { allowLocalFiles: opts.allowLocalFiles ?? true, outputDir: cfg.outputDir, maxInputBytes: cfg.maxMediaBytes },
  })

  const server = new McpServer(
    { name: cfg.serverName, version: cfg.serverVersion },
    { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} }, instructions: instructions(cfg) },
  )
  // Cast: avoid the SDK's deep ZodRawShape inference; zod still validates at runtime.
  const srv = server as unknown as {
    registerTool: (name: string, def: unknown, handler: unknown) => void
    registerResource: (name: string, uri: string, def: unknown, handler: unknown) => void
    registerPrompt: (name: string, def: unknown, handler: unknown) => void
  }
  for (const t of tools) {
    const annotations = TOOL_ANNOTATIONS[t.name]
    if (!annotations) throw new Error(`Tool ${t.name} has no annotations`)
    srv.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...annotations } },
      async (args: unknown, extra: unknown) => t.handler(args, extra as never),
    )
  }
  for (const r of buildResources(client)) {
    srv.registerResource(r.uri.replace(/^carpe:\/\//, ''), r.uri, { title: r.name, description: r.description, mimeType: r.mimeType }, async () => ({ contents: [await r.read()] }))
  }
  for (const p of buildPrompts()) {
    srv.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.argsSchema }, async (args: unknown) => p.build((args ?? {}) as never))
  }
  return { server, client, guard, tools }
}

export { loadConfig } from './config.js'
export { CarpeClient } from './carpe-client.js'
