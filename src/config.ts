/**
 * Configuration, read once from environment variables.
 *
 * Two API surfaces exist on the Carpe Diem operator and they are NOT
 * interchangeable (see README "Two surfaces"):
 *   - `/v1/*`     Carpe only — Venice inference served from Carpe's TEE network.
 *   - `/router/*` best price — the request is priced across every market and
 *                 served by the cheapest one, which may not be a TEE.
 *
 * Payment modes:
 *   - CARPE_API_KEY (cdm_…)          → `Authorization: Bearer`, billed to the account.
 *   - CARPE_X402_PRIVATE_KEY + BUDGET → x402 `carpe-session`: one EIP-2612 permit
 *                                       whose value is a hard on-chain spending cap.
 *   The API key wins when both are set.
 */
import { createRequire } from 'node:module'

export type Surface = 'carpe' | 'router'
export type PaymentMode = 'api_key' | 'x402' | 'none'

export interface Config {
  baseUrl: string
  apiKey: string | undefined
  x402PrivateKey: `0x${string}` | undefined
  x402BudgetUsd: number | undefined
  x402RpcUrl: string
  x402Escrow: string | undefined
  x402Asset: string | undefined
  maxSpendUsd: number
  maxPerCallUsd: number
  readOnly: boolean
  defaultRoute: Surface
  defaultChatModel: string
  outputDir: string | undefined
  timeoutMs: number
  maxJsonBytes: number
  maxMediaBytes: number
  maxVideoBytes: number
  serverName: string
  serverVersion: string
}

const PACKAGE_VERSION: string = createRequire(import.meta.url)('../package.json').version

export const DEFAULT_BASE_URL = 'https://carpe-diem.xyz/api/operator'
/** x402 `X402_MIN_BUDGET_USDC` on the operator: a smaller session permit is refused. */
export const X402_MIN_BUDGET_USD = 0.1
const MiB = 1024 * 1024

function num(value: string | undefined, fallback: number, opts: { min?: number; allowZero?: boolean } = {}): number {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < 0 || (n === 0 && !opts.allowZero)) return fallback
  if (opts.min !== undefined && n < opts.min) return fallback
  return n
}

function optionalNum(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.CARPE_API_KEY?.trim() || undefined
  if (apiKey && !/^cdm_[0-9a-fA-F]{16,}$/.test(apiKey)) {
    throw new ConfigError('CARPE_API_KEY must be a Carpe Diem API key (cdm_ followed by hex characters).')
  }

  const rawPk = env.CARPE_X402_PRIVATE_KEY?.trim() || undefined
  let x402PrivateKey: `0x${string}` | undefined
  if (rawPk) {
    const pk = rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new ConfigError('CARPE_X402_PRIVATE_KEY must be a 32-byte hex private key.')
    x402PrivateKey = pk as `0x${string}`
  }
  const x402BudgetUsd = optionalNum(env.CARPE_X402_BUDGET_USD)
  if (x402PrivateKey && !apiKey) {
    if (x402BudgetUsd === undefined) {
      throw new ConfigError(
        'CARPE_X402_BUDGET_USD is required with CARPE_X402_PRIVATE_KEY: it is the value of the USDC permit, i.e. the most the operator can ever pull from this wallet.',
      )
    }
    if (x402BudgetUsd < X402_MIN_BUDGET_USD) {
      throw new ConfigError(`CARPE_X402_BUDGET_USD must be at least ${X402_MIN_BUDGET_USD} (the operator refuses smaller session permits).`)
    }
  }

  const route = (env.CARPE_DEFAULT_ROUTE ?? 'carpe').trim().toLowerCase()
  if (route !== 'carpe' && route !== 'router') throw new ConfigError('CARPE_DEFAULT_ROUTE must be "carpe" (/v1) or "router" (/router).')

  return {
    // CARPE_TEST_BASE_URL is for tests and local operators only.
    baseUrl: (env.CARPE_TEST_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey,
    x402PrivateKey,
    x402BudgetUsd,
    x402RpcUrl: env.CARPE_X402_RPC_URL?.trim() || 'https://mainnet.base.org',
    x402Escrow: env.CARPE_X402_ESCROW?.trim() || undefined,
    x402Asset: env.CARPE_X402_ASSET?.trim() || undefined,
    maxSpendUsd: num(env.CARPE_MAX_SPEND_USD, 5, { allowZero: true }),
    maxPerCallUsd: num(env.CARPE_MAX_PER_CALL_USD, 0.5, { allowZero: true }),
    readOnly: env.CARPE_READ_ONLY === '1' || env.CARPE_READ_ONLY === 'true',
    defaultRoute: route,
    defaultChatModel: env.CARPE_DEFAULT_CHAT_MODEL?.trim() || 'deepseek-v4-flash',
    outputDir: env.CARPE_OUTPUT_DIR?.trim() || undefined,
    timeoutMs: num(env.CARPE_HTTP_TIMEOUT_MS, 120_000, { min: 1000 }),
    maxJsonBytes: 16 * MiB,
    maxMediaBytes: num(env.CARPE_MAX_MEDIA_BYTES, 32 * MiB, { min: 1024 }),
    maxVideoBytes: num(env.CARPE_MAX_VIDEO_BYTES, 64 * MiB, { min: 1024 }),
    serverName: 'carpe-diem-mcp',
    serverVersion: PACKAGE_VERSION,
  }
}

export function paymentMode(cfg: Config): PaymentMode {
  if (cfg.apiKey) return 'api_key'
  if (cfg.x402PrivateKey) return 'x402'
  return 'none'
}
