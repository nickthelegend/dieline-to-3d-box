import type { Dieline, LineType, Segment, Vec2 } from '../geom/types'

/**
 * Best-effort reader for a colour-coded dieline that only exists as a bitmap.
 *
 * A raster has no paths, so we recover them: classify every pixel by hue
 * (red = cut, green = crease, blue = score), collect long horizontal and
 * vertical runs of one colour, merge the runs that are really one line, then
 * extend line ends onto their neighbours to close the corners that anti-aliased
 * away.
 *
 * This deliberately only recovers axis-aligned linework, which is what a
 * folding carton is almost entirely made of. Curves (rounded tuck corners,
 * bevels) get squared off by the corner-closing pass. Vector input — PDF or
 * SVG — is always exact; this is the fallback.
 */

const CUT = 1, CREASE = 2, PERF = 3
const TYPE_OF: Record<number, LineType> = { 1: 'cut', 2: 'crease', 3: 'perf' }

/** Dieline PNGs are conventionally exported at 300 dpi. */
const ASSUMED_DPI = 300
const MAX_SIDE = 4500

export async function parseRasterDieline(file: File | Blob): Promise<Dieline> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const { data } = ctx.getImageData(0, 0, w, h)

  /* ---- 1. hue classification ---- */
  const cls = new Uint8Array(w * h)
  const counts = [0, 0, 0, 0]
  for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3]
    if (a < 40) continue
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    if (max - min < 22) continue // grey, white or black: no line-type signal
    let c = 0
    if (r === max) c = CUT
    else if (g === max) c = CREASE
    else c = PERF
    cls[i] = c
    counts[c]++
  }
  if (counts[CUT] + counts[CREASE] + counts[PERF] < 200) {
    throw new Error('No colour-coded linework found in this image. A dieline needs red cut lines and green crease lines.')
  }

  /* ---- 2. long single-colour runs, in both directions ---- */
  const minRun = Math.max(6, Math.round(Math.max(w, h) * 0.0018))
  const gap = 2 // bridge anti-aliasing dropouts

  type Run = { c: number; fixed: number; from: number; to: number }
  const scan = (outer: number, inner: number, at: (o: number, i: number) => number): Run[] => {
    const runs: Run[] = []
    for (let o = 0; o < outer; o++) {
      let c = 0, from = 0, miss = 0
      const flush = (end: number) => {
        if (c && end - from >= minRun) runs.push({ c, fixed: o, from, to: end })
        c = 0
      }
      for (let i = 0; i < inner; i++) {
        const v = cls[at(o, i)]
        if (v === c && v !== 0) { miss = 0; continue }
        if (c !== 0 && v === 0 && miss < gap) { miss++; continue }
        flush(i - miss)
        c = v; from = i; miss = 0
      }
      flush(inner)
    }
    return runs
  }
  const hRuns = scan(h, w, (y, x) => y * w + x)
  const vRuns = scan(w, h, (x, y) => y * w + x)

  /* ---- 3. merge runs that are really one line ---- */
  const merge = (runs: Run[]): Run[] => {
    const out: Run[] = []
    const byClass = new Map<number, Run[]>()
    for (const r of runs) (byClass.get(r.c) ?? byClass.set(r.c, []).get(r.c)!).push(r)
    for (const list of byClass.values()) {
      list.sort((a, b) => a.fixed - b.fixed || a.from - b.from)
      const used = new Array(list.length).fill(false)
      for (let i = 0; i < list.length; i++) {
        if (used[i]) continue
        used[i] = true
        let { c, fixed, from, to } = list[i]
        let weight = to - from
        for (let j = i + 1; j < list.length && list[j].fixed - fixed <= 3; j++) {
          if (used[j]) continue
          const o = list[j]
          if (o.to < from - gap || o.from > to + gap) continue // no overlap along the line
          used[j] = true
          const wj = o.to - o.from
          fixed = (fixed * weight + o.fixed * wj) / (weight + wj)
          from = Math.min(from, o.from); to = Math.max(to, o.to)
          weight += wj
        }
        out.push({ c, fixed, from, to })
      }
    }
    return out
  }

  const hLines = merge(hRuns)
  const vLines = merge(vRuns)

  /* ---- 4. snap near-equal coordinates onto shared values ---- */
  const snapTol = Math.max(1.5, Math.max(w, h) * 0.0012)
  const snapper = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b)
    const centres: number[] = []
    let group: number[] = []
    for (const v of sorted) {
      if (group.length && v - group[group.length - 1] > snapTol) {
        centres.push(group.reduce((s, x) => s + x, 0) / group.length)
        group = []
      }
      group.push(v)
    }
    if (group.length) centres.push(group.reduce((s, x) => s + x, 0) / group.length)
    return (v: number) => centres.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), centres[0] ?? v)
  }
  const snapY = snapper(hLines.map((l) => l.fixed))
  const snapX = snapper(vLines.map((l) => l.fixed))
  for (const l of hLines) l.fixed = snapY(l.fixed)
  for (const l of vLines) l.fixed = snapX(l.fixed)

  /* ---- 5. close corners: reach each line end out onto a crossing line ---- */
  const reach = Math.max(6, Math.max(w, h) * 0.006)
  const extend = (lines: Run[], others: Run[]) => {
    for (const l of lines) {
      for (const side of ['from', 'to'] as const) {
        const end = l[side]
        let best: number | null = null
        for (const o of others) {
          // Only ever lengthen. Snapping an end *inwards* would trim the line,
          // and a short stub can be trimmed to nothing — which silently opens
          // the outline it was closing.
          if (side === 'from' ? o.fixed >= end : o.fixed <= end) continue
          const d = Math.abs(o.fixed - end)
          if (d > reach || (best !== null && d >= Math.abs(best - end))) continue
          // the crossing line has to actually reach this line's position
          if (l.fixed < o.from - reach || l.fixed > o.to + reach) continue
          best = o.fixed
        }
        if (best !== null) l[side] = best
      }
    }
  }
  extend(hLines, vLines)
  extend(vLines, hLines)

  /* ---- 6. emit, flipping to a Y-up sheet ---- */
  const segments: Segment[] = []
  for (const l of hLines) {
    segments.push({ a: { x: l.from, y: h - l.fixed }, b: { x: l.to, y: h - l.fixed }, type: TYPE_OF[l.c] })
  }
  for (const l of vLines) {
    segments.push({ a: { x: l.fixed, y: h - l.from }, b: { x: l.fixed, y: h - l.to }, type: TYPE_OF[l.c] })
  }

  /* ---- 7. bridge the corners the curves used to carry ---- */
  const bridged = bridgeOpenEnds(segments, Math.max(6, Math.max(w, h) * 0.035))

  return {
    segments,
    width: w,
    height: h,
    mmPerUnit: (25.4 / ASSUMED_DPI) / scale,
    // Hand the sheet back so the renderer can print it onto the panels.
    image: canvas,
    source: 'bitmap (traced)',
    notes: [
      `traced ${segments.length - bridged} axis-aligned lines from ${w}x${h} px`,
      `${bridged} corner${bridged === 1 ? '' : 's'} bridged where a curve was lost`,
      `physical size assumed from ${ASSUMED_DPI} dpi`,
    ],
  }
}

