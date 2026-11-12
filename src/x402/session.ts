/**
 * x402 `carpe-session` payments.
 *
 * The operator answers an unpaid request with a 402 challenge. We sign ONE
 * EIP-2612 USDC permit to Carpe's escrow and reuse it on every later request;
 * the operator pulls the actual cost of each request from that allowance.
 *
 * How the operator settles (operator settle.ts, CarpeEscrow): it pulls from the
 * allowance already open while that covers the amount (`pullFromUser`), and only
 * then applies the presented permit (`pullWithPermit`). EIP-2612 `permit()` SETS
 * the allowance, it does not add to it. So whatever is still open when a new
 * permit is signed can be pulled on top of that permit's whole value.
 *
 * Safety properties:
 *   - The escrow can never pull more than CARPE_X402_BUDGET_USD in total through
 *     the permits of this server. Every permit is signed for
 *       budget − spent − allowance still open to the escrow
 *     read at the same block as the permit nonce: what is open is committed
 *     money. Spend is persisted in the state directory, so a restart does not
 *     reset it.
 *   - `spent` is what was billed, raised to an on-chain bound when that is
 *     higher (see applyOnChainFloor): a relay that under-reports
 *     X-Payment-Amount-Usdc and forces re-signs cannot get the cap reset.
 *   - An allowance to the escrow that no permit of this server explains (an
 *     approve() or a permit signed elsewhere) makes the cap impossible to
 *     guarantee: nothing is signed until it is revoked.
 *   - Before signing, the challenge is checked (known network, USDC asset,
 *     escrow address) and so is the RPC's chainId.
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

/** The USDC permit nonce of `owner` and its allowance to the escrow, read at one block. */
export interface PermitState {
  nonce: bigint
  allowance: bigint
}

export interface X402Deps {
  /** eth_chainId of the RPC that will be read for `chainId`. */
  readChainId?: (chainId: number) => Promise<number>
  readPermitState?: (asset: Address, owner: Address, spender: Address, chainId: number) => Promise<PermitState>
  readUsdcBalance?: (asset: Address, owner: Address, chainId: number) => Promise<bigint>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  stateDir?: string | null
}

const ERC20_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
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
/** A Base block is 2 s: a lagging node has usually caught up a block later. */
const UNKNOWN_BLOCK_RETRY_MS = 2_000

/**
 * The node does not know the requested block (yet): geth/op-geth "header not found", reth / erigon
 * "block not found", nethermind "Block … could not be found", viem's BlockNotFoundError. Looked for in the
 * error, its details and its causes.
 */
