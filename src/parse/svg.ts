import { classifyByColor, classifyByName } from './classify'
import type { Dieline, LineType, Segment, Vec2 } from '../geom/types'

/**
 * SVG dielines.
 *
 * Rather than hand-roll a path grammar (arcs, smooth curves, relative commands)
 * we mount the file off-screen and let the browser's own SVG engine answer the
 * geometry questions: `getPointAtLength` for the outline and `getCTM` for the
 * transform stack. We sample finely and then collapse collinear runs, so a
 * straight edge comes back as one segment rather than two hundred.
 *
 * Cut/crease still comes from the same cascade as PDF: layer or class name
 * first, stroke colour second, dash pattern last.
 */
export async function parseSvgDieline(text: string): Promise<Dieline> {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const svg = doc.documentElement as unknown as SVGSVGElement
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('Not a valid SVG file.')

  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden'
  host.appendChild(svg)
  document.body.appendChild(host)

  try {
    const vb = svg.viewBox?.baseVal
    const boxW = vb && vb.width ? vb.width : parseFloat(svg.getAttribute('width') || '1000')
    const boxH = vb && vb.height ? vb.height : parseFloat(svg.getAttribute('height') || '1000')
    const originX = vb && vb.width ? vb.x : 0
    const originY = vb && vb.height ? vb.y : 0

    const segments: Segment[] = []
    const names = new Set<string>()
    const shapes = svg.querySelectorAll<SVGGraphicsElement>('path,line,polyline,polygon,rect,circle,ellipse')
    const rootCTM = svg.getScreenCTM()

    for (const el of shapes) {
      const type = classifyElement(el, names)
      const pts = flatten(el, boxW, boxH)
      if (pts.length < 2) continue

      const ctm = el.getScreenCTM()
      const toLocal = rootCTM && ctm ? rootCTM.inverse().multiply(ctm) : null
      const mapped = pts.map((p) => {
        if (!toLocal) return p
        const q = new DOMPoint(p.x, p.y).matrixTransform(toLocal)
        return { x: q.x, y: q.y }
      })

      // SVG's Y axis points down; the rest of the pipeline works Y-up.
      const flipped = mapped.map((p) => ({ x: p.x - originX, y: boxH - (p.y - originY) }))
      for (let i = 0; i + 1 < flipped.length; i++) {
        segments.push({ a: flipped[i], b: flipped[i + 1], type })
      }
    }

    const notes: string[] = []
    if (names.size) notes.push(`layers / classes: ${[...names].slice(0, 6).join(', ')}`)

    return {
      segments,
      width: boxW,
      height: boxH,
      mmPerUnit: mmPerUnitOf(svg, boxW),
      source: 'SVG',
      notes,
    }
  } finally {
    host.remove()
  }
}

function classifyElement(el: SVGGraphicsElement, seen: Set<string>): LineType {
  // Walk up so a `<g id="crease">` layer applies to everything inside it.
  const labels: string[] = []
  for (let n: Element | null = el; n && n.nodeName.toLowerCase() !== 'svg'; n = n.parentElement) {
    for (const attr of ['id', 'class', 'data-line-type', 'inkscape:label']) {
      const v = n.getAttribute(attr)
      if (v) labels.push(v)
    }
  }
  for (const l of labels) {
    const byName = classifyByName(l)
    if (byName) { seen.add(l); return byName }
  }

  const style = getComputedStyle(el)
  const stroke = style.stroke && style.stroke !== 'none' ? style.stroke : el.getAttribute('stroke')
  const byColor = classifyByColor(parseColor(stroke))
  if (byColor) return byColor

  const dash = style.strokeDasharray
  return dash && dash !== 'none' && dash !== '0px' ? 'crease' : 'cut'
}

function parseColor(css: string | null): [number, number, number] | null {
  if (!css) return null
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const [r, g, b] = m[1].split(',').map((v) => parseFloat(v))
    return [r / 255, g / 255, b / 255]
  }
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }
  return null
}

/** Sample a shape along its length, then drop points that sit on a straight run. */
function flatten(el: SVGGraphicsElement, boxW: number, boxH: number): Vec2[] {
  const geom = el as SVGGeometryElement
  if (typeof geom.getTotalLength !== 'function') return []
  let total = 0
  try { total = geom.getTotalLength() } catch { return [] }
  if (!Number.isFinite(total) || total <= 0) return []

  const stepTarget = Math.max(Math.hypot(boxW, boxH) * 0.0015, total / 4000)
  const steps = Math.max(2, Math.min(4000, Math.ceil(total / stepTarget)))
  const raw: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const p = geom.getPointAtLength((total * i) / steps)
    raw.push({ x: p.x, y: p.y })
  }

  const tol = Math.hypot(boxW, boxH) * 2e-5
  const out: Vec2[] = [raw[0]]
  for (let i = 1; i < raw.length - 1; i++) {
    const a = out[out.length - 1], b = raw[i], c = raw[i + 1]
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    const base = Math.hypot(c.x - a.x, c.y - a.y) || 1
    if (area2 / base > tol) out.push(b) // b is off the a->c line: it is a corner
  }
  out.push(raw[raw.length - 1])
  return out
}

function mmPerUnitOf(svg: SVGSVGElement, viewBoxWidth: number): number {
  const w = svg.getAttribute('width')
  const m = w?.match(/^\s*([\d.]+)\s*(mm|cm|in|pt|px)?\s*$/)
  if (!m) return 25.4 / 96 // bare user units: treat as CSS pixels
  const value = parseFloat(m[1])
  const toMm: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 }
  const physical = value * (toMm[m[2] ?? 'px'] ?? 25.4 / 96)
  return viewBoxWidth > 0 ? physical / viewBoxWidth : 25.4 / 96
}
