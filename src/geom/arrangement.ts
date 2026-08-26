import type { LineType, Panel, Segment, Vec2 } from './types'

/**
 * Turns a soup of drawn line segments into the *faces* of the drawing.
 *
 * A dieline is a planar subdivision: every cut and every crease is a wall, and
 * the regions those walls enclose are exactly the panels of card. So finding
 * the panels is the classic computational-geometry problem of extracting the
 * faces of a planar arrangement:
 *
 *   1. snap coincident endpoints so the linework is actually connected
 *   2. split every segment at crossings and T-junctions
 *   3. sort each vertex's neighbours by angle
 *   4. walk half-edges, always taking the sharpest right turn
 *
 * Step 4 traces each face exactly once. Loops that come back counter-clockwise
 * (positive signed area) are regions of card; clockwise loops are the outside
 * of the sheet, or holes punched inside a panel.
 */

export type Arrangement = {
  vertices: Vec2[]
  /** Undirected edges, indices into `vertices`. */
  edges: { a: number; b: number; type: LineType }[]
  /** Type lookup for a directed pair, keyed `"a,b"`. */
  edgeType: Map<string, LineType>
  panels: Panel[]
  /** Loops of each panel as vertex indices — used to find shared creases. */
  panelLoops: number[][]
  tolerance: number
}

const key = (a: number, b: number) => `${a},${b}`

