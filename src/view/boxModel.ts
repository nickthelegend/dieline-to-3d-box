import * as THREE from 'three'
import type { Arrangement } from '../geom/arrangement'
import type { Dieline, FoldNode, FoldTree, LineType, Panel, Vec2 } from '../geom/types'

const LINE_COLOR: Record<LineType, number> = {
  cut: 0xe2453a,
  crease: 0x1fa65c,
  perf: 0x3b7ddd,
}

const BOARD = 0xe9e2d2
const BOARD_EDGE = 0xc9bda3
/** Caliper of the card, in millimetres. Typical folding boxboard. */
const THICKNESS_MM = 0.5

export type BuildOptions = {
  showLinework: boolean
  panelMap: boolean
}

type NodeView = {
  node: FoldNode
  group: THREE.Group
  axis: THREE.Vector3
  /** Animation window within the global 0..1 fold parameter. */
  start: number
  span: number
  mesh: THREE.Mesh
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)

/**
 * Turns a fold tree into a Three.js object graph.
 *
 * The mapping is deliberately one-to-one: every panel becomes a `Group` whose
 * *local origin sits on its hinge line*, with the panel's geometry translated
 * so it still lands in the right place on the flat sheet. Because the origin is
 * the hinge, folding is nothing more than setting that group's rotation — and
 * because the groups are nested the way the panels are joined, a parent
 * carrying its children is automatic.
 */
export class BoxModel {
  readonly object = new THREE.Group()
  readonly views: NodeView[] = []
  private linework: THREE.LineSegments[] = []
  private fold = 0

  constructor(
    readonly dieline: Dieline,
    readonly arrangement: Arrangement,
    readonly tree: FoldTree,
    opts: BuildOptions,
  ) {
    const s = dieline.mmPerUnit

    // The fold maths is done with the sheet flat in XY and panels rising in +Z.
    // Tip the whole assembly so the sheet lies on the ground plane and the box
    // stands up in +Y, which is what the camera expects.
    const sheetRoot = new THREE.Group()
    sheetRoot.rotation.x = -Math.PI / 2
    sheetRoot.position.y = THICKNESS_MM / 2
    this.object.add(sheetRoot)

    const slotFor = depthSchedule(tree)

    const build = (node: FoldNode, parentOrigin: Vec2, parentGroup: THREE.Group) => {
      const origin = node.parent ? node.hingePoint : node.panel.centroid
      const group = new THREE.Group()
      group.position.set((origin.x - parentOrigin.x) * s, (origin.y - parentOrigin.y) * s, 0)
      parentGroup.add(group)

      const mesh = this.makePanelMesh(node.panel, origin, s, opts.panelMap)
      group.add(mesh)

      // Always build the die-line overlay; `showLinework` only decides whether
      // it starts visible. Building it lazily would leave the toggle dead for
      // any model created while the box was unchecked.
      const lines = this.makeLinework(node.panel, origin, s)
      if (lines) {
        lines.visible = opts.showLinework
        group.add(lines)
      }

      const slot = slotFor(node.depth)
      this.views.push({
        node, group, mesh,
        axis: new THREE.Vector3(node.hingeAxis.x, node.hingeAxis.y, 0).normalize(),
        start: slot.start, span: slot.span,
      })

      for (const child of node.children) build(child, origin, group)
    }

    build(this.tree.root, this.tree.root.panel.centroid, sheetRoot)
    this.setFold(0)
  }

  /* ------------------------------------------------------------------ */

