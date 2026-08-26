/**
 * Headless sanity check for the parse -> panels -> fold pipeline.
 *   npm run check
 * Runs the whole vector path on the sample carton in Node (no browser, no
 * WebGL) and prints the panel table and the fold tree, so a regression in the
 * geometry shows up without having to look at pixels.
 */
import { readFileSync } from 'node:fs'
import { parsePdfDieline } from '../src/parse/pdf'
import { buildArrangement } from '../src/geom/arrangement'
import { buildFoldTree } from '../src/geom/foldTree'
import type { FoldNode } from '../src/geom/types'

const path = process.argv[2] ?? 'public/sample_dieline.pdf'
const d = await parsePdfDieline(new Uint8Array(readFileSync(path)))

const counts = { cut: 0, crease: 0, perf: 0 }
for (const s of d.segments) counts[s.type]++
console.log(`\n${path}`)
console.log(`  page      ${d.width.toFixed(1)} x ${d.height.toFixed(1)} pt  (${(d.width * d.mmPerUnit).toFixed(0)} x ${(d.height * d.mmPerUnit).toFixed(0)} mm)`)
console.log(`  linework  ${d.segments.length} segments  cut=${counts.cut} crease=${counts.crease} perf=${counts.perf}`)
for (const n of d.notes) console.log(`  note      ${n}`)

const arr = buildArrangement(d.segments)
console.log(`\npanels (${arr.panels.length}), snap tolerance ${arr.tolerance.toFixed(3)} pt`)
for (const p of arr.panels) {
  const b = p.bbox
  console.log(`  #${String(p.id).padStart(2)}  ${(b.maxX - b.minX).toFixed(1).padStart(6)} x ${(b.maxY - b.minY).toFixed(1).padStart(6)} pt`
    + `  at (${b.minX.toFixed(0)}, ${b.minY.toFixed(0)})  ${p.outline.length} pts`
    + (p.holes?.length ? `  ${p.holes.length} hole(s)` : ''))
}

const tree = buildFoldTree(arr)
console.log(`\nfold tree — ${tree.nodes.length} panels folded, ${tree.hinges.length} hinges,`
  + ` ${tree.hinges.length - (tree.nodes.length - 1)} closing crease(s),`
  + ` ${tree.detached.length} detached (die-cut waste)`)
const walk = (n: FoldNode, pad = '  ') => {
  const b = n.panel.bbox
  const size = `${(b.maxX - b.minX).toFixed(0)}x${(b.maxY - b.minY).toFixed(0)}`
  const hinge = n.parent
    ? `hinge (${n.hingePoint.x.toFixed(0)},${n.hingePoint.y.toFixed(0)}) axis (${n.hingeAxis.x.toFixed(0)},${n.hingeAxis.y.toFixed(0)}) ${(n.angle * 180 / Math.PI).toFixed(0)}°`
    : 'root — stays flat'
  console.log(`${pad}#${n.panel.id} ${size.padEnd(9)} ${hinge}`)
  n.children.forEach((c) => walk(c, pad + '   '))
}
walk(tree.root)
console.log()
