/**
 * Remote (hosted, multi-user) mode: OAuth resource server, per-user isolation,
 * no server-held credential, no disk, metadata-only logs.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { discoverOAuthServerInfo, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { ConfigError, loadConfig } from '../src/config.js'
import { loadRemoteConfig } from '../src/remote/config.js'
import { TokenBucket } from '../src/remote/users.js'
import { createRemoteApp, type RemoteApp } from '../src/transports/remote.js'
import { startIssuer, type MintOptions, type TestIssuer } from './helpers/issuer.js'
import { BIG_MP3, GIANT_PNG, KEY, MP4, startMockCarpe, type MockCarpe } from './helpers/mock-carpe.js'
import { MediaStore } from '../src/remote/media-store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ACCEPT = 'application/json, text/event-stream'

let mock: MockCarpe
let issuer: TestIssuer

interface Remote {
  url: string
  remote: RemoteApp
  logs: Record<string, unknown>[]
  close: () => Promise<void>
}

/** A remote-mode server on a random loopback port; its URL is the OAuth resource. */
async function startRemote(env: Record<string, string> = {}): Promise<Remote> {
  const http: Server = createServer()
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const logs: Record<string, unknown>[] = []
  const cfg = loadConfig({ CARPE_MCP_REMOTE: '1', CARPE_TEST_BASE_URL: mock.base, ...env })
  const rc = loadRemoteConfig({ CARPE_OAUTH_ISSUER: issuer.url, CARPE_MCP_PUBLIC_URL: url, CARPE_MCP_LOG_SALT: 'test-salt', ...env })
  const remote = createRemoteApp({ cfg, remote: rc, log: (e) => logs.push(e) })
  http.on('request', remote.app)
  return {
    url,
    remote,
    logs,
    close: async () => {
      await remote.close()
      http.closeAllConnections()
      await new Promise<void>((r) => http.close(() => r()))
    },
  }
}

/** A token the mock operator accepts (as B2 will), for the given server. */
async function tokenFor(r: Remote, o: MintOptions = {}): Promise<string> {
  const t = await issuer.mint({ aud: r.url, ...o })
  mock.oauthTokens.add(t)
  return t
}