/**
 * Rounded tuck corners and bevels are curves, and the run scanner only sees
 * straight lines — so those corners come back as two line ends floating a few
 * pixels apart, leaving the panel outline open. An open outline is not a face,
 * so the panel would vanish.
 *
 * Fix it the way a prepress operator would: find the line ends that connect to
 * nothing, pair up the ones that are mutually nearest, and chamfer across. The
 * pass only ever *adds* geometry, so it cannot damage a correct trace.
 */
function bridgeOpenEnds(segments: Segment[], reach: number): number {
  const touch = 2.0
  type End = { seg: number; at: 'a' | 'b'; p: Vec2 }
  const ends: End[] = []
  segments.forEach((s, i) => { ends.push({ seg: i, at: 'a', p: s.a }, { seg: i, at: 'b', p: s.b }) })

  const dist = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y)
  const onSegment = (p: Vec2, s: Segment) => {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-9) return false
    const t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2
    if (t < 0 || t > 1) return false
    return Math.hypot(s.a.x + t * dx - p.x, s.a.y + t * dy - p.y) <= touch
  }

  const loose = ends.filter((e) =>
    !segments.some((s, i) => i !== e.seg && (dist(e.p, s.a) <= touch || dist(e.p, s.b) <= touch || onSegment(e.p, s))))

  const isHorizontal = (s: Segment) => Math.abs(s.a.y - s.b.y) < Math.abs(s.a.x - s.b.x)

  // Two constraints keep this honest: the ends must belong to perpendicular
  // lines (a corner joins an H to a V, never two parallel lines), and they must
  // be each other's nearest candidate. A one-sided guess is usually wrong.
  const nearest = loose.map((e) => {
    let best = -1, bestD = reach
    loose.forEach((o, j) => {
      if (o.seg === e.seg) return
      if (isHorizontal(segments[e.seg]) === isHorizontal(segments[o.seg])) return
      const d = dist(e.p, o.p)
      if (d < bestD) { bestD = d; best = j }
    })
    return best
  })

  let added = 0
  const done = new Set<number>()
  nearest.forEach((j, i) => {
    if (j < 0 || nearest[j] !== i || done.has(i) || done.has(j)) return
    done.add(i); done.add(j)
    segments.push({ a: loose[i].p, b: loose[j].p, type: pickType(segments[loose[i].seg], segments[loose[j].seg]) })
    added++
  })
  return added
}

/** A bridge inherits the stronger claim: a cut contour beats a crease. */
function pickType(a: Segment, b: Segment): LineType {
  return a.type === 'cut' || b.type === 'cut' ? 'cut' : a.type
}