export function isUnknownBlock(err: unknown): boolean {
  const re = /header not found|unknown block|block not found|BlockNotFound|block\b[^.]{0,80}\bcould not be found/i
  for (let e = err as { message?: unknown; details?: unknown; shortMessage?: unknown; name?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
    if ([e.name, e.message, e.details, e.shortMessage].some((s) => typeof s === 'string' && re.test(s))) return true
  }
  return false
}

interface PersistedState {
  address: string
  spentMicros: string
  header?: string
  permitValueMicros?: string
  signedAt?: number
  lastPermit?: {
    value: string
    /** Older state files: billed spend only. Superseded by committedBefore. */
    spentBefore?: string
    committedBefore?: string
    allowanceAtSign?: string
    nonce: string
    asset: string
    escrow: string
    chainId: number
  }
}

/** The last permit signed, kept even when its header is dropped: re-signing bounds what was pulled since. */
interface LastPermit {
  value: bigint
  /** spent + allowance still open when it was signed: the most pulled or pullable before it applies. */
  committedBefore: bigint
  /** The allowance open when it was signed (unknown in older state files). */
  allowanceAtSign?: bigint
  nonce: bigint
  asset: Address
  escrow: Address
  chainId: number
}

const usd = (micros: bigint) => Number(micros) / 1e6
const usdText = (micros: bigint) => (micros >= 2n ** 255n ? 'an unlimited amount of' : `$${usd(micros).toFixed(6)}`)

export class X402Session {
  readonly account: PrivateKeyAccount
  readonly budgetMicros: bigint
  private spentMicros = 0n
  private header: string | undefined
  private permitValueMicros: bigint | undefined
  private signedAt: number | undefined
  private lastAccept: X402Accept | undefined
  private lastPermit: LastPermit | undefined
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
      readChainId: deps.readChainId ?? ((chainId) => rpc(chainId).getChainId()),
      readPermitState: deps.readPermitState ?? (async (asset, owner, spender, chainId) => {
        // Both at one block: a nonce one block ahead of the allowance would count a permit as pulled.
        const client = rpc(chainId)
        const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
        const [nonce, allowance] = await Promise.all([
          client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'nonces', args: [owner], blockNumber }),
          client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender], blockNumber }),
        ])
        return { nonce: nonce as bigint, allowance: allowance as bigint }
      }),
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
      if (s.lastPermit) {
        const p = s.lastPermit
        this.lastPermit = {
          value: BigInt(p.value),
          committedBefore: BigInt(p.committedBefore ?? p.spentBefore ?? '0'),
          allowanceAtSign: p.allowanceAtSign !== undefined ? BigInt(p.allowanceAtSign) : undefined,
          nonce: BigInt(p.nonce),
          asset: getAddress(p.asset),
          escrow: getAddress(p.escrow),
          chainId: p.chainId,
        }
      }
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
        ...(this.lastPermit
          ? {
              lastPermit: {
                value: this.lastPermit.value.toString(),
                committedBefore: this.lastPermit.committedBefore.toString(),
                allowanceAtSign: this.lastPermit.allowanceAtSign?.toString(),
                nonce: this.lastPermit.nonce.toString(),
                asset: this.lastPermit.asset,
                escrow: this.lastPermit.escrow,
                chainId: this.lastPermit.chainId,
              },
            }
          : {}),
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

  /** The last permit, if it was signed for this asset, escrow and chain (the reads below are about them). */
  private lastPermitFor(net: NetworkInfo): LastPermit | undefined {
    const p = this.lastPermit
    return p && p.asset === net.usdc && p.escrow === net.escrow && p.chainId === net.chainId ? p : undefined
  }

  /**
   * The most the allowance can be if only this server's permits ever set it.
   * It only goes down between two permits (pulls), and a permit SETS it. So:
   * at most the last permit's value once its nonce is consumed, and at most
   * what was open when it was signed otherwise (that also covers a nonce
   * consumed by some other permit of this wallet). Undefined when unknown
   * (older state files).
   */
  private ownAllowanceBound(p: LastPermit | undefined, nonce: bigint): bigint | undefined {
    if (!p) return 0n
    if (nonce > p.nonce) return p.allowanceAtSign !== undefined && p.allowanceAtSign > p.value ? p.allowanceAtSign : p.value
    return p.allowanceAtSign
  }

  /**
   * Raise `spent` to an upper bound of what the escrow really pulled, when that
   * is more than what was billed (a relay can under-report
   * X-Payment-Amount-Usdc). At the last signature, at most `committedBefore`
   * was pulled or still pullable. Since then, if its nonce was consumed, the
   * permit may have SET the allowance to its value. So pulled <=
   * committedBefore (+ value if the nonce moved) - allowance still open.
   * Counting the live allowance as committed does not make this redundant:
   * without it, a relay drains the allowance unbilled, the allowance reads 0,
   * and re-signing would grant a whole new budget.
   */
  private applyOnChainFloor(p: LastPermit | undefined, state: PermitState): void {
    if (!p) return
    const ceiling = p.committedBefore + (state.nonce > p.nonce ? p.value : 0n)
    const floor = ceiling > state.allowance ? ceiling - state.allowance : 0n
    if (floor > this.spentMicros) {
      this.spentMicros = floor
      this.save()
    }
  }

  private refuseBudget(need: bigint, remaining: bigint, open = 0n): void {
    const minMicros = BigInt(Math.round(X402_MIN_BUDGET_USD * 1e6))
    const why = open > 0n
      ? ` (${usdText(open)} is still open as an allowance to the Carpe escrow from an earlier permit: it can still be pulled, so it counts against the budget)`
      : ''
    const hint = 'Raise CARPE_X402_BUDGET_USD (it is a cumulative cap) and restart the MCP server.'
    if (need > remaining) {
      throw new LocalRefusal(
        'X402_BUDGET_EXHAUSTED',
        `This request may cost up to $${usd(need).toFixed(6)} but only $${usd(remaining).toFixed(6)} of the x402 budget is left${why}.`,
        hint,
      )
    }
    if (remaining < minMicros) {
      throw new LocalRefusal('X402_BUDGET_EXHAUSTED', `Less than the operator minimum of ${X402_MIN_BUDGET_USD} USDC is left in the x402 budget${why}.`, hint)
    }
  }

  /**
   * The nonce and allowance are read at a pinned block. On an RPC spread over several nodes, the node
   * serving the reads may not know that block yet: one more try after a short delay. Any other failure,
   * or the same one twice, fails closed (nothing is signed).
   */
  private async readPermitState(asset: Address, owner: Address, spender: Address, chainId: number): Promise<PermitState> {
    try {
      return await this.deps.readPermitState(asset, owner, spender, chainId)
    } catch (err) {
      if (!isUnknownBlock(err)) throw err
      await this.deps.sleep(UNKNOWN_BLOCK_RETRY_MS)
      return this.deps.readPermitState(asset, owner, spender, chainId)
    }
  }

  async sign(acc: X402Accept): Promise<string> {
    const net = this.validateAccept(acc)
    const owner = this.account.address
    const need = BigInt(acc.maxAmountRequired)
    // Decidable without the chain: the on-chain reads below can only lower what is left.
    this.refuseBudget(need, this.remainingMicros)

    const rpcChainId = await this.deps.readChainId(net.chainId)
    if (rpcChainId !== net.chainId) {
      throw new LocalRefusal(
        'X402_UNEXPECTED_NETWORK',
        `The x402 challenge is for ${acc.network} (chainId ${net.chainId}) but CARPE_X402_RPC_URL is on chainId ${rpcChainId}. Refusing to sign.`,
        `Point CARPE_X402_RPC_URL to an RPC for ${acc.network}.`,
      )
    }
    const state = await this.readPermitState(net.usdc!, owner, net.escrow!, net.chainId)
    const p = this.lastPermitFor(net)
    const bound = this.ownAllowanceBound(p, state.nonce)
    if (bound !== undefined && state.allowance > bound) {
      throw new LocalRefusal(
        'X402_FOREIGN_ALLOWANCE',
        `This wallet lets the Carpe escrow (${net.escrow}) pull ${usdText(state.allowance)} USDC through an allowance this server did not grant (an approve() or a permit signed elsewhere). While it exists the x402 budget cap cannot be guaranteed, so nothing is signed.`,
        `Revoke it: set the USDC allowance of ${owner} to the escrow ${net.escrow} to 0 on ${acc.network} (approve(escrow, 0) from the wallet, or a tool such as revoke.cash), or give this server a wallet of its own. Then retry.`,
      )
    }
    this.applyOnChainFloor(p, state)
    const committed = this.spentMicros + state.allowance
    const remaining = this.budgetMicros > committed ? this.budgetMicros - committed : 0n
    this.refuseBudget(need, remaining, state.allowance)

    const value = remaining
    const nonce = state.nonce
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
    this.lastPermit = { value, committedBefore: committed, allowanceAtSign: state.allowance, nonce, asset: net.usdc!, escrow: net.escrow!, chainId: net.chainId }
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

  /** Run one paid request: send with the cached permit, re-sign at most once, retry once on a draining balance. */
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
      // A balance too low is not cured by a new permit (the operator checks it first, before the allowance):
      // no re-sign, the error and its hint (fund the wallet) go back as they are.
      const lowBalance = code === 'X402_PREFLIGHT_FAILED' && /USDC balance|insufficient[^.]{0,40}balance|balance[^.]{0,40}insufficient/i.test(String((body as { error?: unknown })?.error ?? ''))
      if ((code === 'X402_INVALID' || code === 'X402_PREFLIGHT_FAILED') && !lowBalance && this.header && !resigned) {
        // The cached permit is spent, expired, or its nonce was consumed (the operator's preflight then
        // simulates a permit that can no longer apply): fetch a fresh challenge, once.
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
      note: 'The budget is the most the Carpe escrow can ever pull from this wallet through this server: each permit is signed for the budget minus what was spent and what is still open to the escrow. Billed amounts come from X-Payment-Amount-Usdc; settlement on-chain is batched.',
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
