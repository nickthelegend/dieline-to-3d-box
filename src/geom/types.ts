/** Shared vocabulary for the whole pipeline: dieline -> panels -> fold tree. */

export type Vec2 = { x: number; y: number }

/**
 * How a drawn line behaves when the card is folded.
 *  - `cut`    the knife goes through: a panel boundary, nothing on the far side.
 *  - `crease` the card is scored but stays joined: this is a hinge.
 *  - `perf`   perforated crease-cut ("Rill-Schnitt"). Still a hinge, weaker card.
 */
export type LineType = 'cut' | 'crease' | 'perf'

/** A straight piece of linework. Curves are flattened into runs of these. */
export type Segment = { a: Vec2; b: Vec2; type: LineType }

/** Everything we managed to read out of an uploaded file. */
export type Dieline = {
  segments: Segment[]
  /** Page/artboard size in source units (PDF points, SVG user units, px). */
  width: number
  height: number
  /** Millimetres per source unit, so the 3D box comes out life-size. */
  mmPerUnit: number
  /** Where the cut/crease classification came from — shown in the UI. */
  source: string
  /** Human-readable notes about how lines were classified. */
  notes: string[]
}

/** One closed region of card: a face of the planar arrangement of all linework. */
export type Panel = {
  id: number
  /** Outline in sheet coordinates, counter-clockwise. */
  outline: Vec2[]
  area: number
  centroid: Vec2
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
  /** Clockwise loops punched out of this panel (slots, finger holes). */
  holes?: Vec2[][]
}

/** A crease shared by exactly two panels — the hinge they rotate about. */
export type Hinge = {
  a: Vec2
  b: Vec2
  type: LineType
  panels: [number, number]
}

/** One node of the fold tree: a panel plus how it swings off its parent. */
export type FoldNode = {
  panel: Panel
  parent: FoldNode | null
  children: FoldNode[]
  /** Depth in the tree; drives the animation stagger. */
  depth: number
  /** A point on the hinge line, in sheet coordinates. Root has no hinge. */
  hingePoint: Vec2
  /** Unit vector along the hinge, oriented so a +angle rotation lifts the panel. */
  hingeAxis: Vec2
  /** Target rotation in radians (positive, about `hingeAxis`). */
  angle: number
}

export type FoldTree = {
  root: FoldNode
  nodes: FoldNode[]
  /** Panels with no crease path to the root: die-cut waste / slots. */
  detached: Panel[]
  hinges: Hinge[]
}
