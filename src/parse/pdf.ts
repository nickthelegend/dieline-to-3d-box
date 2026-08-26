import {
  Lexer, latin1, indexOfAscii,
  isDict, isName, isRef, isStream,
  type PdfDict, type PdfStream, type PdfValue,
} from './pdfLexer'
import { classifyStroke, type StrokeStyle } from './classify'
import type { Dieline, Segment, Vec2 } from '../geom/types'

/* ------------------------------------------------------------------ *
 * Document: brute-force object scan + FlateDecode
 * ------------------------------------------------------------------ */

class PdfDocument {
  private objects = new Map<number, PdfValue>()

  private constructor(readonly buf: Uint8Array) {}

  static async load(buf: Uint8Array): Promise<PdfDocument> {
    const doc = new PdfDocument(buf)
    doc.scanObjects()
    await doc.expandObjectStreams()
    return doc
  }

  /** Find every `N G obj ... endobj` in the file, wherever the xref says they are. */
  private scanObjects() {
    const text = latin1(this.buf)
    const re = /(\d+)\s+(\d+)\s+obj\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const lex = new Lexer(this.buf)
      lex.pos = m.index + m[0].length
      const val = lex.parseObject()
      if (val !== undefined) this.objects.set(parseInt(m[1], 10), val)
    }
  }

  /** PDF 1.5+ packs most objects inside compressed /ObjStm streams. Unpack them. */
  private async expandObjectStreams() {
    for (const val of [...this.objects.values()]) {
      if (!isStream(val)) continue
      const type = val.dict.get('Type')
      if (!isName(type) || type.name !== 'ObjStm') continue
      const data = await decodeStream(val, this)
      const n = num(this.resolve(val.dict.get('N')), 0)
      const first = num(this.resolve(val.dict.get('First')), 0)
      const header = latin1(data, 0, first).trim().split(/\s+/).map(Number)
      for (let i = 0; i < n; i++) {
        const objNum = header[i * 2]
        const offset = header[i * 2 + 1]
        if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue
        const lex = new Lexer(data)
        lex.pos = first + offset
        const parsed = lex.parseObject()
        if (parsed !== undefined && !this.objects.has(objNum)) this.objects.set(objNum, parsed)
      }
    }
  }

  resolve(v: PdfValue | undefined): PdfValue | undefined {
    let guard = 0
    while (isRef(v) && guard++ < 32) v = this.objects.get(v.num)
    return v
  }

  dictGet(d: PdfDict | undefined, key: string): PdfValue | undefined {
    return d ? this.resolve(d.get(key)) : undefined
  }

  /** The first /Type /Page, with /Resources and /MediaBox inherited from its parents. */
  firstPage(): { dict: PdfDict; resources: PdfDict; mediaBox: number[] } | null {
    for (const val of this.objects.values()) {
      const d = isStream(val) ? val.dict : val
      if (!isDict(d)) continue
      const type = this.resolve(d.get('Type'))
      if (!isName(type) || type.name !== 'Page') continue

      let resources: PdfDict = new Map()
      let mediaBox = [0, 0, 612, 792]
      // Walk up the page tree for inheritable attributes.
      let node: PdfValue | undefined = d
      for (let i = 0; i < 32 && isDict(node); i++) {
        const r = this.dictGet(node, 'Resources')
        if (isDict(r) && resources.size === 0) resources = r
        const mb = this.dictGet(node, 'MediaBox')
        if (Array.isArray(mb) && mb.length === 4) mediaBox = mb.map((x) => num(this.resolve(x), 0))
        node = this.dictGet(node, 'Parent')
      }
      return { dict: d, resources, mediaBox }
    }
    return null
  }

  /** Concatenated, decompressed content stream for a page. */
  async pageContent(page: PdfDict): Promise<Uint8Array> {
    const contents = this.resolve(page.get('Contents'))
    const streams = Array.isArray(contents)
      ? contents.map((c) => this.resolve(c)).filter(isStream)
      : isStream(contents) ? [contents] : []
    const parts: Uint8Array[] = []
    for (const s of streams) {
      parts.push(await decodeStream(s, this))
      parts.push(new Uint8Array([0x0a]))
    }
    return concat(parts)
  }
}

