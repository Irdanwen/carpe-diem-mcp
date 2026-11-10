/**
 * x402 `carpe-session` against a model of the real settlement.
 *
 * The fakes copy what the operator and the chain do:
 *   - USDC (EIP-2612): `permit()` is valid only at the owner's current nonce and
 *     before its deadline, SETS the allowance (it does not add to it) and bumps
 *     the nonce;
 *   - CarpeEscrow: `pullWithPermit` tries the permit (a failure is swallowed),
 *     then pulls from the allowance; `pullFromUser` only pulls. A failed pull
 *     reverts the whole call, permit included;
 *   - operator settle.ts: pulls from the allowance already open while it covers
 *     the amount (`pullFromUser`), and only applies the presented permit
 *     (`pullWithPermit`) once it does not; `preflight` simulates that same call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverTypedDataAddress, type Address } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { loadConfig } from '../src/config.js'
import { CarpeResponse } from '../src/carpe-client.js'
import { X402Session, type X402Deps } from '../src/x402/session.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ESCROW = '0x15917768b31CB1DC61d9d858f2419BF45044005d' as Address
const MAX_UINT = 2n ** 256n - 1n

interface Permit {
  owner: Address
  spender: Address
  value: string
  nonce: string
  deadline: string
  signature: `0x${string}`
}

const decode = (h: string): Permit => JSON.parse(Buffer.from(h, 'base64').toString()).payload

const accept = (price: bigint) => ({
  scheme: 'carpe-session', network: 'base', maxAmountRequired: price.toString(),
  payTo: ESCROW, asset: USDC, extra: { name: 'USD Coin', version: '2' },
})

const res = (status: number, body: unknown, meta: Record<string, unknown> = {}) =>
  new CarpeResponse(status, new Headers({ 'content-type': 'application/json' }), Buffer.from(JSON.stringify(body)), { status, ...meta } as never)

class Chain {
  chainId = 8453
  nonce = 0n
  allowance = 0n
  balance = 1_000_000_000_000n
  pulled = 0n
  reads = 0

  private snapshot() {
    return { nonce: this.nonce, allowance: this.allowance, balance: this.balance, pulled: this.pulled }
  }

  private restore(s: ReturnType<Chain['snapshot']>) {
    Object.assign(this, s)
  }

  /** USDC.permit: only at the current nonce, before the deadline, signed by the owner. SETS the allowance. */
  async permit(p: Permit): Promise<void> {
    if (BigInt(p.nonce) !== this.nonce) throw new Error('permit: invalid nonce')
    if (BigInt(p.deadline) * 1000n < BigInt(Date.now())) throw new Error('permit: expired')
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      types: { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] },
      primaryType: 'Permit',
      message: { owner: p.owner, spender: p.spender, value: BigInt(p.value), nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) },
      signature: p.signature,
    })
    if (signer !== p.owner || p.spender !== ESCROW) throw new Error('permit: bad signature')
    this.allowance = BigInt(p.value)
    this.nonce++
  }

  private pull(amount: bigint): void {
    if (this.allowance < amount) throw new Error('pull: allowance')
    if (this.balance < amount) throw new Error('pull: balance')
    this.allowance -= amount
    this.balance -= amount
    this.pulled += amount
  }

  /** CarpeEscrow.pullWithPermit: `try permit {} catch {}` then pull; a revert undoes everything. */
  async pullWithPermit(p: Permit, amount: bigint): Promise<void> {
    const s = this.snapshot()
    try {
      try { await this.permit(p) } catch { /* swallowed by the contract */ }
      this.pull(amount)
    } catch (e) {
      this.restore(s)
      throw e
    }
  }

  pullFromUser(amount: bigint): void {
    this.pull(amount)
  }

  /** operator settle.ts settlePull: grant-vs-pull decided by the live allowance. */
  async settle(p: Permit, amount: bigint): Promise<void> {
    if (this.allowance < amount) await this.pullWithPermit(p, amount)
    else this.pullFromUser(amount)
  }

  /** operator settle.ts preflight: the same call, simulated. */
  async preflight(p: Permit, amount: bigint): Promise<boolean> {
    const s = this.snapshot()
    try {
      await this.settle(p, amount)
      return true
    } catch {
      return false
    } finally {
      this.restore(s)
    }
  }

  deps(): X402Deps {
    return {
      readChainId: async () => this.chainId,
      readPermitState: async () => {
        this.reads++
        return { nonce: this.nonce, allowance: this.allowance }
      },
      readUsdcBalance: async () => this.balance,
    }
  }
}

