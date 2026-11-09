/**
 * A local OAuth 2.1 authorization server for the remote-mode tests, standing in
 * for compte.carpe-diem.xyz (lot B1):
 *   - RFC 8414 metadata and a JWKS (ES256, `kid`), over plain http on loopback;
 *   - `mint()` signs access tokens with any iss / aud / sub / scope / exp / nbf,
 *     or with a key the JWKS does not publish (bad signature);
 *   - a minimal authorization-code + PKCE flow with dynamic registration and an
 *     auto-approving /authorize, so the SDK's OAuth client can run end to end.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose'

export interface MintOptions {
  sub?: string
  scope?: string
  aud?: string | string[]
  iss?: string
  /** Seconds from now (negative = already expired). */
  expiresIn?: number
  /** Seconds from now. */
  notBefore?: number
  /** Sign with a key that is not in the JWKS. */
  rogueKey?: boolean
  alg?: 'ES256'
}

export interface TestIssuer {
  url: string
  /** The resource the tokens are minted for by default. */
  resource: string
  mint: (o?: MintOptions) => Promise<string>
  /** Tokens issued by the /token endpoint. */
  issued: string[]
  close: () => Promise<void>
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export async function startIssuer(resource: string, opts: { sub?: string; scope?: string } = {}): Promise<TestIssuer> {
  const kid = 'test-key-1'
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const rogue = await generateKeyPair('ES256')
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' }
  const codes = new Map<string, { challenge: string; resource: string | null; scope: string; redirect: string }>()
  const clients = new Map<string, { redirect_uris: string[] }>()
  const issued: string[] = []
  let url = ''

  const mint = async (o: MintOptions = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000)
    const key: CryptoKey = o.rogueKey ? rogue.privateKey : privateKey
    let jwt = new SignJWT({ scope: o.scope ?? 'carpe:inference carpe:account.read', client_id: 'test-client' })
      .setProtectedHeader({ alg: o.alg ?? 'ES256', kid, typ: 'at+jwt' })
      .setIssuer(o.iss ?? url)
      .setSubject(o.sub ?? 'user-a')
      .setAudience(o.aud ?? resource)
      .setIssuedAt(now)
      .setJti(randomUUID())
      .setExpirationTime(now + (o.expiresIn ?? 3600))
    if (o.notBefore !== undefined) jwt = jwt.setNotBefore(now + o.notBefore)
    return jwt.sign(key)
  }

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        registration_endpoint: `${url}/register`,
        jwks_uri: `${url}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['carpe:inference', 'carpe:account.read'],
      })
    }
    if (req.method === 'GET' && u.pathname === '/jwks') return json(200, { keys: [jwk] })
    if (req.method === 'POST' && u.pathname === '/register') {
      const meta = await readJson(req)
      const client_id = `client-${randomUUID()}`
      clients.set(client_id, { redirect_uris: meta.redirect_uris ?? [] })
      return json(201, { ...meta, client_id, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: 'none' })
    }
    if (req.method === 'GET' && u.pathname === '/authorize') {
      // Auto-approve (the consent screen of B1 is out of scope here), with the checks a real server makes.
      const client = clients.get(u.searchParams.get('client_id') ?? '')
      const redirect = u.searchParams.get('redirect_uri') ?? ''
      if (!client || !client.redirect_uris.includes(redirect)) return json(400, { error: 'invalid_request' })
      if (u.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' })
      const code = randomUUID()
      codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? '', resource: u.searchParams.get('resource'), scope: u.searchParams.get('scope') ?? opts.scope ?? '', redirect })
      const to = new URL(redirect)
      to.searchParams.set('code', code)
      if (u.searchParams.get('state')) to.searchParams.set('state', u.searchParams.get('state')!)
      res.writeHead(302, { location: to.href })
      return res.end()
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      const form = await readForm(req)
      const entry = codes.get(form.get('code') ?? '')
      if (!entry) return json(400, { error: 'invalid_grant' })
      codes.delete(form.get('code')!)
      const verifier = form.get('code_verifier') ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return json(400, { error: 'invalid_grant' })
      if (form.get('redirect_uri') !== entry.redirect) return json(400, { error: 'invalid_grant' })
      // RFC 8707: the requested resource becomes the audience.
      const access = await mint({ sub: opts.sub ?? 'user-oauth', scope: entry.scope, aud: entry.resource ?? 'missing-resource' })
      issued.push(access)
      return json(200, { access_token: access, token_type: 'Bearer', expires_in: 3600, scope: entry.scope })
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, resource, mint, issued, close: () => new Promise<void>((r) => server.close(() => r())) }
}
