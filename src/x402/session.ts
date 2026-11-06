/**
 * x402 `carpe-session` payments.
 *
 * The operator answers an unpaid request with a 402 challenge. We sign ONE
 * EIP-2612 USDC permit to Carpe's escrow and reuse it on every later request;
 * the operator pulls the actual cost of each request from that allowance.
 *
 * Safety properties:
 *   - The permit `value` is the remaining budget (CARPE_X402_BUDGET_USD minus
 *     what was already billed), so the escrow can never pull more than the
 *     budget in total — re-signing never resets the cap. Spend is persisted in
 *     the state directory, so a restart does not reset it either.
 *   - Before signing, the challenge is checked: known network, USDC asset and
 *     escrow address. A challenge naming anything else is refused.
 *   - A challenge whose price exceeds the remaining budget is refused locally.
 *   - The private key never leaves this module and is never logged.
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, http, getAddress, type Address } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Config } from '../config.js'
import { X402_MIN_BUDGET_USD } from '../config.js'
import type { CarpeResponse } from '../carpe-client.js'
import { CarpeError, LocalRefusal, errorFromBody } from '../errors.js'

export const CARPE_SESSION_SCHEME = 'carpe-session'

interface NetworkInfo {
  chainId: number
  usdc?: Address
  escrow?: Address
}

/** Carpe Diem production addresses (frontend/app/docs/api/content.md → Contracts). */
export const KNOWN_NETWORKS: Record<string, NetworkInfo> = {
  base: {
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    escrow: '0x15917768b31CB1DC61d9d858f2419BF45044005d',
  },
  'base-sepolia': { chainId: 84532 },
}

export interface X402Accept {
  scheme: string
  network: string
  maxAmountRequired: string
  payTo: string
  asset: string
  resource?: string
  description?: string
  maxTimeoutSeconds?: number
  extra?: { name?: string; version?: string }
}

export interface X402Deps {
  readNonce?: (asset: Address, owner: Address, chainId: number) => Promise<bigint>
  readUsdcBalance?: (asset: Address, owner: Address, chainId: number) => Promise<bigint>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  stateDir?: string | null
}

const ERC20_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** The allowance outlives the deadline once used; the deadline only bounds when the escrow may first use it. */
const PERMIT_WINDOW_SEC = 30 * 24 * 3600
const MAX_UNPAID_WAIT_MS = 30_000

interface PersistedState {
  address: string
  spentMicros: string
  header?: string
  permitValueMicros?: string
  signedAt?: number
}

const usd = (micros: bigint) => Number(micros) / 1e6

export class X402Session {
  readonly account: PrivateKeyAccount
  readonly budgetMicros: bigint
  private spentMicros = 0n
  private header: string | undefined
  private permitValueMicros: bigint | undefined
  private signedAt: number | undefined
  private lastAccept: X402Accept | undefined
  private readonly statePath: string | undefined
  private readonly deps: Required<Omit<X402Deps, 'stateDir'>>

  constructor(private readonly cfg: Config, deps: X402Deps = {}) {
    if (!cfg.x402PrivateKey || cfg.x402BudgetUsd === undefined) throw new Error('x402 session needs a private key and a budget')
    this.account = privateKeyToAccount(cfg.x402PrivateKey)
    this.budgetMicros = BigInt(Math.round(cfg.x402BudgetUsd * 1e6))
    const rpc = (chainId: number) => {
      if (chainId !== 8453 && cfg.x402RpcUrl === 'https://mainnet.base.org') {
        throw new LocalRefusal('X402_RPC_REQUIRED', 'Set CARPE_X402_RPC_URL to an RPC for this network.')
      }
      return createPublicClient({ transport: http(cfg.x402RpcUrl) })
    }
    this.deps = {
      readNonce: deps.readNonce ?? (async (asset, owner, chainId) =>
        (await rpc(chainId).readContract({ address: asset, abi: ERC20_ABI, functionName: 'nonces', args: [owner] })) as bigint),
      readUsdcBalance: deps.readUsdcBalance ?? (async (asset, owner, chainId) =>
        (await rpc(chainId).readContract({ address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })) as bigint),
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    }
    const dir = deps.stateDir === null ? undefined : deps.stateDir ?? process.env.CARPE_STATE_DIR ?? join(homedir(), '.carpe-mcp')
    if (dir) {
      this.statePath = join(dir, `x402-${this.account.address.toLowerCase()}.json`)
      this.load()
    }
  }

  get address(): Address {
    return this.account.address
  }

  get remainingMicros(): bigint {
    const r = this.budgetMicros - this.spentMicros
    return r > 0n ? r : 0n
  }