async function connect(r: Remote, token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${r.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  const client = new Client({ name: 'remote-test', version: '0.0.0' })
  await client.connect(transport)
  return { client, transport }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as any
  return {
    isError: !!r.isError,
    text: (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'),
    structured: r.structuredContent ?? {},
    content: (r.content ?? []) as any[],
  }
}

function rpc(r: Remote, token: string | undefined, body: unknown, sid?: string) {
  return fetch(`${r.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(body),
  })
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }
const toolCall = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })

let srv: Remote
before(async () => {
  mock = await startMockCarpe()
  issuer = await startIssuer('unused')
  srv = await startRemote()
})
after(async () => {
  await srv.close()
  await issuer.close()
  await mock.close()
})

describe('configuration', () => {
  test('remote mode holds no credential and writes nothing to disk', () => {
    const base = { CARPE_MCP_REMOTE: '1' }
    for (const [k, v] of [
      ['CARPE_API_KEY', KEY],
      ['CARPE_X402_PRIVATE_KEY', '0x' + '11'.repeat(32)],
      ['CARPE_X402_BUDGET_USD', '1'],
      ['CARPE_MCP_AUTH_TOKEN', 'x'.repeat(32)],
      ['CARPE_OUTPUT_DIR', '/tmp/x'],
    ]) {
      assert.throws(() => loadConfig({ ...base, [k]: v }), ConfigError, k)
    }
    const cfg = loadConfig(base)
    assert.equal(cfg.remote, true)
    assert.equal(cfg.maxSpendUsd, 0, 'the daily cap is the operator\'s; the local per-user total is off by default')
    assert.equal(cfg.maxPerCallUsd, 0.5)
    assert.equal(loadConfig({}).remote, false)
  })

  test('issuer and resource default to production; http only on loopback; asymmetric algorithms only', () => {
    const d = loadRemoteConfig({})
    assert.equal(d.issuer, 'https://compte.carpe-diem.xyz')
    assert.equal(d.resource, 'https://mcp.carpe-diem.xyz')
    assert.deepEqual(d.algorithms, ['ES256'])
    assert.throws(() => loadRemoteConfig({ CARPE_OAUTH_ISSUER: 'http://compte.carpe-diem.xyz' }), ConfigError)
    assert.throws(() => loadRemoteConfig({ CARPE_MCP_PUBLIC_URL: 'https://mcp.example?x=1' }), ConfigError)
    assert.throws(() => loadRemoteConfig({ CARPE_OAUTH_ALGORITHMS: 'HS256' }), ConfigError)
    assert.throws(() => loadRemoteConfig({ CARPE_OAUTH_ALGORITHMS: 'none' }), ConfigError)
    assert.equal(loadRemoteConfig({ CARPE_OAUTH_ISSUER: 'http://127.0.0.1:9/' }).issuer, 'http://127.0.0.1:9')
  })

  test('token bucket: burst, then one request per refill interval', () => {
    const b = new TokenBucket(2, 1, 0)
    assert.equal(b.take(0), 0)
    assert.equal(b.take(0), 0)
    assert.ok(b.take(0) >= 1)
    assert.equal(b.take(1000), 0)
  })
})

describe('discovery and token validation', () => {
  test('protected resource metadata (RFC 9728) names the issuer and the scopes', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetch(`${srv.url}${path}`)
      assert.equal(res.status, 200, path)
      const prm = (await res.json()) as any
      assert.equal(prm.resource, srv.url)
      assert.deepEqual(prm.authorization_servers, [issuer.url])
      assert.deepEqual(prm.scopes_supported, ['carpe:inference', 'carpe:account.read'])
      assert.deepEqual(prm.bearer_methods_supported, ['header'])
    }
  })

  test('/health answers without a token and says nothing about users', async () => {
    const res = await fetch(`${srv.url}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
  })

  test('no token → 401 with WWW-Authenticate resource_metadata, which an MCP client follows to the issuer', async () => {
    const res = await rpc(srv, undefined, INIT)
    assert.equal(res.status, 401)
    const www = res.headers.get('www-authenticate') ?? ''
    assert.match(www, /^Bearer /)
    assert.match(www, /error="invalid_token"/)
    assert.ok(www.includes(`resource_metadata="${srv.url}/.well-known/oauth-protected-resource"`), www)
    const info = await discoverOAuthServerInfo(`${srv.url}/mcp`)
    assert.equal(String(info.authorizationServerUrl).replace(/\/$/, ''), issuer.url)
    assert.equal(info.authorizationServerMetadata?.issuer, issuer.url)
    assert.equal(info.resourceMetadata?.resource, srv.url)
  })

  test('wrong audience, wrong issuer, expired, not yet valid, bad signature, garbage → 401 invalid_token, operator untouched', async () => {
    const before = mock.calls.length
    const cases: [string, string][] = [
      ['wrong aud', await tokenFor(srv, { aud: 'https://other-service.example' })],
      ['id_token-like aud (a client id)', await tokenFor(srv, { aud: 'sub-rosa' })],
      ['wrong iss', await tokenFor(srv, { iss: 'https://evil.example' })],
      ['expired', await tokenFor(srv, { expiresIn: -120 })],
      ['nbf in the future', await tokenFor(srv, { notBefore: 600 })],
      ['bad signature', await tokenFor(srv, { rogueKey: true })],
      ['garbage', 'not-a-jwt'],
      ['typ JWT (an id_token, not an access token)', await tokenFor(srv, { typ: 'JWT' })],
      ['no typ', await tokenFor(srv, { typ: null })],
      ['expired 5 s ago (no skew on exp)', await tokenFor(srv, { expiresIn: -5 })],
      ['issued 10 min in the future', await tokenFor(srv, { issuedAt: 600 })],
    ]
    for (const [label, token] of cases) {
      const res = await rpc(srv, token, INIT)
      assert.equal(res.status, 401, label)
      assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/, label)
      assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="/, label)
    }
    assert.equal(mock.calls.length, before, 'no rejected token reached the operator')
    // A small clock skew is tolerated on nbf / iat (the issuer's clock a little ahead), never on exp.
    assert.equal((await rpc(srv, await tokenFor(srv, { notBefore: 5, issuedAt: 5 }), INIT)).status, 200)
    assert.equal((await rpc(srv, await tokenFor(srv, { typ: 'application/at+jwt' }), INIT)).status, 200)
  })

  test('the expiry handed to the SDK is the token\'s own exp, without the skew', async () => {
    const { JwtAccessTokenVerifier } = await import('../src/remote/token.js')
    const v = new JwtAccessTokenVerifier(loadRemoteConfig({ CARPE_OAUTH_ISSUER: issuer.url, CARPE_MCP_PUBLIC_URL: srv.url }))
    const t = await issuer.mint({ aud: srv.url, expiresIn: 100 })
    const exp = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).exp
    assert.equal((await v.verifyAccessToken(t)).expiresAt, exp)
    await assert.rejects(v.verifyAccessToken(await issuer.mint({ aud: srv.url, expiresIn: 0 })), /expired/)
    await assert.rejects(v.verifyAccessToken(await issuer.mint({ aud: srv.url, typ: 'JWT' })), /Not an access token/)
  })

  test('an unreachable issuer is a server error (500), never an accepted token', async () => {
    const http: Server = createServer()
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    const remote = createRemoteApp({
      cfg: loadConfig({ CARPE_MCP_REMOTE: '1', CARPE_TEST_BASE_URL: mock.base }),
      remote: loadRemoteConfig({ CARPE_OAUTH_ISSUER: 'http://127.0.0.1:9', CARPE_MCP_PUBLIC_URL: url }),
      log: () => undefined,
    })
    http.on('request', remote.app)
    try {
      const res = await rpc({ url } as Remote, await issuer.mint({ aud: url }), INIT)
      assert.equal(res.status, 500)
      assert.equal(((await res.json()) as any).error, 'server_error')
    } finally {
      await remote.close()
      await new Promise<void>((r) => http.close(() => r()))
    }
  })
})

