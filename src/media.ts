/**
 * Media input (URL, data URI, local file) and output (inline MCP block or file).
 *
 * Security: in HTTP mode the server may be reached by remote clients, so local
 * file reads are off and URL inputs are limited to public http(s) hosts
 * (literal private / loopback addresses and localhost names are refused).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isIP } from 'node:net'
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomUUID } from 'node:crypto'
import { LocalRefusal } from './errors.js'

export interface MediaPolicy {
  allowLocalFiles: boolean
  outputDir: string | undefined
  maxInputBytes: number
}

export interface LoadedMedia {
  bytes: Buffer
  mime: string
}

export function sniffMime(b: Buffer): string | undefined {
  const hex = b.subarray(0, 12).toString('hex')
  const ascii = b.subarray(0, 12).toString('latin1')
  if (hex.startsWith('89504e47')) return 'image/png'
  if (hex.startsWith('ffd8ff')) return 'image/jpeg'
  if (ascii.startsWith('GIF8')) return 'image/gif'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav'
  if (ascii.startsWith('fLaC')) return 'audio/flac'
  if (ascii.startsWith('OggS')) return 'audio/ogg'
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) return 'audio/mpeg'
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12)
    if (/^(M4A |M4B )/.test(brand)) return 'audio/mp4'
    if (/^(qt  )/.test(brand)) return 'video/quicktime'
    return 'video/mp4'
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm'
  if (ascii.startsWith('%PDF')) return 'application/pdf'
  return undefined
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/pcm': 'pcm', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}
export const extFor = (mime: string) => EXT[mime] ?? 'bin'

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v = isIP(h)
  if (v === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (v === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')
  return false
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/**
 * GET a public URL with a byte cap. In strict mode (HTTP transport) every
 * address the hostname resolves to is checked at connect time — inside the
 * socket's own DNS lookup, so a rebinding cannot swap it after the check — and
 * each redirect hop goes through the same check.
 */
export function fetchBounded(url: URL, maxBytes: number, strict: boolean, redirects = 3, deadline = Date.now() + 60_000): Promise<{ bytes: Buffer; contentType: string }> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.reject(new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} timed out.`))
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.reject(new LocalRefusal('URL_REFUSED', 'Only http(s) URLs are accepted.'))
  if (strict && isPrivateHost(url.hostname)) return Promise.reject(new LocalRefusal('URL_REFUSED', 'Private, loopback and local hosts are refused in HTTP mode.'))
  const lookup = strict
    ? (hostname: string, options: LookupOptions, cb: LookupCb) => {
        dnsLookup(hostname, options, (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
          if (err) return cb(err, address, family)
          const list = Array.isArray(address) ? address.map((a) => a.address) : [address]
          if (list.some((ip) => isPrivateHost(ip))) return cb(Object.assign(new Error('URL resolves to a private address'), { code: 'URL_REFUSED' }), address, family)
          cb(null, address, family)
        })
      }
    : undefined
  return new Promise((resolve, reject) => {
    // One deadline for the whole download, redirects included (an idle timeout alone lets a slow server drip forever).
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', lookup: lookup as never, signal: AbortSignal.timeout(remaining), headers: { 'user-agent': 'carpe-diem-mcp' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new LocalRefusal('URL_FETCH_FAILED', 'Too many redirects.'))
        return resolve(fetchBounded(new URL(res.headers.location, url), maxBytes, strict, redirects - 1, deadline))
      }
      if (status < 200 || status >= 300) {
        res.resume()
        return reject(new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} answered HTTP ${status}.`))
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy()
        return reject(new LocalRefusal('MEDIA_TOO_LARGE', `Remote file is ${declared} bytes, above the ${maxBytes}-byte limit.`))
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > maxBytes) {
          res.destroy()
          reject(new LocalRefusal('MEDIA_TOO_LARGE', `Remote file is above the ${maxBytes}-byte limit.`))
        } else chunks.push(c)
      })
      res.on('end', () => resolve({ bytes: Buffer.concat(chunks, total), contentType: String(res.headers['content-type'] ?? '') }))
      res.on('error', (e: Error) => reject(e.name === 'AbortError' ? new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} timed out.`) : e))
    })
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(e instanceof LocalRefusal ? e : e.name === 'AbortError' ? new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} timed out.`) : e.code === 'URL_REFUSED' ? new LocalRefusal('URL_REFUSED', 'The URL resolves to a private or loopback address; refused in HTTP mode.') : new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} failed: ${e.message}`)),
    )
    req.end()
  })
}

/** Resolve an input: data URI, http(s) URL, or (stdio only) a local path. */
export async function loadMedia(input: string, policy: MediaPolicy, fallbackMime?: string): Promise<LoadedMedia> {
  const s = input.trim()
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s)
  if (data) {
    const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]), 'utf8')
    if (bytes.length === 0) throw new LocalRefusal('BAD_MEDIA', 'The data URI is empty or not valid base64.')
    if (bytes.length > policy.maxInputBytes) throw new LocalRefusal('MEDIA_TOO_LARGE', `Input is ${bytes.length} bytes, above the ${policy.maxInputBytes}-byte limit.`)
    return { bytes, mime: data[1] ?? sniffMime(bytes) ?? fallbackMime ?? 'application/octet-stream' }
  }
  if (/^https?:\/\//i.test(s)) {
    const { bytes, contentType } = await fetchBounded(new URL(s), policy.maxInputBytes, !policy.allowLocalFiles)
    const ct = contentType.split(';')[0].trim()
    return { bytes, mime: sniffMime(bytes) ?? (ct && ct !== 'application/octet-stream' ? ct : fallbackMime ?? 'application/octet-stream') }
  }
  if (!policy.allowLocalFiles) throw new LocalRefusal('LOCAL_FILES_DISABLED', 'Pass a data: URI or an https:// URL (local paths are disabled in HTTP mode).')
  const path = s.startsWith('~/') ? join(homedir(), s.slice(2)) : isAbsolute(s) ? s : resolve(s)
  let size: number
  try {
    size = statSync(path).size
  } catch {
    throw new LocalRefusal('FILE_NOT_FOUND', `No such file: ${path}. Pass an absolute path, a data: URI or an https:// URL.`)
  }
  if (size > policy.maxInputBytes) throw new LocalRefusal('MEDIA_TOO_LARGE', `${path} is ${size} bytes, above the ${policy.maxInputBytes}-byte limit.`)
  const bytes = readFileSync(path)
  return { bytes, mime: sniffMime(bytes) ?? fallbackMime ?? 'application/octet-stream' }
}

export const toDataUri = (m: LoadedMedia) => `data:${m.mime};base64,${m.bytes.toString('base64')}`

/** Decode a base64 image the operator returned (raw or data URI). */
export function decodeBase64Media(s: string): LoadedMedia {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(s)
  const bytes = Buffer.from(m ? m[2] : s, 'base64')
  return { bytes, mime: sniffMime(bytes) ?? m?.[1] ?? 'application/octet-stream' }
}

/** Write media to CARPE_OUTPUT_DIR (or the temp dir when `force`). Returns the path. */
export function saveMedia(media: LoadedMedia, prefix: string, policy: MediaPolicy, force = false): string | undefined {
  const dir = policy.outputDir ?? (force ? join(tmpdir(), 'carpe-mcp') : undefined)
  if (!dir) return undefined
  mkdirSync(dir, { recursive: true })
  const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.${extFor(media.mime)}`
  const path = join(dir, name)
  writeFileSync(path, media.bytes)
  return path
}