  private load(): void {
    if (!this.statePath) return
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState
      if (s.address?.toLowerCase() !== this.account.address.toLowerCase()) return
      this.spentMicros = BigInt(s.spentMicros ?? '0')
      // Only reuse a cached permit if it does not exceed what the current budget allows.
      if (s.header && s.permitValueMicros && BigInt(s.permitValueMicros) <= this.remainingMicros + this.spentMicros) {
        this.header = s.header
        this.permitValueMicros = BigInt(s.permitValueMicros)
        this.signedAt = s.signedAt
      }
    } catch {
      /* no state yet */
    }
  }

  private save(): void {
    if (!this.statePath) return
    try {
      mkdirSync(join(this.statePath, '..'), { recursive: true, mode: 0o700 })
      const s: PersistedState = {
        address: this.account.address,
        spentMicros: this.spentMicros.toString(),
        header: this.header,
        permitValueMicros: this.permitValueMicros?.toString(),
        signedAt: this.signedAt,
      }
      writeFileSync(this.statePath, JSON.stringify(s, null, 2), { mode: 0o600 })
      chmodSync(this.statePath, 0o600)
    } catch {
      /* state persistence is best effort; the in-memory cap still holds */
    }
  }

  /** Validate a challenge entry against the addresses we are willing to pay. */
  validateAccept(acc: X402Accept): NetworkInfo {
    const net = KNOWN_NETWORKS[acc.network]
    if (!net) throw new LocalRefusal('X402_UNKNOWN_NETWORK', `Refusing to sign for unknown network "${acc.network}".`)
    const expectedAsset = this.cfg.x402Asset ?? net.usdc
    const expectedEscrow = this.cfg.x402Escrow ?? net.escrow
    if (!expectedAsset || !expectedEscrow) {
      throw new LocalRefusal('X402_ADDRESSES_REQUIRED', `Set CARPE_X402_ASSET and CARPE_X402_ESCROW to pay on ${acc.network}.`)
    }
    let asset: Address, payTo: Address
    try {
      asset = getAddress(acc.asset)
      payTo = getAddress(acc.payTo)
    } catch {
      throw new LocalRefusal('X402_BAD_CHALLENGE', 'The x402 challenge carries a malformed address.')
    }
    if (asset !== getAddress(expectedAsset)) throw new LocalRefusal('X402_UNEXPECTED_ASSET', `The challenge asks for asset ${asset}, not USDC (${expectedAsset}). Refusing to sign.`)
    if (payTo !== getAddress(expectedEscrow)) throw new LocalRefusal('X402_UNEXPECTED_PAYEE', `The challenge pays ${payTo}, not the Carpe escrow (${expectedEscrow}). Refusing to sign.`)
    if (!acc.extra?.name || !acc.extra?.version) throw new LocalRefusal('X402_BAD_CHALLENGE', 'The x402 challenge has no EIP-712 domain (extra.name / extra.version).')
    if (!/^\d+$/.test(acc.maxAmountRequired ?? '')) throw new LocalRefusal('X402_BAD_CHALLENGE', 'The x402 challenge has no valid maxAmountRequired.')
    return { ...net, usdc: asset, escrow: payTo }
  }

  private pickAccept(body: unknown): X402Accept {
    const accepts = (body as { accepts?: X402Accept[] })?.accepts
    const acc = Array.isArray(accepts) ? accepts.find((a) => a?.scheme === CARPE_SESSION_SCHEME) ?? accepts.find((a) => a && a.scheme === undefined) : undefined
    if (!acc) throw new LocalRefusal('X402_UNSUPPORTED_CHALLENGE', 'The operator did not offer the carpe-session scheme for this request.')
    return { ...acc, scheme: CARPE_SESSION_SCHEME }
  }

  async sign(acc: X402Accept): Promise<string> {
    const net = this.validateAccept(acc)
    const need = BigInt(acc.maxAmountRequired)
    const remaining = this.remainingMicros
    const minMicros = BigInt(Math.round(X402_MIN_BUDGET_USD * 1e6))
    if (need > remaining) {
      throw new LocalRefusal(
        'X402_BUDGET_EXHAUSTED',
        `This request may cost up to $${usd(need).toFixed(6)} but only $${usd(remaining).toFixed(6)} of the x402 budget is left.`,
        'Raise CARPE_X402_BUDGET_USD (it is a cumulative cap) and restart the MCP server.',
      )
    }
    if (remaining < minMicros) {
      throw new LocalRefusal('X402_BUDGET_EXHAUSTED', `Less than the operator minimum of ${X402_MIN_BUDGET_USD} USDC is left in the x402 budget.`, 'Raise CARPE_X402_BUDGET_USD and restart.')
    }
    const value = remaining
    const owner = this.account.address
    const nonce = await this.deps.readNonce(net.usdc!, owner, net.chainId)
    const deadline = BigInt(Math.floor(this.deps.now() / 1000) + PERMIT_WINDOW_SEC)
    const signature = await this.account.signTypedData({
      domain: { name: acc.extra!.name!, version: acc.extra!.version!, chainId: net.chainId, verifyingContract: net.usdc! },
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: { owner, spender: net.escrow!, value, nonce, deadline },
    })
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: CARPE_SESSION_SCHEME,
        network: acc.network,
        payload: { owner, spender: net.escrow, value: value.toString(), nonce: nonce.toString(), deadline: deadline.toString(), signature },
      }),
    ).toString('base64')
    this.header = header
    this.permitValueMicros = value
    this.signedAt = this.deps.now()
    this.lastAccept = acc
    this.save()
    return header
  }

  private record(res: CarpeResponse): void {
    if (res.status >= 200 && res.status < 300 && res.meta.costSource === 'x402' && res.meta.costUsd !== undefined) {
      this.spentMicros += BigInt(Math.round(res.meta.costUsd * 1e6))
      this.save()
    }
  }

  private parse(res: CarpeResponse): unknown {
    try {
      return JSON.parse(res.text())
    } catch {
      return res.text()
    }
  }

  /** Run one paid request: send with the cached permit, answer a challenge once, retry once on a draining balance. */
  async pay(send: (paymentHeader?: string) => Promise<CarpeResponse>): Promise<CarpeResponse> {
    let res = await send(this.header)
    let resigned = false
    let waitedForDrain = false
    for (let i = 0; i < 4 && res.status === 402; i++) {
      const body = this.parse(res)
      const isChallenge = Array.isArray((body as { accepts?: unknown })?.accepts)
      const code = (body as { code?: string })?.code
      if (isChallenge && !resigned) {
        resigned = true
        res = await send(await this.sign(this.pickAccept(body)))
        continue
      }
      if (code === 'X402_INVALID' && this.header && !resigned) {
        // The cached permit is spent, expired, or its nonce was consumed: fetch a fresh challenge.
        this.header = undefined
        this.permitValueMicros = undefined
        this.save()
        res = await send(undefined)
        continue
      }
      if (code === 'X402_UNPAID_BALANCE' && !waitedForDrain) {
        const msg = String((body as { error?: string })?.error ?? '')
        if (!/being collected/i.test(msg)) break
        const secs = Number(/about (\d+) seconds/i.exec(msg)?.[1] ?? '10')
        const wait = Math.min(MAX_UNPAID_WAIT_MS, Math.max(1000, secs * 1000))
        waitedForDrain = true
        await this.deps.sleep(wait)
        res = await send(this.header)
        continue
      }
      break
    }
    this.record(res)
    return res
  }

  /** Free price discovery: the challenge's maxAmountRequired, without signing anything. */
  static priceFromChallenge(res: CarpeResponse): number | undefined {
    if (res.status !== 402) return undefined
    try {
      const body = JSON.parse(res.text()) as { accepts?: X402Accept[] }
      const acc = body.accepts?.find((a) => a.scheme === CARPE_SESSION_SCHEME) ?? body.accepts?.[0]
      return acc && /^\d+$/.test(acc.maxAmountRequired) ? Number(acc.maxAmountRequired) / 1e6 : undefined
    } catch {
      return undefined
    }
  }

  async status(): Promise<Record<string, unknown>> {
    let usdcBalance: string | undefined
    let balanceError: string | undefined
    const net = KNOWN_NETWORKS[this.lastAccept?.network ?? 'base']
    const asset = (this.cfg.x402Asset ?? net?.usdc) as Address | undefined
    if (asset && net) {
      try {
        usdcBalance = usd(await this.deps.readUsdcBalance(asset, this.account.address, net.chainId)).toFixed(6)
      } catch (e) {
        balanceError = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }
    }
    return {
      wallet: this.account.address,
      network: this.lastAccept?.network ?? 'base',
      budget_usd: usd(this.budgetMicros),
      billed_usd: usd(this.spentMicros),
      remaining_usd: usd(this.remainingMicros),
      permit_signed: this.header !== undefined,
      permit_value_usd: this.permitValueMicros !== undefined ? usd(this.permitValueMicros) : null,
      permit_signed_at: this.signedAt ? new Date(this.signedAt).toISOString() : null,
      usdc_balance: usdcBalance ?? null,
      ...(balanceError ? { usdc_balance_error: balanceError } : {}),
      state_file: this.statePath ?? null,
      note: 'The permit value is the most the Carpe escrow can ever pull from this wallet. Billed amounts come from X-Payment-Amount-Usdc; settlement on-chain is batched.',
    }
  }
}

export function x402ErrorFrom(res: CarpeResponse): CarpeError {
  let body: unknown
  try {
    body = JSON.parse(res.text())
  } catch {
    body = res.text()
  }
  return errorFromBody(res.status, body, res.headers)
}