  private makePanelMesh(panel: Panel, origin: Vec2, s: number, panelMap: boolean): THREE.Mesh {
    const toShape = (poly: Vec2[]) => {
      const path = new THREE.Shape()
      poly.forEach((p, i) => {
        const x = (p.x - origin.x) * s, y = (p.y - origin.y) * s
        i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
      })
      path.closePath()
      return path
    }
    const shape = toShape(panel.outline)
    for (const hole of panel.holes ?? []) {
      const h = new THREE.Path()
      hole.forEach((p, i) => {
        const x = (p.x - origin.x) * s, y = (p.y - origin.y) * s
        i === 0 ? h.moveTo(x, y) : h.lineTo(x, y)
      })
      h.closePath()
      shape.holes.push(h)
    }

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: THICKNESS_MM,
      bevelEnabled: false,
      curveSegments: 1,
    })
    // Centre the board on its own mid-plane: that is where the crease lives.
    geo.translate(0, 0, -THICKNESS_MM / 2)
    geo.computeVertexNormals()

    const face = new THREE.MeshStandardMaterial({
      color: panelMap ? panelHue(panel.id) : BOARD,
      roughness: 0.82,
      metalness: 0.0,
    })
    const edge = new THREE.MeshStandardMaterial({
      color: panelMap ? panelHue(panel.id, 0.65) : BOARD_EDGE,
      roughness: 0.95,
      metalness: 0.0,
    })

    // ExtrudeGeometry emits group 0 for the two faces and group 1 for the walls.
    const mesh = new THREE.Mesh(geo, [face, edge])
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.panelId = panel.id
    return mesh
  }

  /**
   * Draws the original die art on the board — every cut in red, every crease in
   * green — so you can see that the 3D panels really are the parsed linework.
   */
  private makeLinework(panel: Panel, origin: Vec2, s: number): THREE.LineSegments | null {
    const { panelLoops, vertices, edgeType } = this.arrangement
    const loop = panelLoops[panel.id]
    if (!loop) return null

    const pos: number[] = []
    const col: number[] = []
    const c = new THREE.Color()
    const lift = THICKNESS_MM / 2 + 0.06

    const push = (a: Vec2, b: Vec2, type: LineType) => {
      c.setHex(LINE_COLOR[type])
      for (const p of [a, b]) {
        // Both faces of the board, so the art reads from inside and outside.
        pos.push((p.x - origin.x) * s, (p.y - origin.y) * s, lift)
        col.push(c.r, c.g, c.b)
      }
      for (const p of [a, b]) {
        pos.push((p.x - origin.x) * s, (p.y - origin.y) * s, -lift)
        col.push(c.r, c.g, c.b)
      }
    }

    for (let i = 0; i < loop.length; i++) {
      const va = loop[i], vb = loop[(i + 1) % loop.length]
      push(vertices[va], vertices[vb], edgeType.get(`${va},${vb}`) ?? 'cut')
    }
    for (const hole of panel.holes ?? []) {
      for (let i = 0; i < hole.length; i++) push(hole[i], hole[(i + 1) % hole.length], 'cut')
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }))
    this.linework.push(lines)
    return lines
  }

  /* ------------------------------------------------------------------ */

  /**
   * `t = 0` is flat, `t = 1` is closed. Panels are staggered by tree depth, so
   * the walls come up first and the tabs tuck in last.
   */
  setFold(t: number) {
    this.fold = clamp01(t)
    for (const v of this.views) {
      if (!v.node.parent) continue
      const local = easeInOutCubic(clamp01((this.fold - v.start) / v.span))
      v.group.setRotationFromAxisAngle(v.axis, v.node.angle * local)
    }
  }

  get foldValue() { return this.fold }

  setLinework(on: boolean) { for (const l of this.linework) l.visible = on }

  setPanelMap(on: boolean) {
    this.views.forEach((v) => {
      const mats = v.mesh.material as THREE.MeshStandardMaterial[]
      mats[0].color.setHex(on ? panelHue(v.node.panel.id) : BOARD)
      mats[1].color.setHex(on ? panelHue(v.node.panel.id, 0.65) : BOARD_EDGE)
    })
  }

  /**
   * World-space size of the board at the current fold, in millimetres.
   *
   * Only the panel meshes are measured. The die-line overlay floats a hair
   * proud of each face so it does not z-fight, and including it would inflate
   * the reported box by twice that clearance.
   */
  measure(): THREE.Box3 {
    this.object.updateWorldMatrix(true, true)
    const box = new THREE.Box3()
    for (const v of this.views) box.expandByObject(v.mesh)
    return box
  }

  dispose() {
    this.object.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose?.()
    })
    this.object.removeFromParent()
  }
}

/**
 * Builds the animation schedule: each depth of the fold tree gets a slice of
 * the 0..1 fold parameter, and consecutive slices overlap so the whole thing
 * reads as one continuous motion rather than a set of discrete steps.
 *
 * The slices are sized by how much card is moving at that depth rather than
 * split evenly, and that matters here: this carton ends in a six-deep chain of
 * small internal lock tabs, so an even split would spend more than half the
 * animation on panels that are already sealed inside the closed box.
 */
function depthSchedule(tree: FoldTree): (depth: number) => { start: number; span: number } {
  const OVERLAP = 1.35
  const MIN_SPAN = 0.12

  const area = new Map<number, number>()
  for (const n of tree.nodes) {
    if (n.depth === 0) continue
    area.set(n.depth, (area.get(n.depth) ?? 0) + n.panel.area)
  }
  // Square root, so a depth is weighted by how far its card sweeps rather than
  // by how much of it there is.
  const weight = new Map([...area].map(([d, a]) => [d, Math.sqrt(a)] as const))
  const total = [...weight.values()].reduce((s, w) => s + w, 0) || 1

  const slots = new Map<number, { start: number; span: number }>()
  let cursor = 0
  for (const depth of [...weight.keys()].sort((a, b) => a - b)) {
    const share = weight.get(depth)! / total
    const start = cursor
    cursor += share
    slots.set(depth, {
      start,
      span: Math.max(1e-3, Math.min(Math.max(share * OVERLAP, MIN_SPAN), 1 - start)),
    })
  }
  return (depth) => slots.get(depth) ?? { start: 0, span: 1 }
}

/** Golden-ratio hue stepping: adjacent panels never land on the same colour. */
function panelHue(id: number, mul = 1): number {
  return new THREE.Color().setHSL((id * 0.61803398875) % 1, 0.55, 0.58 * mul + 0.04).getHex()
}