describe('scopes', () => {
  test('without carpe:inference, paid tools are hidden and a call is challenged with 403 insufficient_scope', async () => {
    const t = await tokenFor(srv, { sub: 'scoped-1', scope: 'carpe:account.read' })
    const { client, transport } = await connect(srv, t)
    const names = (await client.listTools()).tools.map((x) => x.name)
    assert.ok(names.includes('carpe_balance') && names.includes('carpe_quote') && names.includes('carpe_list_models'))
    for (const n of ['carpe_chat', 'carpe_image_generate', 'carpe_video_generate', 'carpe_video_status', 'carpe_tts']) assert.ok(!names.includes(n), n)
    assert.equal((await call(client, 'carpe_balance')).isError, false)

    const res = await rpc(srv, t, toolCall('carpe_chat', { prompt: 'hi' }), transport.sessionId)
    assert.equal(res.status, 403)
    const www = res.headers.get('www-authenticate') ?? ''
    assert.match(www, /error="insufficient_scope"/)
    assert.match(www, /scope="carpe:account.read carpe:inference"/)
    assert.match(www, /resource_metadata="/)
    assert.equal(((await res.json()) as any).error, 'insufficient_scope')

    // Step-up: the same session with a token that has the scope now lists and runs the paid tools.
    const t2 = await tokenFor(srv, { sub: 'scoped-1' })
    const up = await rpc(srv, t2, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, transport.sessionId)
    assert.equal(up.status, 200)
    assert.match(await up.text(), /carpe_chat/)
    await client.close()
  })

  test('without carpe:account.read, account tools are refused', async () => {
    const t = await tokenFor(srv, { sub: 'scoped-2', scope: 'carpe:inference' })
    const { client, transport } = await connect(srv, t)
    const names = (await client.listTools()).tools.map((x) => x.name)
    assert.ok(names.includes('carpe_chat') && !names.includes('carpe_balance') && !names.includes('carpe_topup_link'))
    const res = await rpc(srv, t, toolCall('carpe_balance'), transport.sessionId)
    assert.equal(res.status, 403)
    assert.match(res.headers.get('www-authenticate') ?? '', /scope="carpe:inference carpe:account.read"/)
    assert.equal((await call(client, 'carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b' })).isError, false)
    await client.close()
  })

  test('removed tools are absent: kill switch, voice cloning, x402 status', async () => {
    const t = await tokenFor(srv, { sub: 'lister' })
    const { client } = await connect(srv, t)
    const names = (await client.listTools()).tools.map((x) => x.name)
    for (const n of ['carpe_revoke_this_key', 'carpe_voice_clone', 'carpe_x402_status', 'carpe_topup_link']) assert.ok(!names.includes(n), n)
    assert.ok(names.includes('carpe_session_spend'))
    assert.equal(names.length, 29)
    const r = await client.callTool({ name: 'carpe_revoke_this_key', arguments: { confirm: 'REVOKE' } }).catch((e) => ({ isError: true, e }))
    assert.equal((r as any).isError, true)
    assert.ok(!mock.calls.some((c) => c.path === '/v1/keys/self/revoke'))
    await client.close()
  })
})

