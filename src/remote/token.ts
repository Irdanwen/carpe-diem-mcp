/**
 * Access-token validation for remote mode (OAuth 2.1 resource server).
 *
 * Every request's bearer token must be a JWT that:
 *   - is signed with a key of the issuer's JWKS (fetched over https, cached,
 *     refetched on an unknown `kid` so key rotation needs no restart);
 *   - uses an allowed asymmetric algorithm (ES256 by default; never `none`/HS*);
 *   - has `iss` = the configured issuer, exactly;
 *   - has `aud` naming this server's resource URL (RFC 8707). Without this
 *     check a token minted for another service (e.g. an id_token for a website
 *     client) could be replayed here: token confusion;
 *   - has `exp` (and `nbf` / `iat` when present) valid within a small skew;
 *   - has a `sub`: every session and spend guard is keyed by it.
 *
 * jose does the JWS work. It is already installed as a dependency of
 * @modelcontextprotocol/sdk (the SDK verifies nothing on the resource-server
 * side, and viem has no JOSE support), so declaring it adds no new package.
 */
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js'
import type { RemoteConfig } from './config.js'

/** Resource identifiers compare without a fragment and without one trailing slash (as the SDK does). */
export function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.split('#')[0].replace(/\/$/, '')
  return norm(a) === norm(b)
}

/** RFC 9068 `scope` (space-delimited), or a `scp` array as some issuers emit. */
export function scopesOf(payload: JWTPayload): string[] {
  if (typeof payload.scope === 'string') return payload.scope.split(' ').filter(Boolean)
  if (Array.isArray(payload.scp)) return payload.scp.filter((s): s is string => typeof s === 'string')
  return []
}

/** Error descriptions end up in a quoted WWW-Authenticate parameter: fixed strings only, never token content. */
function describe(err: unknown): InvalidTokenError | ServerError {
  if (err instanceof joseErrors.JWTExpired) return new InvalidTokenError('Token has expired')
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return new InvalidTokenError('Unexpected token issuer')
    if (err.claim === 'nbf' || err.claim === 'iat') return new InvalidTokenError('Token is not valid yet')
    if (err.claim === 'sub') return new InvalidTokenError('Token has no subject')
    return new InvalidTokenError('Token claims are invalid')
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return new InvalidTokenError('Invalid token signature')
  if (err instanceof joseErrors.JWKSNoMatchingKey) return new InvalidTokenError('Token signed by an unknown key')
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return new InvalidTokenError('Token algorithm not allowed')
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return new InvalidTokenError('Malformed token')
  // JWKS unreachable, timeout, bad JWKS document: our problem, not the client's token.
  return new ServerError('Authorization server keys are unavailable')
}

export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  private discovering: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined

  constructor(
    private readonly rc: RemoteConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The JWKS, from CARPE_OAUTH_JWKS_URL or the issuer's metadata (not cached on failure). */
  private keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.jwks) return Promise.resolve(this.jwks)
    this.discovering ??= (async () => {
      let uri = this.rc.jwksUrl
      if (!uri) {
        const meta = await discoverAuthorizationServerMetadata(this.rc.issuer, { fetchFn: this.fetchImpl })
        if (!meta) throw new Error('No authorization server metadata at the issuer')
        // RFC 8414 §3.3: the metadata must name the very issuer it was fetched for.
        if (!sameResource(meta.issuer, this.rc.issuer)) throw new Error('Authorization server metadata names another issuer')
        if (typeof meta.jwks_uri !== 'string' || !meta.jwks_uri) throw new Error('Authorization server metadata has no jwks_uri')
        uri = meta.jwks_uri
      }
      const url = new URL(uri as string)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname))) {
        throw new Error('jwks_uri must use https')
      }
      // Rotation: an unknown kid triggers a refetch (at most every 30 s); keys are refreshed every 10 min anyway.
      this.jwks = createRemoteJWKSet(url, { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      return this.jwks
    })().finally(() => {
      this.discovering = undefined
    })
    return this.discovering
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload
    try {
      const keys = await this.keySet()
      ;({ payload } = await jwtVerify(token, keys, {
        issuer: this.rc.issuer,
        algorithms: this.rc.algorithms,
        clockTolerance: this.rc.clockToleranceSec,
        requiredClaims: ['exp', 'sub'],
      }))
    } catch (err) {
      throw describe(err)
    }
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud !== undefined ? [payload.aud] : []
    if (!aud.some((a) => typeof a === 'string' && sameResource(a, this.rc.resource))) {
      throw new InvalidTokenError('Token was not issued for this resource')
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new InvalidTokenError('Token has no subject')
    return {
      token,
      clientId: typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : '',
      scopes: scopesOf(payload),
      // requireBearerAuth compares this with the clock again, without skew: hand it the tolerated expiry.
      expiresAt: (payload.exp as number) + this.rc.clockToleranceSec,
      resource: new URL(this.rc.resource),
      extra: { sub: payload.sub },
    }
  }
}