const num = (v: PdfValue | undefined, dflt: number) => (typeof v === 'number' ? v : dflt)

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Apply a stream's /Filter chain. We only need Flate (zlib or raw deflate). */
async function decodeStream(s: PdfStream, doc: PdfDocument): Promise<Uint8Array> {
  const filter = doc.dictGet(s.dict, 'Filter')
  const names = (Array.isArray(filter) ? filter : [filter])
    .map((f) => doc.resolve(f))
    .filter(isName)
    .map((f) => f.name)
  let data = s.raw
  for (const name of names) {
    if (name === 'FlateDecode' || name === 'Fl') data = await inflate(data)
    else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHexDecode(data)
    else throw new Error(`Unsupported PDF stream filter: /${name}`)
  }
  return data
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(format)
      const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch { /* try the next framing */ }
  }
  throw new Error('Could not inflate a PDF stream (not zlib or raw deflate).')
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const hex = latin1(data).replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/* ------------------------------------------------------------------ *
 * Content stream interpreter
 * ------------------------------------------------------------------ */

/** 2D affine matrix as PDF stores it: [a b c d e f]. */
type Mat = [number, number, number, number, number, number]
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]
const apply = (m: Mat, x: number, y: number): Vec2 => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
})

type GState = { ctm: Mat; stroke: StrokeStyle }
const cloneState = (g: GState): GState => ({ ctm: [...g.ctm] as Mat, stroke: { ...g.stroke } })

/** Flatten a cubic Bezier. 12 steps keeps rounded tuck corners smooth enough to close. */
function flattenCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, out: Vec2[], steps = 12) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
}

/** Resolve `/Name CS` against the resource dictionary into a colorant name. */
function colorantNameOf(csValue: PdfValue | undefined, doc: PdfDocument): string | null {
  const v = doc.resolve(csValue)
  if (isName(v)) return v.name
  if (Array.isArray(v) && v.length >= 2) {
    const family = doc.resolve(v[0])
    if (isName(family) && family.name === 'Separation') {
      const c = doc.resolve(v[1])
      return isName(c) ? c.name : null
    }
    if (isName(family) && family.name === 'DeviceN') {
      const names = doc.resolve(v[1])
      if (Array.isArray(names)) {
        return names.map((n) => doc.resolve(n)).filter(isName).map((n) => n.name).join('+')
      }
    }
    if (isName(family)) return family.name
  }
  return null
}

const cmykToRgb = (c: number, m: number, y: number, k: number): [number, number, number] =>
  [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]

/**
 * Walks the drawing operators and emits one classified `Segment` per stroked
 * line. Recurses into Form XObjects, which is where Illustrator likes to hide
 * the artwork.
 */
