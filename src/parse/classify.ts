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

/**
 * Classify from an RGB stroke colour in 0..1. Returns null when the colour
 * carries no signal (grey, black, white).
 *
 * The decision is made on *hue*, not on how far the dominant channel beats the
 * others. Print colours are not primaries: the slate blue conventionally used
 * for score lines (#48778d) has its blue channel only 0.09 above green, so a
 * channel-margin test reads it as neutral and silently downgrades a hinge to a
 * cut — which loses a whole fold. Hue puts it at 199 degrees, unambiguously blue.
 */
export function classifyByColor(rgb: [number, number, number] | null): LineType | null {
  if (!rgb) return null
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (max <= 0.06 || delta / max < 0.18) return null // black, white or grey

  let hue: number
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)
  if (hue < 0) hue += 360

  // Wide buckets: press reds, greens and blues vary a lot between suppliers.
  if (hue >= 330 || hue < 20) return 'cut'
  if (hue >= 75 && hue < 175) return 'crease'
  if (hue >= 175 && hue < 265) return 'perf'
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
