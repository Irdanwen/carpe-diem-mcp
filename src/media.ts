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
    const url = new URL(s)
    if (!policy.allowLocalFiles && isPrivateHost(url.hostname)) {
      throw new LocalRefusal('URL_REFUSED', 'Private, loopback and local hostnames are refused in HTTP mode.')
    }
    // In HTTP mode a redirect could point at a private host: refuse redirects there.
    const res = await fetch(url, { redirect: policy.allowLocalFiles ? 'follow' : 'error', signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new LocalRefusal('URL_FETCH_FAILED', `Fetching ${url.host} answered HTTP ${res.status}.`)
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > policy.maxInputBytes) throw new LocalRefusal('MEDIA_TOO_LARGE', `Remote file is ${declared} bytes, above the ${policy.maxInputBytes}-byte limit.`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > policy.maxInputBytes) throw new LocalRefusal('MEDIA_TOO_LARGE', `Remote file is above the ${policy.maxInputBytes}-byte limit.`)
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim()
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