function runContentStream(
  content: Uint8Array,
  resources: PdfDict,
  doc: PdfDocument,
  base: Mat,
  out: Segment[],
  colorants: Set<string>,
  depth = 0,
) {
  if (depth > 8) return

  const lex = new Lexer(content)
  const stack: PdfValue[] = []
  const gsStack: GState[] = []
  let gs: GState = { ctm: base, stroke: { colorantName: null, rgb: null, dashed: false } }

  let path: Vec2[][] = []
  let sub: Vec2[] = []
  let cur: Vec2 = { x: 0, y: 0 }
  let start: Vec2 = { x: 0, y: 0 }

  const nums = (n: number): number[] => {
    const vals = stack.slice(-n).map((v) => (typeof v === 'number' ? v : 0))
    while (vals.length < n) vals.unshift(0)
    return vals
  }
  const moveTo = (p: Vec2) => { if (sub.length > 1) path.push(sub); sub = [p]; cur = p; start = p }
  const lineTo = (p: Vec2) => { sub.push(p); cur = p }

  const emit = () => {
    if (sub.length > 1) path.push(sub)
    sub = []
    const type = classifyStroke(gs.stroke)
    if (gs.stroke.colorantName) colorants.add(gs.stroke.colorantName)
    for (const poly of path) {
      for (let i = 0; i + 1 < poly.length; i++) out.push({ a: poly[i], b: poly[i + 1], type })
    }
    path = []
  }

  for (;;) {
    lex.skipWhite()
    if (lex.pos >= content.length) break
    const before = lex.pos
    const value = lex.parseObject()
    if (value !== undefined) { stack.push(value); continue }
    if (lex.pos === before) {
      const op = lex.readRegular()
      if (op === '') { lex.pos++; continue }
      handleOp(op)
      stack.length = 0
    }
  }
  emit()

  function handleOp(op: string) {
    switch (op) {
      case 'q': gsStack.push(cloneState(gs)); break
      case 'Q': { const p = gsStack.pop(); if (p) gs = p; break }
      case 'cm': { const [a, b, c, d, e, f] = nums(6); gs.ctm = mul([a, b, c, d, e, f], gs.ctm); break }

      case 'm': { const [x, y] = nums(2); moveTo(apply(gs.ctm, x, y)); break }
      case 'l': { const [x, y] = nums(2); lineTo(apply(gs.ctm, x, y)); break }
      case 'c': {
        const [x1, y1, x2, y2, x3, y3] = nums(6)
        flattenCubic(cur, apply(gs.ctm, x1, y1), apply(gs.ctm, x2, y2), apply(gs.ctm, x3, y3), sub)
        cur = apply(gs.ctm, x3, y3); break
      }
      case 'v': {
        const [x2, y2, x3, y3] = nums(4)
        flattenCubic(cur, cur, apply(gs.ctm, x2, y2), apply(gs.ctm, x3, y3), sub)
        cur = apply(gs.ctm, x3, y3); break
      }
      case 'y': {
        const [x1, y1, x3, y3] = nums(4)
        const end = apply(gs.ctm, x3, y3)
        flattenCubic(cur, apply(gs.ctm, x1, y1), end, end, sub)
        cur = end; break
      }
      case 'h': if (sub.length > 1) { sub.push(start); cur = start } break
      case 're': {
        const [x, y, w, h] = nums(4)
        if (sub.length > 1) path.push(sub)
        sub = [apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h),
               apply(gs.ctm, x, y + h), apply(gs.ctm, x, y)]
        path.push(sub); sub = []; break
      }

      // Painting. Anything that strokes emits; fill-only and clip-only discard.
      case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*':
        if (op === 's' || op === 'b' || op === 'b*') if (sub.length > 1) sub.push(start)
        emit(); break
      case 'f': case 'F': case 'f*': case 'n':
        if (sub.length > 1) path.push(sub)
        sub = []; path = []; break

      // Stroking colour.
      case 'CS': {
        const name = stack[stack.length - 1]
        const csDict = doc.dictGet(resources, 'ColorSpace')
        const entry = isName(name) && isDict(csDict) ? csDict.get(name.name) : undefined
        gs.stroke.colorantName = colorantNameOf(entry, doc) ?? (isName(name) ? name.name : null)
        gs.stroke.rgb = null
        break
      }
      case 'SC': case 'SCN': {
        const comps = stack.filter((v) => typeof v === 'number') as number[]
        if (comps.length === 3) gs.stroke.rgb = [comps[0], comps[1], comps[2]]
        else if (comps.length === 4) gs.stroke.rgb = cmykToRgb(comps[0], comps[1], comps[2], comps[3])
        break
      }
      case 'RG': { const [r, g, b] = nums(3); gs.stroke.rgb = [r, g, b]; gs.stroke.colorantName = null; break }
      case 'G': { const [v] = nums(1); gs.stroke.rgb = [v, v, v]; gs.stroke.colorantName = null; break }
      case 'K': { const [c, m, y, k] = nums(4); gs.stroke.rgb = cmykToRgb(c, m, y, k); gs.stroke.colorantName = null; break }

      case 'd': { const arr = stack.find(Array.isArray); gs.stroke.dashed = Array.isArray(arr) && arr.length > 0; break }

      case 'Do': {
        const name = stack[stack.length - 1]
        const xobjects = doc.dictGet(resources, 'XObject')
        if (!isName(name) || !isDict(xobjects)) break
        const xo = doc.dictGet(xobjects, name.name)
        if (!isStream(xo)) break
        const sub2 = doc.dictGet(xo.dict, 'Subtype')
        if (!isName(sub2) || sub2.name !== 'Form') break
        const mtx = doc.dictGet(xo.dict, 'Matrix')
        const local: Mat = Array.isArray(mtx) && mtx.length === 6
          ? (mtx.map((v) => num(doc.resolve(v), 0)) as Mat) : IDENTITY
        const xres = doc.dictGet(xo.dict, 'Resources')
        // Streams inside XObjects need the same async inflate, so they are
        // pre-decoded and cached on the object by the caller below.
        const cached = (xo as PdfStream & { decoded?: Uint8Array }).decoded
        if (cached) {
          runContentStream(cached, isDict(xres) ? xres : resources, doc,
            mul(local, gs.ctm), out, colorants, depth + 1)
        }
        break
      }

      // BI ... ID <binary> EI — inline image. Skip past it.
      case 'BI': {
        const end = indexOfAscii(content, 'EI', lex.pos)
        lex.pos = end < 0 ? content.length : end + 2
        break
      }
      default: break
    }
  }
}

