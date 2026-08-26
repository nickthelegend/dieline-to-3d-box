/**
 * A small, dependency-free PDF object reader.
 *
 * We only need enough of PDF to answer one question: "what lines are drawn on
 * page 1, and what colour is each of them?". So instead of following the xref
 * table we brute-force scan the file for `N G obj ... endobj` blocks. That is
 * both shorter and more forgiving of the slightly-broken files that CAD and
 * prepress tools emit.
 */

export type PdfName = { name: string }
export type PdfRef = { num: number; gen: number }
export type PdfDict = Map<string, PdfValue>
export type PdfStream = { dict: PdfDict; raw: Uint8Array }
export type PdfValue =
  | number | boolean | null | string
  | PdfName | PdfRef | PdfDict | PdfStream | PdfValue[]

type Maybe = PdfValue | undefined

export const isName = (v: Maybe): v is PdfName => !!v && typeof v === 'object' && 'name' in (v as object)
export const isRef = (v: Maybe): v is PdfRef => !!v && typeof v === 'object' && 'num' in (v as object) && 'gen' in (v as object)
export const isDict = (v: Maybe): v is PdfDict => v instanceof Map
export const isStream = (v: Maybe): v is PdfStream => !!v && typeof v === 'object' && 'raw' in (v as object)

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c)

/** Cursor-based reader over the raw file bytes. */
export class Lexer {
  pos = 0
  constructor(readonly buf: Uint8Array) {}

  skipWhite() {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]
      if (WS.has(c)) { this.pos++; continue }
      if (c === 0x25) { // '%' comment runs to end of line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++
        continue
      }
      break
    }
  }

  /** Reads one token's worth of regular characters (numbers, keywords). */
  readRegular(): string {
    const start = this.pos
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++
    return latin1(this.buf, start, this.pos)
  }

  peekKeyword(): string {
    const save = this.pos
    this.skipWhite()
    const k = this.readRegular()
    this.pos = save
    return k
  }

  /** Parses one PDF object at the cursor. Returns `undefined` at a keyword. */
  parseObject(): PdfValue | undefined {
    this.skipWhite()
    if (this.pos >= this.buf.length) return undefined
    const c = this.buf[this.pos]

    if (c === 0x2f) return this.parseName()
    if (c === 0x28) return this.parseLiteralString()
    if (c === 0x5b) return this.parseArray()
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) return this.parseDictOrStream()
      return this.parseHexString()
    }
    if (c === 0x5d || c === 0x3e) return undefined // caller handles the closer

    const word = this.readRegular()
    if (word === '') { this.pos++; return undefined }
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null

    if (/^[-+.\d]/.test(word)) {
      const n = parseFloat(word)
      // `12 0 R` — an indirect reference. Look ahead before committing.
      if (Number.isInteger(n) && n >= 0) {
        const save = this.pos
        this.skipWhite()
        const gen = this.readRegular()
        if (/^\d+$/.test(gen)) {
          this.skipWhite()
          const kw = this.readRegular()
          if (kw === 'R') return { num: n, gen: parseInt(gen, 10) }
        }
        this.pos = save
      }
      return Number.isNaN(n) ? 0 : n
    }
    // A bare keyword (obj / endobj / stream / an operator): rewind so the
    // caller can decide what to do with it.
    this.pos -= word.length
    return undefined
  }

  parseName(): PdfName {
    this.pos++ // '/'
    let out = ''
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) {
      let ch = this.buf[this.pos++]
      if (ch === 0x23 && this.pos + 1 < this.buf.length) { // '#xx' escape
        const hex = latin1(this.buf, this.pos, this.pos + 2)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { ch = parseInt(hex, 16); this.pos += 2 }
      }
      out += String.fromCharCode(ch)
    }
    return { name: out }
  }

  parseLiteralString(): string {
    this.pos++ // '('
    let depth = 1, out = ''
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos++]
      if (ch === 0x5c) { out += String.fromCharCode(this.buf[this.pos++]); continue }
      if (ch === 0x28) depth++
      if (ch === 0x29 && --depth === 0) break
      out += String.fromCharCode(ch)
    }
    return out
  }

  parseHexString(): string {
    this.pos++ // '<'
    let hex = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const ch = this.buf[this.pos++]
      if (!WS.has(ch)) hex += String.fromCharCode(ch)
    }
    this.pos++ // '>'
    if (hex.length % 2) hex += '0'
    let out = ''
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
    return out
  }

  parseArray(): PdfValue[] {
    this.pos++ // '['
    const out: PdfValue[] = []
    for (;;) {
      this.skipWhite()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x5d) { this.pos++; break }
      const before = this.pos
      const v = this.parseObject()
      if (v === undefined) { if (this.pos === before) this.pos++; continue }
      out.push(v)
    }
    return out
  }

  parseDictOrStream(): PdfDict | PdfStream {
    this.pos += 2 // '<<'
    const dict: PdfDict = new Map()
    for (;;) {
      this.skipWhite()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break }
      if (this.buf[this.pos] !== 0x2f) { // resync on malformed content
        const before = this.pos
        this.parseObject()
        if (this.pos === before) this.pos++
        continue
      }
      const key = this.parseName().name
      const val = this.parseObject()
      if (val !== undefined) dict.set(key, val)
    }

    // A stream body may follow the dictionary.
    const save = this.pos
    this.skipWhite()
    if (latin1(this.buf, this.pos, this.pos + 6) === 'stream') {
      this.pos += 6
      if (this.buf[this.pos] === 0x0d) this.pos++
      if (this.buf[this.pos] === 0x0a) this.pos++
      const start = this.pos
      const declared = dict.get('Length')
      let end = -1
      if (typeof declared === 'number' && declared >= 0 && start + declared <= this.buf.length) {
        const probe = start + declared
        // Trust /Length only if `endstream` really is where it says.
        const tail = latin1(this.buf, probe, probe + 20)
        if (/^\s*endstream/.test(tail)) end = probe
      }
      if (end < 0) end = indexOfAscii(this.buf, 'endstream', start)
      if (end < 0) end = this.buf.length
      const raw = this.buf.subarray(start, trimEol(this.buf, start, end))
      this.pos = end + 'endstream'.length
      return { dict, raw }
    }
    this.pos = save
    return dict
  }
}

export function latin1(buf: Uint8Array, from = 0, to = buf.length): string {
  let out = ''
  const end = Math.min(to, buf.length)
  for (let i = from; i < end; i += 8192) {
    out += String.fromCharCode(...buf.subarray(i, Math.min(i + 8192, end)))
  }
  return out
}

export function indexOfAscii(buf: Uint8Array, needle: string, from = 0): number {
  const n0 = needle.charCodeAt(0)
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    if (buf[i] !== n0) continue
    for (let j = 1; j < needle.length; j++) if (buf[i + j] !== needle.charCodeAt(j)) continue outer
    return i
  }
  return -1
}

function trimEol(buf: Uint8Array, start: number, end: number): number {
  let e = end
  if (e > start && buf[e - 1] === 0x0a) e--
  if (e > start && buf[e - 1] === 0x0d) e--
  return e
}