describe('credentials and isolation', () => {
  test('the user token is relayed verbatim to the operator, only on account and paid routes; never a cdm_ key', async () => {
    const t = await tokenFor(srv, { sub: 'relay' })
    const { client } = await connect(srv, t)
    const from = mock.calls.length
    const r = await call(client, 'carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b' })
    assert.equal(r.isError, false, r.text)
    assert.equal(r.structured.cost.usd, 0.0015)
    const calls = mock.calls.slice(from)
    const chat = calls.find((c) => c.path === '/v1/chat/completions')!
    assert.equal(chat.headers.authorization, `Bearer ${t}`)
    const quote = calls.find((c) => c.path === '/router/quote')!
    assert.equal(quote.headers.authorization, undefined, 'public quotes carry no token')
    await call(client, 'carpe_list_models', {})
    assert.equal(mock.calls.at(-1)!.headers.authorization, undefined, 'catalogue reads stay anonymous')
    for (const c of mock.calls) assert.ok(!String(c.headers.authorization ?? '').includes('cdm_'), `${c.path} carried a key`)
    await client.close()
  })

  test('a token the operator refuses as invalid (connector revoked) gets 401 from the MCP server too, so the client signs in again', async () => {
    const t = await tokenFor(srv, { sub: 'revoked' })
    const { client } = await connect(srv, t)
    assert.equal((await call(client, 'carpe_balance')).isError, false)
    mock.oauthTokens.delete(t) // revoked in API → Keys: the operator now answers 401 INVALID_TOKEN
    const r = await call(client, 'carpe_balance')
    assert.equal(r.isError, true)
    assert.match(r.text, /INVALID_TOKEN/)
    // From now on the MCP server itself refuses that token, with the challenge that starts the OAuth flow.
    const again = await rpc(srv, t, INIT)
    assert.equal(again.status, 401)
    assert.match(again.headers.get('www-authenticate') ?? '', /invalid_token.*resource_metadata=/)
    // A free tool would not have told it: only an operator refusal of the token counts. Another user is unaffected.
    const other = await tokenFor(srv, { sub: 'still-fine' })
    assert.equal((await rpc(srv, other, INIT)).status, 200)
    await client.close().catch(() => undefined)
  })

  test('a session id presented with another user\'s token → 403', async () => {
    const a = await tokenFor(srv, { sub: 'alice' })
    const b = await tokenFor(srv, { sub: 'bob' })
    const { client, transport } = await connect(srv, a)
    const res = await rpc(srv, b, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, transport.sessionId)
    assert.equal(res.status, 403)
    const del = await fetch(`${srv.url}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${b}`, 'mcp-session-id': transport.sessionId! } })
    assert.equal(del.status, 403)
    assert.equal((await client.listTools()).tools.length > 0, true, 'the owner keeps its session')
    const unknown = await rpc(srv, a, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, 'no-such-session')
    assert.equal(unknown.status, 404)
    await client.close()
  })

  test('spend guards are per user: one user exhausting hers does not touch another\'s', async () => {
    const r = await startRemote({ CARPE_MAX_SPEND_USD: '0.006' })
    try {
      const a = await connect(r, await tokenFor(r, { sub: 'spender-a' }))
      const a2 = await connect(r, await tokenFor(r, { sub: 'spender-a' }))
      const b = await connect(r, await tokenFor(r, { sub: 'spender-b' }))
      const img = { prompt: 'a fox', model: 'z-image-turbo', route: 'carpe' }
      assert.equal((await call(a.client, 'carpe_image_generate', img)).isError, false)
      // Same user, another session: the guard follows the user, not the session.
      const second = await call(a2.client, 'carpe_image_generate', img)
      assert.equal(second.isError, true)
      assert.match(second.text, /SPEND_LIMIT_SESSION/)
      const ok = await call(b.client, 'carpe_image_generate', img)
      assert.equal(ok.isError, false, ok.text)
      const spendB = await call(b.client, 'carpe_session_spend')
      assert.equal(spendB.structured.spent_usd, 0.0053)
      assert.equal(r.remote.users.guard('spender-a').spentUsd, 0.0053)
      for (const c of [a, a2, b]) await c.client.close()
    } finally {
      await r.close()
    }
  })

  test('rate limit per user (429 + Retry-After), not per server', async () => {
    const r = await startRemote({ CARPE_MCP_RATE_BURST: '3', CARPE_MCP_RATE_PER_MIN: '1' })
    try {
      const a = await tokenFor(r, { sub: 'busy' })
      const statuses: number[] = []
      for (let i = 0; i < 4; i++) statuses.push((await rpc(r, a, INIT)).status)
      assert.deepEqual(statuses, [200, 200, 200, 429])
      const limited = await rpc(r, a, INIT)
      assert.ok(Number(limited.headers.get('retry-after')) >= 1)
      assert.equal((await rpc(r, await tokenFor(r, { sub: 'calm' }), INIT)).status, 200, 'another user is not affected')
    } finally {
      await r.close()
    }
  })

  test('sessions per user are capped: the least recently used one is closed', async () => {
    const r = await startRemote({ CARPE_MCP_MAX_SESSIONS_PER_USER: '2' })
    try {
      const t = await tokenFor(r, { sub: 'many' })
      const s1 = await connect(r, t)
      const s2 = await connect(r, t)
      const s3 = await connect(r, t)
      const mine = [...r.remote.sessions.values()].filter((s) => s.sub === 'many')
      assert.equal(mine.length, 2)
      const res = await rpc(r, t, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, s1.transport.sessionId)
      assert.equal(res.status, 404)
      assert.ok((await s3.client.listTools()).tools.length > 0)
      for (const c of [s2, s3]) await c.client.close()
    } finally {
      await r.close()
    }
  })
})