/** An honest operator: challenge without a header, otherwise preflight, settle at once, bill the real price. */
function operator(chain: Chain, price: bigint) {
  return async (h?: string): Promise<CarpeResponse> => {
    if (!h) return res(402, { x402Version: 1, accepts: [accept(price)] })
    const p = decode(h)
    if (!(await chain.preflight(p, price))) return res(402, { code: 'X402_PREFLIGHT_FAILED', error: 'x402 preflight failed' })
    await chain.settle(p, price)
    return res(200, { ok: true }, { costSource: 'x402', costUsd: Number(price) / 1e6 })
  }
}

/**
 * The README's threat model: a relay that holds every header it sees (they are
 * bearer). On a new header it drains the allowance still open, applies the new
 * permit with a 1 µUSDC pull and bills 1 µUSDC (X-Payment-Amount-Usdc
 * under-reported). A header it has already used gets X402_INVALID, so the MCP
 * re-signs on every call.
 */
function relay(chain: Chain, price: bigint) {
  const used: Permit[] = []
  const seen = new Set<string>()
  const send = async (h?: string): Promise<CarpeResponse> => {
    if (!h) return res(402, { x402Version: 1, accepts: [accept(price)] })
    if (seen.has(h)) return res(402, { code: 'X402_INVALID', error: 'permit spent' })
    seen.add(h)
    const p = decode(h)
    used.push(p)
    if (chain.allowance > 0n) await chain.settle(p, chain.allowance)
    try { await chain.settle(p, 1n) } catch { /* nothing to apply */ }
    return res(200, { ok: true }, { costSource: 'x402', costUsd: 0.000001 })
  }
  /** At the end, the relay replays everything it holds to pull all it can. */
  const drainAll = async () => {
    if (chain.allowance > 0n) chain.pullFromUser(chain.allowance)
    for (const p of used) {
      try {
        await chain.pullWithPermit(p, BigInt(p.value))
      } catch { /* spent nonce */ }
      if (chain.allowance > 0n) chain.pullFromUser(chain.allowance)
    }
  }
  return { send, drainAll }
}

const session = (budget: string, chain: Chain, pk = generatePrivateKey(), stateDir: string | null = null) =>
  new X402Session(loadConfig({ CARPE_X402_PRIVATE_KEY: pk, CARPE_X402_BUDGET_USD: budget }), { stateDir, ...chain.deps() })

const fmt = (micros: bigint) => (Number(micros) / 1e6).toFixed(6)
const isCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code

test('x402 settlement: a relay forcing re-signs never gets more than the budget pulled', async () => {
  const chain = new Chain()
  const s = session('1', chain)
  const r = relay(chain, 1000n)
  let refused = 0
  let committed = 0n // the most ever pulled or still pullable (pulled + allowance open)
  for (let i = 0; i < 20; i++) {
    try {
      await s.pay(r.send)
    } catch (e) {
      assert.equal((e as { code?: string }).code, 'X402_BUDGET_EXHAUSTED')
      refused++
    }
    if (chain.pulled + chain.allowance > committed) committed = chain.pulled + chain.allowance
  }
  const duringCalls = chain.pulled
  await r.drainAll()
  console.log(`# relay: pulled ${fmt(duringCalls)} during 20 calls (at most ${fmt(committed)} pulled + open), ${fmt(chain.pulled)} after replaying every header; billed ${(await s.status()).billed_usd}`)
  assert.ok(committed <= 1_000_000n, `pulled + open reached ${fmt(committed)} for a 1 USDC budget`)
  assert.ok(chain.pulled <= 1_000_000n, `pulled ${fmt(chain.pulled)} for a 1 USDC budget`)
  assert.ok(refused > 0)
})

