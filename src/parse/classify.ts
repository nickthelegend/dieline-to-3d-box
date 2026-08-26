import type { LineType } from '../geom/types'

/**
 * Turning "what colour / what separation is this line?" into "is it a cut or a
 * hinge?".
 *
 * Prepress dielines encode the answer in one of three places, in descending
 * order of reliability:
 *   1. A named spot colour (a PDF /Separation, or an SVG layer/class name).
 *      The sample file uses the German prepress convention:
 *      Schneiden = cut, Rillen = crease, Rill-Schnitt = perforated crease-cut.
 *   2. Stroke colour. The near-universal print convention is red = cut,
 *      green = crease, blue/cyan = score.
 *   3. Dash pattern — a dashed line in a dieline is almost always a fold.
 */

const CREASE_WORDS = [
  'rillen', 'rille', 'crease', 'creas', 'score', 'fold', 'falz', 'bend',
  'hinge', 'rill', 'plie', 'piega',
]
const PERF_WORDS = ['perf', 'rill-schnitt', 'rillschnitt', 'zipper', 'nick', 'ritz']
const CUT_WORDS = [
  'schneiden', 'schnitt', 'cut', 'knife', 'die', 'trim', 'contour', 'outline',
  'stanz', 'coupe', 'taglio',
]

/** Classify from a colorant / layer / class name. Returns null if unrecognised. */
export function classifyByName(raw: string | null | undefined): LineType | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  // Perf is checked first: "Rill-Schnitt" contains both "rill" and "schnitt".
  if (PERF_WORDS.some((w) => s.includes(w))) return 'perf'
  if (CREASE_WORDS.some((w) => s.includes(w))) return 'crease'
  if (CUT_WORDS.some((w) => s.includes(w))) return 'cut'
  return null
}

/** Classify from an RGB stroke colour in 0..1. Returns null if too neutral. */
export function classifyByColor(rgb: [number, number, number] | null): LineType | null {
  if (!rgb) return null
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 0.2) return null // grey / black: no signal
  if (r === max && r - Math.max(g, b) > 0.2) return 'cut'
  if (g === max && g - Math.max(r, b) > 0.2) return 'crease'
  if (b === max && b - Math.max(r, g) > 0.2) return 'perf'
  return null
}

export type StrokeStyle = {
  colorantName: string | null
  rgb: [number, number, number] | null
  dashed: boolean
}

/** Full cascade. Everything unrecognised falls back to `cut`, the safe default. */
export function classifyStroke(s: StrokeStyle): LineType {
  return (
    classifyByName(s.colorantName) ??
    classifyByColor(s.rgb) ??
    (s.dashed ? 'crease' : 'cut')
  )
}