describe('robustness', () => {
  test('malformed bodies ([null], [1], "x", [{}], null in a batch) get a 4xx and the server keeps serving', async () => {
    const r = await startRemote()
    try {
      const t = await tokenFor(r, { sub: 'fuzzer' })
      const raw = (body: string, sid?: string) =>
        fetch(`${r.url}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${t}`, ...(sid ? { 'mcp-session-id': sid } : {}) },
          body,
        })
      for (const body of ['[null]', '[1]', '"x"', '[{}]', 'null', '[]', '[null, {"jsonrpc":"2.0","id":1,"method":"tools/call","params":null}]']) {
        const res = await raw(body)
        assert.ok(res.status >= 400 && res.status < 500, `${body} → ${res.status}`)
        await res.text()
      }
      // Inside a live session too.
      const { client, transport } = await connect(r, t)
      for (const body of ['[null]', '[1]', '[{}]', '[null, {"jsonrpc":"2.0","method":"tools/call","params":{"name":null}}]']) {
        const res = await raw(body, transport.sessionId)
        assert.ok(res.status >= 400 && res.status < 500, `session ${body} → ${res.status}`)
        await res.text()
      }
      assert.deepEqual(await (await fetch(`${r.url}/health`)).json(), { ok: true })
      assert.ok((await client.listTools()).tools.length > 0, 'the session still works')
      assert.ok(r.logs.some((e) => e.event === 'request' && e.status === 400))
      await client.close()
    } finally {
      await r.close()
    }
  })

  test('the built CLI survives a [null] body', async () => {
    const cli = join(root, 'dist', 'cli.js')
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    const url = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, [cli, '--remote', '--port', String(port)], {
      env: { PATH: process.env.PATH, CARPE_TEST_BASE_URL: mock.base, CARPE_OAUTH_ISSUER: issuer.url, CARPE_MCP_PUBLIC_URL: url },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let logs = ''
    child.stderr.on('data', (d) => (logs += d))
    let exited = false
    child.on('exit', () => (exited = true))
    try {
      for (let i = 0; i < 100 && !logs.includes('remote mode on'); i++) await new Promise((r) => setTimeout(r, 50))
      const t = await issuer.mint({ aud: url, sub: 'cli-fuzzer' })
      const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${t}` }, body: '[null]' })
      assert.equal(res.status, 400)
      await res.text()
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(exited, false, 'the process is still running')
      assert.equal((await fetch(`${url}/health`)).status, 200)
    } finally {
      child.kill()
    }
  })
})

describe('media without a disk', () => {
  test('inputs: local paths, http:// and private hosts are refused before anything is paid', async () => {
    const { client } = await connect(srv, await tokenFor(srv, { sub: 'media-in' }))
    const from = mock.calls.length
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['carpe_image_edit', { prompt: 'x', image: '/etc/passwd' }, /LOCAL_FILES_DISABLED/],
      ['carpe_image_edit', { prompt: 'x', image: '~/secret.png' }, /LOCAL_FILES_DISABLED/],
      ['carpe_image_edit', { prompt: 'x', image: 'http://example.com/a.png' }, /URL_REFUSED/],
      ['carpe_image_upscale', { image: 'https://127.0.0.1/a.png' }, /URL_REFUSED/],
      ['carpe_transcribe', { audio: 'https://169.254.169.254/latest/meta-data' }, /URL_REFUSED/],
      ['carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'x', duration: '5s', image_url: 'http://example.com/a.png' }, /URL_REFUSED/],
      ['carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'x', duration: '5s', image_url: 'https://10.0.0.1/a.png' }, /URL_REFUSED/],
      ['carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'x', duration: '5s', image_url: './frame.png' }, /LOCAL_FILES_DISABLED/],
    ]
    for (const [tool, args, re] of cases) {
      const r = await call(client, tool, args)
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`)
      assert.match(r.text, re, `${tool} ${JSON.stringify(args)}`)
    }
    assert.ok(!mock.calls.slice(from).some((c) => c.method === 'POST' && !['/router/quote'].includes(c.path)), 'nothing paid')
    await client.close()
  })

  test('outputs: small media inline; a large image becomes an operator share link; videos come back as a link, not downloaded', async () => {
    const t = await tokenFor(srv, { sub: 'media-out' })
    const { client } = await connect(srv, t)
    const small = await call(client, 'carpe_image_generate', { prompt: 'a fox', model: 'z-image-turbo', route: 'carpe' })
    assert.equal(small.isError, false, small.text)
    assert.ok(small.content.some((c) => c.type === 'image'))
    assert.equal(small.structured.images[0].file, undefined)

    const big = await call(client, 'carpe_image_generate', { prompt: 'a fox', model: 'huge-image', route: 'carpe' })
    assert.equal(big.isError, false, big.text)
    assert.ok(!big.content.some((c) => c.type === 'image'))
    const link = big.content.find((c) => c.type === 'resource_link')
    assert.equal(link.uri, `${mock.base}/v1/image/share/img-1-abc.png`)
    assert.equal(big.structured.images[0].url, link.uri)
    const share = [...mock.calls].reverse().find((c) => c.path === '/v1/image/share')!
    assert.equal(share.headers.authorization, `Bearer ${t}`)
    assert.equal(share.body.mime, 'image/png')

    const tts = await call(client, 'carpe_tts', { input: 'hello', route: 'carpe' })
    assert.ok(tts.content.some((c) => c.type === 'audio'))

    const v = await call(client, 'carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'a boat', duration: '5s', route: 'carpe' })
    assert.equal(v.isError, false, v.text)
    let st = await call(client, 'carpe_video_status', { job_id: v.structured.job_id, wait_seconds: 0 })
    for (let i = 0; i < 5 && st.structured.status !== 'completed'; i++) st = await call(client, 'carpe_video_status', { job_id: v.structured.job_id, wait_seconds: 10 })
    assert.equal(st.structured.status, 'completed', st.text)
    assert.equal(st.structured.video.url, `${mock.base}/v1/video/file/abc123`)
    assert.match(st.structured.video.expires, /10 minutes/)
    assert.ok(st.content.some((c) => c.type === 'resource_link' && c.uri === `${mock.base}/v1/video/file/abc123`))
    assert.ok(!mock.calls.some((c) => c.path === '/v1/video/file/abc123'), 'the server did not download the video')
    await client.close()
  })
})