test('x402 settlement: lowering the budget at restart (10 → 2) never lets the MCP drive the total above 2', async () => {
  const chain = new Chain()
  const pk = generatePrivateKey()
  const dir = mkdtempSync(join(tmpdir(), 'carpe-x402-'))
  // Under a budget of 10: four honest calls at 0.25. The permit of 10 is applied, 1 is pulled, 9 stay open.
  const first = session('10', chain, pk, dir)
  for (let i = 0; i < 4; i++) assert.equal((await first.pay(operator(chain, 250_000n))).status, 200)
  assert.equal(chain.pulled, 1_000_000n)
  assert.equal(chain.allowance, 9_000_000n)

  // Restart with 2, behind the adversarial relay. The 9 still open already exceed what is left of 2:
  // nothing new may be signed (only revoking the allowance closes those 9 — see the README).
  const second = session('2', chain, pk, dir)
  const r = relay(chain, 1000n)
  let signed = 0
  for (let i = 0; i < 100; i++) {
    try {
      await second.pay(async (h) => {
        if (h) signed++
        return r.send(h)
      })
    } catch (e) {
      assert.equal((e as { code?: string }).code, 'X402_BUDGET_EXHAUSTED')
    }
  }
  console.log(`# lowered budget: ${signed} permit(s) presented after restart, pulled ${fmt(chain.pulled)}`)
  assert.equal(signed, 0)
  assert.ok(chain.pulled <= 2_000_000n, `pulled ${fmt(chain.pulled)} for a budget lowered to 2`)
})

test('x402 settlement: X402_PREFLIGHT_FAILED on a cached permit fetches a fresh challenge once', async () => {
  const chain = new Chain()
  const pk = generatePrivateKey()
  const dir = mkdtempSync(join(tmpdir(), 'carpe-x402-'))
  // Budget 1 used up honestly: the permit is applied, its nonce consumed, the allowance at 0.
  const first = session('1', chain, pk, dir)
  for (let i = 0; i < 4; i++) assert.equal((await first.pay(operator(chain, 250_000n))).status, 200)
  assert.equal(chain.allowance, 0n)

  // Raised to 2 and restarted: the cached permit fails the operator's preflight; the MCP re-signs for the 1 left.
  const second = session('2', chain, pk, dir)
  const headers: string[] = []
  const op = operator(chain, 250_000n)
  const r = await second.pay(async (h) => {
    if (h) headers.push(h)
    return op(h)
  })
  assert.equal(r.status, 200)
  assert.equal(headers.length, 2, 'the persisted permit, then a fresh one')
  assert.equal(decode(headers[1]!).value, '1000000')
  assert.equal(decode(headers[1]!).nonce, '1')
  assert.equal(chain.pulled, 1_250_000n)
})

test('x402 settlement: an RPC on another chain is refused before signing', async () => {
  const chain = new Chain()
  chain.chainId = 1
  const s = session('1', chain)
  let sent = 0
  await assert.rejects(
    s.pay(async (h) => {
      if (h) sent++
      return operator(chain, 1000n)(h)
    }),
    isCode('X402_UNEXPECTED_NETWORK'),
  )
  assert.equal(sent, 0)
  assert.equal(chain.reads, 0)
})

test('x402 settlement: an allowance to the escrow granted elsewhere blocks signing', async () => {
  // A permanent approve() from another app.
  const chain = new Chain()
  chain.allowance = MAX_UINT
  await assert.rejects(session('1', chain).sign(accept(1000n)), (e: Error & { code?: string; hint?: string }) => {
    assert.equal(e.code, 'X402_FOREIGN_ALLOWANCE')
    assert.match(e.message, /cannot be guaranteed/)
    assert.match(String(e.hint), /approve|revoke/i)
    return true
  })

  // An allowance raised above our own permit after it was applied.
  const chain2 = new Chain()
  const s = session('1', chain2)
  assert.equal((await s.pay(operator(chain2, 250_000n))).status, 200)
  chain2.allowance = 5_000_000n
  await assert.rejects(s.sign(accept(1000n)), isCode('X402_FOREIGN_ALLOWANCE'))
})

test('x402 settlement: a price above the budget is refused locally, without reading the chain', async () => {
  const chain = new Chain()
  const s = session('1', chain)
  await assert.rejects(s.sign(accept(2_000_000n)), isCode('X402_BUDGET_EXHAUSTED'))
  assert.equal(chain.reads, 0)
})

test('x402 settlement: a permit never applied does not count as spent; re-signing reuses its nonce', async () => {
  const chain = new Chain()
  const s = session('1', chain)
  const h1 = await s.sign(accept(1000n))
  const h2 = await s.sign(accept(1000n))
  assert.equal(decode(h1).nonce, '0')
  assert.equal(decode(h2).nonce, '0')
  assert.equal(decode(h2).value, '1000000')
})