/** Pre-inflate every Form XObject so the (synchronous) interpreter can recurse. */
async function predecodeForms(resources: PdfDict, doc: PdfDocument, seen = new Set<PdfValue>()) {
  const xobjects = doc.dictGet(resources, 'XObject')
  if (!isDict(xobjects)) return
  for (const key of xobjects.keys()) {
    const xo = doc.dictGet(xobjects, key)
    if (!isStream(xo) || seen.has(xo)) continue
    seen.add(xo)
    const sub = doc.dictGet(xo.dict, 'Subtype')
    if (!isName(sub) || sub.name !== 'Form') continue
    try {
      ;(xo as PdfStream & { decoded?: Uint8Array }).decoded = await decodeStream(xo, doc)
    } catch { /* an unsupported filter just means that form is skipped */ }
    const nested = doc.dictGet(xo.dict, 'Resources')
    if (isDict(nested)) await predecodeForms(nested, doc, seen)
  }
}

/* ------------------------------------------------------------------ */

export async function parsePdfDieline(bytes: Uint8Array): Promise<Dieline> {
  const doc = await PdfDocument.load(bytes)
  const page = doc.firstPage()
  if (!page) throw new Error('No page found in this PDF.')

  const content = await doc.pageContent(page.dict)
  await predecodeForms(page.resources, doc)

  const [x0, y0, x1, y1] = page.mediaBox
  // Shift so the MediaBox origin is at (0,0); everything downstream works in
  // sheet coordinates with +Y up, which is what PDF already gives us.
  const base: Mat = [1, 0, 0, 1, -Math.min(x0, x1), -Math.min(y0, y1)]

  const segments: Segment[] = []
  const colorants = new Set<string>()
  runContentStream(content, page.resources, doc, base, segments, colorants)

  const notes: string[] = []
  if (colorants.size) notes.push(`spot colours: ${[...colorants].join(', ')}`)

  return {
    segments,
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
    mmPerUnit: 25.4 / 72, // PDF user space is 1/72 inch
    source: 'PDF',
    notes,
  }
}
