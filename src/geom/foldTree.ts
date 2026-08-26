import type { Arrangement } from './arrangement'
import type { FoldNode, FoldTree, Hinge, Panel, Vec2 } from './types'

/**
 * Every crease in a carton turns a right angle. That single fact is enough to
 * fold the whole box, provided we get the *direction* of each turn right — and
 * the direction falls straight out of the geometry:
 *
 *   A panel rotating about a hinge with unit direction `d` moves, to first
 *   order, with velocity  ω (d x r),  where `r` points from the hinge to the
 *   panel. The sheet lies flat in z = 0 and the box closes upward, so we want
 *   that velocity to have a positive z component:
 *
 *       (d x r)·z  =  d.x * r.y - d.y * r.x  >  0
 *
 *   If it is negative we flip `d`. After that every hinge in the tree — walls,
 *   end panels, dust flaps, the tuck tab — folds by the *same* +90 degrees.
 *
 * Nothing here knows what a "front panel" or a "glue flap" is. Four walls in a
 * chain each turning 90 degrees necessarily closes into a rectangular tube, and
 * a flap hanging off a wall necessarily swings inward. That is why the sample
 * box closes exactly, and why a different carton would too.
 */
export const FOLD_ANGLE = Math.PI / 2

const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const len = (v: Vec2) => Math.hypot(v.x, v.y)

export function buildFoldTree(arr: Arrangement): FoldTree {
  const { panels, panelLoops, vertices, edgeType, tolerance } = arr

  /* ---- which panels does each edge separate? ---- */
  const edgeOwners = new Map<string, number[]>()
  panelLoops.forEach((loop, panelId) => {
    for (let i = 0; i < loop.length; i++) {
      const k = key(loop[i], loop[(i + 1) % loop.length])
      const owners = edgeOwners.get(k) ?? edgeOwners.set(k, []).get(k)!
      if (!owners.includes(panelId)) owners.push(panelId)
    }
  })

  /* ---- creases shared by exactly two panels are hinges ---- */
  const raw: Hinge[] = []
  for (const [k, owners] of edgeOwners) {
    const type = edgeType.get(k.replace(',', ','))
    if (type !== 'crease' && type !== 'perf') continue
    if (owners.length !== 2) continue
    const [ia, ib] = k.split(',').map(Number)
    raw.push({ a: vertices[ia], b: vertices[ib], type, panels: [owners[0], owners[1]] })
  }

  /* ---- a crease broken by a slot arrives as several collinear pieces; ----
     ---- rejoin them so each panel pair gets one hinge line          ---- */
  const grouped = new Map<string, Hinge[]>()
  for (const h of raw) {
    const k = key(h.panels[0], h.panels[1])
    ;(grouped.get(k) ?? grouped.set(k, []).get(k)!).push(h)
  }
  // A hinge is a line, not a point. Two regions that merely graze each other
  // for a fraction of a pixel are not hinged — that happens when a crease
  // overshoots its neighbour by a rounding error, and left alone it will swing
  // a die-cut slot out of the box as if it were a flap.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const v of vertices) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x)
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY) || 1
  const minHingeLength = Math.max(tolerance * 8, diagonal * 0.002)

  const hinges: Hinge[] = []
  for (const group of grouped.values()) {
    const longest = group.reduce((m, h) => (len(sub(h.b, h.a)) > len(sub(m.b, m.a)) ? h : m))
    const d = sub(longest.b, longest.a)
    const L = len(d) || 1
    const dir = { x: d.x / L, y: d.y / L }
    let lo = 0, hi = L
    for (const h of group) {
      for (const p of [h.a, h.b]) {
        const r = sub(p, longest.a)
        const along = r.x * dir.x + r.y * dir.y
        const off = Math.abs(r.x * -dir.y + r.y * dir.x)
        if (off > tolerance * 4) continue // not on this line: ignore
        lo = Math.min(lo, along); hi = Math.max(hi, along)
      }
    }
    if (hi - lo < minHingeLength) continue // a graze, not a fold line
    hinges.push({
      a: { x: longest.a.x + dir.x * lo, y: longest.a.y + dir.y * lo },
      b: { x: longest.a.x + dir.x * hi, y: longest.a.y + dir.y * hi },
      type: group.some((h) => h.type === 'perf') ? 'perf' : 'crease',
      panels: longest.panels,
    })
  }

  /* ---- adjacency ---- */
  const adj = new Map<number, { other: number; hinge: Hinge }[]>()
  for (const h of hinges) {
    const [p, q] = h.panels
    ;(adj.get(p) ?? adj.set(p, []).get(p)!).push({ other: q, hinge: h })
    ;(adj.get(q) ?? adj.set(q, []).get(q)!).push({ other: p, hinge: h })
  }
  // Follow the strongest joins first, so the big walls form the trunk of the
  // tree and small tabs end up as leaves.
  for (const list of adj.values()) list.sort((a, b) => len(sub(b.hinge.b, b.hinge.a)) - len(sub(a.hinge.b, a.hinge.a)))

  /* ---- root: the panel that holds the most others, biggest wins ties ---- */
  const rootPanel = panels.reduce((best, p) => {
    const dp = adj.get(p.id)?.length ?? 0
    const db = adj.get(best.id)?.length ?? 0
    if (dp !== db) return dp > db ? p : best
    return p.area > best.area ? p : best
  }, panels[0])

  /* ---- breadth-first spanning tree ---- */
  const byId = new Map<number, Panel>(panels.map((p) => [p.id, p]))
  const nodes: FoldNode[] = []
  const made = new Map<number, FoldNode>()

  const root: FoldNode = {
    panel: rootPanel, parent: null, children: [], depth: 0,
    hingePoint: rootPanel.centroid, hingeAxis: { x: 1, y: 0 }, angle: 0,
  }
  made.set(rootPanel.id, root)
  nodes.push(root)

  const queue: FoldNode[] = [root]
  while (queue.length) {
    const node = queue.shift()!
    for (const { other, hinge } of adj.get(node.panel.id) ?? []) {
      if (made.has(other)) continue
      const child = byId.get(other)
      if (!child) continue

      const d = sub(hinge.b, hinge.a)
      const L = len(d) || 1
      let axis = { x: d.x / L, y: d.y / L }

      // Orient the axis so a positive rotation lifts this panel out of the
      // sheet (see the note at the top of the file).
      const r = sub(child.centroid, hinge.a)
      if (axis.x * r.y - axis.y * r.x < 0) axis = { x: -axis.x, y: -axis.y }

      const foldNode: FoldNode = {
        panel: child, parent: node, children: [], depth: node.depth + 1,
        hingePoint: hinge.a, hingeAxis: axis, angle: FOLD_ANGLE,
      }
      node.children.push(foldNode)
      made.set(other, foldNode)
      nodes.push(foldNode)
      queue.push(foldNode)
    }
  }

  return {
    root,
    nodes,
    detached: panels.filter((p) => !made.has(p.id)),
    hinges,
  }
}