function signedArea(poly: Vec2[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

function centroidOf(poly: Vec2[]): Vec2 {
  const a = signedArea(poly)
  if (Math.abs(a) < 1e-9) {
    return poly.reduce((acc, p) => ({ x: acc.x + p.x / poly.length, y: acc.y + p.y / poly.length }), { x: 0, y: 0 })
  }
  let cx = 0, cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const f = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * f
    cy += (p.y + q.y) * f
  }
  return { x: cx / (6 * a), y: cy / (6 * a) }
}

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function buildArrangement(segments: Segment[]): Arrangement {
  // Tolerance scales with the drawing so the same code works on a PDF in
  // points, an SVG in millimetres, or a bitmap traced in pixels.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of segments) {
    for (const p of [s.a, s.b]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1
  const tol = Math.min(0.5, Math.max(0.002, diag * 2e-5))

  /* ---- 1. snap endpoints onto a shared vertex set ---- */
  const vertices: Vec2[] = []
  const grid = new Map<string, number[]>()
  const cell = tol * 2
  const vidOf = (p: Vec2): number => {
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (Math.hypot(vertices[i].x - p.x, vertices[i].y - p.y) <= tol) return i
        }
      }
    }
    const id = vertices.length
    vertices.push(p)
    const k = `${gx},${gy}`
    ;(grid.get(k) ?? grid.set(k, []).get(k)!).push(id)
    return id
  }

  type Edge = { a: number; b: number; type: LineType }
  let edges: Edge[] = []
  const seen = new Set<string>()
  for (const s of segments) {
    const a = vidOf(s.a), b = vidOf(s.b)
    if (a === b) continue
    const k = a < b ? key(a, b) : key(b, a)
    if (seen.has(k)) continue // a duplicated line would break the half-edge walk
    seen.add(k)
    edges.push({ a, b, type: s.type })
  }

  /* ---- 2a. split at proper crossings (X intersections) ---- */
  const extra: { edge: number; t: number; v: number }[] = []
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const p = vertices[edges[i].a], p2 = vertices[edges[i].b]
      const q = vertices[edges[j].a], q2 = vertices[edges[j].b]
      const r = { x: p2.x - p.x, y: p2.y - p.y }
      const s = { x: q2.x - q.x, y: q2.y - q.y }
      const denom = r.x * s.y - r.y * s.x
      if (Math.abs(denom) < 1e-12) continue // parallel
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / denom
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / denom
      const eps = tol / Math.max(Math.hypot(r.x, r.y), Math.hypot(s.x, s.y))
      if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) continue
      const v = vidOf({ x: p.x + t * r.x, y: p.y + t * r.y })
      extra.push({ edge: i, t, v }, { edge: j, t: u, v })
    }
  }

  /* ---- 2b. split at T-junctions (a vertex sitting on another edge) ---- */
  const split = (list: Edge[]): { out: Edge[]; changed: boolean } => {
    const out: Edge[] = []
    let changed = false
    list.forEach((e, ei) => {
      const A = vertices[e.a], B = vertices[e.b]
      const dx = B.x - A.x, dy = B.y - A.y
      const len2 = dx * dx + dy * dy
      if (len2 < 1e-12) return
      const hits = new Map<number, number>()
      for (const x of extra) if (x.edge === ei && x.v !== e.a && x.v !== e.b) hits.set(x.v, x.t)
      for (let v = 0; v < vertices.length; v++) {
        if (v === e.a || v === e.b || hits.has(v)) continue
        const P = vertices[v]
        const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2
        if (t <= 0 || t >= 1) continue
        const d = Math.hypot(A.x + t * dx - P.x, A.y + t * dy - P.y)
        if (d <= tol) hits.set(v, t)
      }
      if (hits.size === 0) { out.push(e); return }
      changed = true
      const ordered = [...hits.entries()].sort((m, n) => m[1] - n[1])
      let prev = e.a
      for (const [v] of ordered) { if (v !== prev) out.push({ a: prev, b: v, type: e.type }); prev = v }
      if (prev !== e.b) out.push({ a: prev, b: e.b, type: e.type })
    })
    return { out, changed }
  }
  for (let pass = 0; pass < 4; pass++) {
    const r = split(edges)
    edges = r.out
    extra.length = 0
    if (!r.changed) break
  }

  /* ---- 3. angular adjacency ---- */
  const edgeType = new Map<string, LineType>()
  const neighbours = new Map<number, Set<number>>()
  for (const e of edges) {
    edgeType.set(key(e.a, e.b), e.type)
    edgeType.set(key(e.b, e.a), e.type)
    ;(neighbours.get(e.a) ?? neighbours.set(e.a, new Set()).get(e.a)!).add(e.b)
    ;(neighbours.get(e.b) ?? neighbours.set(e.b, new Set()).get(e.b)!).add(e.a)
  }
  const ring = new Map<number, number[]>()
  for (const [v, set] of neighbours) {
    const c = vertices[v]
    ring.set(v, [...set].sort((m, n) =>
      Math.atan2(vertices[m].y - c.y, vertices[m].x - c.x) -
      Math.atan2(vertices[n].y - c.y, vertices[n].x - c.x)))
  }

  /* ---- 4. walk half-edges into face loops ---- */
  const visited = new Set<string>()
  const loops: number[][] = []
  for (const e of edges) {
    for (const [u0, v0] of [[e.a, e.b], [e.b, e.a]] as const) {
      if (visited.has(key(u0, v0))) continue
      const loop: number[] = []
      let u = u0, v = v0
      for (let guard = 0; guard < edges.length * 2 + 8; guard++) {
        visited.add(key(u, v))
        loop.push(u)
        const r = ring.get(v)!
        const i = r.indexOf(u)
        // Step to the neighbour just clockwise of where we came from: the
        // sharpest right turn, which keeps the face on our left.
        const next = r[(i - 1 + r.length) % r.length]
        u = v; v = next
        if (u === u0 && v === v0) break
      }
      if (loop.length >= 3) loops.push(loop)
    }
  }

  /* ---- 5. faces vs. outside vs. holes ---- */
  const minArea = Math.max(tol * tol * 8, diag * diag * 1e-6)
  const solid: { loop: number[]; poly: Vec2[]; area: number }[] = []
  const reversed: { poly: Vec2[]; area: number }[] = []
  for (const loop of loops) {
    const poly = loop.map((i) => vertices[i])
    const area = signedArea(poly)
    if (Math.abs(area) < minArea) continue
    if (area > 0) solid.push({ loop, poly, area })
    else reversed.push({ poly, area: -area })
  }
  solid.sort((a, b) => b.area - a.area)

  const panels: Panel[] = solid.map((f, id) => {
    const xs = f.poly.map((p) => p.x), ys = f.poly.map((p) => p.y)
    return {
      id,
      outline: f.poly,
      area: f.area,
      centroid: centroidOf(f.poly),
      bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    }
  })

  // A clockwise loop that lies inside a panel is a punched hole in that panel.
  // (The one clockwise loop that is inside nothing is the outside of the sheet.)
  for (const r of reversed) {
    const probe = interiorPoint(r.poly)
    if (!probe) continue
    let host: Panel | null = null
    // Smallest containing panel wins; `panels` is sorted large-to-small.
    for (let i = panels.length - 1; i >= 0; i--) {
      if (panels[i].area > r.area && pointInPolygon(probe, panels[i].outline)) { host = panels[i]; break }
    }
    if (host) host.holes = [...(host.holes ?? []), r.poly]
  }

  return { vertices, edges, edgeType, panels, panelLoops: solid.map((f) => f.loop), tolerance: tol }
}

/**
 * A point strictly inside a simple polygon. The centroid works for convex
 * shapes; for the rest we probe just inside each edge midpoint.
 */
function interiorPoint(poly: Vec2[]): Vec2 | null {
  const c = centroidOf(poly)
  if (pointInPolygon(c, poly)) return c
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
    for (const step of [1e-3, 1e-2, 1e-1]) {
      for (const sign of [1, -1]) {
        const p = { x: mid.x + n.x * step * sign * len, y: mid.y + n.y * step * sign * len }
        if (pointInPolygon(p, poly)) return p
      }
    }
  }
  return null
}