describe('temporary media store', () => {
  const MiB = 1024 * 1024
  const fetchMedia = async (url: string) => {
    const res = await fetch(url)
    return { res, body: Buffer.from(await res.arrayBuffer()) }
  }
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 20))
    return pred()
  }

  test('outputs too large to return inline (TTS, router/Surplus video, music, queued image) come back as a /media link', async () => {
    const r = await startRemote()
    try {
      const { client } = await connect(r, await tokenFor(r, { sub: 'big-outputs' }))
      const linkRe = new RegExp(`^${r.url}/media/[A-Za-z0-9_-]{22}$`)

      const tts = await call(client, 'carpe_tts', { input: 'a long text', voice: 'long', route: 'carpe' })
      assert.equal(tts.isError, false, tts.text)
      assert.equal(tts.structured.audio.storage, 'hosted_mcp')
      assert.match(tts.structured.audio.url, linkRe)
      assert.ok(tts.content.some((c) => c.type === 'resource_link' && c.uri === tts.structured.audio.url))
      assert.ok(Date.parse(tts.structured.audio.expires_at) - Date.now() > 59 * 60_000)
      const got = await fetchMedia(tts.structured.audio.url)
      assert.equal(got.res.status, 200)
      assert.equal(got.res.headers.get('content-type'), 'audio/mpeg')
      assert.equal(got.res.headers.get('cache-control'), 'private, no-store')
      assert.equal(got.res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(got.res.headers.get('content-disposition'), 'inline; filename="tts.mp3"')
      assert.ok(got.body.equals(BIG_MP3))

      // Router video served by Surplus: the operator bills, then sends the MP4 itself.
      const v = await call(client, 'carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'a boat', duration: '5s', route: 'router' })
      assert.equal(v.isError, false, v.text)
      const vs = await call(client, 'carpe_video_status', { job_id: v.structured.job_id, wait_seconds: 0 })
      assert.equal(vs.isError, false, vs.text)
      assert.equal(vs.structured.video.storage, 'hosted_mcp')
      assert.match(vs.text, /Video ready: http/)
      const vid = await fetchMedia(vs.structured.video.url)
      assert.equal(vid.res.headers.get('content-type'), 'video/mp4')
      assert.ok(vid.body.equals(MP4))

      // A Carpe-served track is handed over once: it is kept here.
      mock.counters['mus-long'] = 0
      const m = await call(client, 'carpe_music_generate', { prompt: 'jazz', model: 'long-music', route: 'carpe' })
      assert.equal(m.isError, false, m.text)
      const ms = await call(client, 'carpe_music_status', { job_id: m.structured.job_id, wait_seconds: 0 })
      assert.equal(ms.isError, false, ms.text)
      assert.equal(ms.structured.audio.storage, 'hosted_mcp')
      assert.ok((await fetchMedia(ms.structured.audio.url)).body.equals(BIG_MP3))

      // A queued image above the operator's share limit: stored here, and /complete only after delivery.
      const from = mock.calls.length
      const img = await call(client, 'carpe_image_generate', { prompt: 'x', model: 'giant-image', route: 'carpe', mode: 'queue', wait_seconds: 5 })
      assert.equal(img.isError, false, img.text)
      assert.equal(img.structured.images[0].storage, 'hosted_mcp')
      assert.ok((await fetchMedia(img.structured.images[0].url)).body.equals(GIANT_PNG))
      assert.ok(await waitFor(() => mock.calls.slice(from).some((c) => c.path === '/v1/image/generate/complete')))
      assert.ok(!mock.calls.slice(from).some((c) => c.path === '/v1/image/share'), 'too large for the operator share: not even tried')

      // Unknown, malformed: 404. The logs never carry a media id.
      for (const p of ['/media/AAAAAAAAAAAAAAAAAAAAAA', '/media/short', '/media/..%2Fhealth']) {
        const res = await fetch(`${r.url}${p}`)
        assert.equal(res.status, 404, p)
        assert.equal(res.headers.get('cache-control'), 'private, no-store')
      }
      const dump = JSON.stringify(r.logs)
      for (const url of [tts.structured.audio.url, vs.structured.video.url, ms.structured.audio.url, img.structured.images[0].url]) {
        assert.ok(!dump.includes(url.split('/').pop()), 'a media id reached the logs')
      }
      assert.ok(r.logs.some((e) => e.event === 'media' && e.status === 200 && e.bytes === BIG_MP3.length))
      await client.close()
    } finally {
      await r.close()
    }
  })

  test('a full store refuses one-shot paid calls before paying, and a lost delivery is an error naming the job', async () => {
    const r = await startRemote({ CARPE_MCP_MEDIA_STORE_MB: '64' })
    try {
      const { client } = await connect(r, await tokenFor(r, { sub: 'store-full' }))
      mock.counters['mus-long'] = 0
      const m = await call(client, 'carpe_music_generate', { prompt: 'jazz', model: 'long-music', route: 'carpe' })
      const v = await call(client, 'carpe_video_generate', { model: 'kling-2.5-turbo-pro-text-to-video', prompt: 'a boat', duration: '5s', route: 'router' })
      assert.equal(m.isError || v.isError, false)
      r.remote.store.put({ bytes: Buffer.alloc(64 * MiB), mime: 'application/octet-stream' }, 'filler')
      const from = mock.calls.length
      const sent = (path: string) => mock.calls.slice(from).some((c) => c.path === path)

      const tts = await call(client, 'carpe_tts', { input: 'x', voice: 'long', route: 'carpe' })
      assert.equal(tts.isError, true)
      assert.match(tts.text, /MEDIA_STORE_FULL[\s\S]*Nothing was sent or paid/)
      assert.ok(!sent('/v1/audio/speech'), 'TTS not paid')

      const img = await call(client, 'carpe_image_generate', { prompt: 'a fox', model: 'z-image-turbo', route: 'carpe' })
      assert.equal(img.isError, true)
      assert.match(img.text, /MEDIA_STORE_FULL/)
      assert.ok(!sent('/v1/image/generate'), 'image not paid')

      const ms = await call(client, 'carpe_music_status', { job_id: m.structured.job_id, wait_seconds: 0 })
      assert.equal(ms.isError, true)
      assert.match(ms.text, /MEDIA_STORE_FULL[\s\S]*nothing is lost/)
      assert.ok(ms.text.includes(m.structured.job_id))
      assert.ok(!sent('/v1/audio/music/retrieve'), 'the one-shot track was not fetched')

      const vs = await call(client, 'carpe_video_status', { job_id: v.structured.job_id, wait_seconds: 0 })
      assert.equal(vs.isError, true, 'never isError:false without the video')
      assert.match(vs.text, /MEDIA_STORE_FULL/)
      assert.ok(vs.text.includes(v.structured.job_id))

      const gi = await call(client, 'carpe_image_generate', { prompt: 'x', model: 'giant-image', route: 'carpe', mode: 'queue', wait_seconds: 5 })
      assert.equal(gi.isError, true)
      const jobId = /job_id "([^"]+)"/.exec(String(gi.structured.error?.hint))?.[1]
      assert.ok(jobId, gi.text)
      await new Promise((res) => setTimeout(res, 50))
      assert.ok(!sent('/v1/image/generate/complete'), 'the operator keeps the undelivered image')

      // Room again: every job is delivered, nothing was lost.
      r.remote.store.clear()
      const ms2 = await call(client, 'carpe_music_status', { job_id: m.structured.job_id, wait_seconds: 0 })
      assert.equal(ms2.isError, false, ms2.text)
      assert.equal(ms2.structured.audio.storage, 'hosted_mcp')
      const vs2 = await call(client, 'carpe_video_status', { job_id: v.structured.job_id, wait_seconds: 0 })
      assert.equal(vs2.isError, false, vs2.text)
      const gi2 = await call(client, 'carpe_image_status', { job_id: jobId, wait_seconds: 0 })
      assert.equal(gi2.isError, false, gi2.text)
      assert.ok(await waitFor(() => sent('/v1/image/generate/complete')))
      await client.close()
    } finally {
      await r.close()
    }
  })

  test('store: TTL, budget and reservations', () => {
    let now = 1_000_000
    const s = new MediaStore(100, 'https://mcp.example', 1000, () => now)
    const a = s.put({ bytes: Buffer.alloc(40), mime: 'image/png' }, 'a')
    assert.match(a.url, /^https:\/\/mcp\.example\/media\/[A-Za-z0-9_-]{22}$/)
    assert.equal(s.free, 60)
    const hold = s.reserve(50)
    assert.equal(s.free, 10)
    assert.throws(() => s.reserve(11), (e: any) => e.code === 'MEDIA_STORE_FULL')
    assert.throws(() => s.put({ bytes: Buffer.alloc(11), mime: 'image/png' }, 'b'), (e: any) => e.code === 'MEDIA_STORE_FULL')
    hold.store({ bytes: Buffer.alloc(30), mime: 'audio/mpeg' }, 'c')
    hold.release()
    assert.equal(s.free, 30, 'the unused part of the hold is freed')
    const html = s.put({ bytes: Buffer.from('<script>'), mime: 'text/html' }, 'x')
    assert.equal(s.get(html.id)!.mime, 'application/octet-stream', 'only image/audio/video types are served as such')
    now += 1000
    assert.equal(s.get(a.id), undefined, 'expired')
    assert.equal(s.free, 100)
    assert.equal(s.get('../../etc'), undefined)
  })

  test('the store budget must hold the largest single output', () => {
    assert.throws(() => loadRemoteConfig({ CARPE_MCP_MEDIA_STORE_MB: '32' }), ConfigError)
    assert.equal(loadRemoteConfig({}).mediaStoreBytes, 256 * MiB)
    assert.throws(
      () => createRemoteApp({ cfg: loadConfig({ CARPE_MCP_REMOTE: '1', CARPE_MAX_VIDEO_BYTES: String(100 * MiB) }), remote: loadRemoteConfig({ CARPE_MCP_MEDIA_STORE_MB: '64' }), log: () => undefined }),
      /CARPE_MCP_MEDIA_STORE_MB must be at least 100/,
    )
  })
})

