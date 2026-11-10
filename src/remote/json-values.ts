/**
 * Remote mode: what a JSON body costs once parsed is set by its number of
 * values, not its size. `[{},{},…]` in 40 MB is ~14 million objects, about
 * 64 bytes of heap each (~850 MiB): more than the whole V8 heap. So the
 * values are counted BEFORE `JSON.parse`, and a body with too many is refused
 * without being parsed.
 *
 * A linear scan of the raw bytes counts `{`, `[` and `,` outside strings:
 * every value but the first follows one of them, so the count bounds the
 * number of values (keys included). Strings are skipped with `indexOf`, so a
 * media `data:` URI (one long string) costs one native search and counts for
 * nothing. Escapes are handled (a `"` preceded by an odd run of `\` is inside
 * the string). UTF-8 continuation bytes are ≥ 0x80, so they never look like
 * one of these ASCII characters.
 */

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_OBJECT = 0x7b
const OPEN_ARRAY = 0x5b
const COMMA = 0x2c

/**
 * The number of `{`, `[` and `,` outside strings in `buf`, counting stopped as
 * soon as it exceeds `stopAbove` (a refused body is not scanned to its end).
 * Malformed JSON is not reported here: `JSON.parse` refuses it afterwards.
 */
export function countJsonValues(buf: Uint8Array, stopAbove = Infinity): number {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const len = b.length
  let n = 0
  let i = 0
  while (i < len) {
    const c = b[i]
    if (c === QUOTE) {
      // Jump to the closing quote: the first one not escaped by an odd run of backslashes.
      let j = i
      for (;;) {
        j = b.indexOf(QUOTE, j + 1)
        if (j < 0) return n // unterminated string: JSON.parse refuses it
        let k = j - 1
        while (b[k] === BACKSLASH) k-- // stops at the opening quote at the latest
        if ((j - 1 - k) % 2 === 0) break
      }
      i = j + 1
      continue
    }
    if (c === OPEN_OBJECT || c === OPEN_ARRAY || c === COMMA) {
      if (++n > stopAbove) return n
    }
    i++
  }
  return n
}