describe('logging', () => {
  test('logs carry method, tool, status, duration and a hashed user; never prompts, arguments, outputs or tokens', async () => {
    const r = await startRemote()
    try {
      const t = await tokenFor(r, { sub: 'private-person@example.com' })
      const { client } = await connect(r, t)
      const secret = 'SECRET-PROMPT-7f3a'
      const out = await call(client, 'carpe_chat', { prompt: secret, system: 'SYSTEM-SECRET', model: 'llama-3.3-70b' })
      assert.equal(out.isError, false)
      await call(client, 'carpe_image_edit', { prompt: secret, image: '/home/someone/private.png' })
      const bad = await fetch(`${r.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: ACCEPT }, body: `{"oops": "${secret}` })
      assert.equal(bad.status, 400)
      assert.ok(!(await bad.text()).includes(secret))
      await rpc(r, 'garbage-token-value', INIT)
      await client.close()

      const dump = JSON.stringify(r.logs)
      for (const leak of [secret, 'SYSTEM-SECRET', 'Hello!', 'private.png', t, 'garbage-token-value', 'private-person@example.com', 'Bearer']) {
        assert.ok(!dump.includes(leak), `log leaks ${leak}`)
      }
      const tool = r.logs.find((e) => e.event === 'tool' && e.tool === 'carpe_chat')!
      assert.equal(tool.outcome, 'ok')
      assert.match(String(tool.user), /^[0-9a-f]{16}$/)
      assert.equal(typeof tool.ms, 'number')
      const refused = r.logs.find((e) => e.event === 'tool' && e.tool === 'carpe_image_edit')!
      assert.equal(refused.code, 'LOCAL_FILES_DISABLED')
      const req = r.logs.find((e) => e.event === 'request' && e.tool === 'carpe_chat')!
      assert.equal(req.rpc, 'tools/call')
      assert.equal(req.status, 200)
      assert.equal(req.user, tool.user)
      assert.ok(r.logs.some((e) => e.event === 'request' && e.status === 401 && e.user === undefined))
    } finally {
      await r.close()
    }
  })
})

describe('end to end', () => {
  test('an MCP client runs the whole OAuth flow (401 → PRM → issuer → PKCE → token with aud) and calls a paid tool', async () => {
    let tokens: OAuthTokens | undefined
    let info: OAuthClientInformationMixed | undefined
    let verifier = ''
    let code: string | undefined
    const redirect = 'http://127.0.0.1:1/callback'
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return redirect
      },
      get clientMetadata() {
        return { client_name: 'e2e', redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }
      },
      clientInformation: () => info,
      saveClientInformation: (i) => {
        info = i
      },
      tokens: () => tokens,
      saveTokens: (t) => {
        tokens = t
        mock.oauthTokens.add(t.access_token)
      },
      redirectToAuthorization: async (url) => {
        // The "browser": the test issuer approves at once and redirects with a code.
        const res = await fetch(url, { redirect: 'manual' })
        code = new URL(res.headers.get('location')!).searchParams.get('code') ?? undefined
      },
      saveCodeVerifier: (v) => {
        verifier = v
      },
      codeVerifier: () => verifier,
    }
    const mcpUrl = new URL(`${srv.url}/mcp`)
    let transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })
    let client = new Client({ name: 'e2e', version: '0.0.0' })
    await assert.rejects(client.connect(transport), UnauthorizedError)
    assert.ok(code, 'authorization code received')
    await transport.finishAuth(code!)
    const access = tokens!.access_token
    const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(payload.aud, srv.url, 'RFC 8707: the client asked for this resource, the issuer put it in aud')
    assert.equal(payload.iss, issuer.url)

    transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider })
    client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(transport)
    const r = await call(client, 'carpe_chat', { prompt: 'hi', model: 'llama-3.3-70b' })
    assert.equal(r.isError, false, r.text)
    assert.equal([...mock.calls].reverse().find((c) => c.path === '/v1/chat/completions')!.headers.authorization, `Bearer ${access}`)
    await client.close()
  })

  test('the built CLI: --remote refuses a server-held key, and serves an MCP client with an issuer token', async () => {
    const cli = join(root, 'dist', 'cli.js')
    const refused = spawn(process.execPath, [cli, '--remote'], { env: { PATH: process.env.PATH, CARPE_API_KEY: KEY }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    refused.stderr.on('data', (d) => (err += d))
    const exitCode = await new Promise<number | null>((r) => refused.on('exit', r))
    assert.equal(exitCode, 1)
    assert.match(err, /configuration error: CARPE_API_KEY must not be set in remote mode/)

    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    const url = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, [cli, '--remote', '--port', String(port)], {
      env: { PATH: process.env.PATH, CARPE_TEST_BASE_URL: mock.base, CARPE_OAUTH_ISSUER: issuer.url, CARPE_MCP_PUBLIC_URL: url },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let logs = ''
    child.stderr.on('data', (d) => (logs += d))
    try {
      for (let i = 0; i < 100 && !logs.includes('remote mode on'); i++) await new Promise((r) => setTimeout(r, 50))
      assert.match(logs, /remote mode on/)
      const t = await issuer.mint({ aud: url, sub: 'cli-user' })
      mock.oauthTokens.add(t)
      const { client } = await connect({ url } as Remote, t)
      const names = (await client.listTools()).tools.map((x) => x.name)
      assert.ok(names.includes('carpe_chat') && !names.includes('carpe_voice_clone'))
      const r = await call(client, 'carpe_chat', { prompt: 'CLI-PROMPT-SECRET', model: 'llama-3.3-70b' })
      assert.equal(r.isError, false, r.text)
      await client.close()
      assert.ok(!logs.includes('CLI-PROMPT-SECRET') && !logs.includes(t), 'process logs carry no prompt and no token')
      assert.match(logs, /"event":"tool","tool":"carpe_chat","outcome":"ok"/)
    } finally {
      child.kill()
    }
  })
})
