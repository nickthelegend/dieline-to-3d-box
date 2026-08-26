import * as THREE from 'three'
import './style.css'
import { loadDieline } from './parse'
import { buildArrangement } from './geom/arrangement'
import { buildFoldTree } from './geom/foldTree'
import { BoxModel } from './view/boxModel'
import { Viewer } from './view/scene'
import type { Dieline } from './geom/types'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const viewer = new Viewer($<HTMLCanvasElement>('stage'))
let model: BoxModel | null = null

/* ---------------- fold playback ---------------- */

/** Seconds for a full flat -> closed fold. */
const FOLD_SECONDS = 3.0

/**
 * Playback runs off the wall clock rather than accumulated frame deltas, so a
 * dropped frame shortens the step instead of stretching the animation — the
 * fold takes the same three seconds on a 144 Hz display and on a throttled tab.
 */
let play: { from: number; to: number; startedAt: number; seconds: number } | null = null
/** Seconds of camera-follow left to run after the fold last moved. */
let follow = 0

viewer.start((dt) => {
  if (!model) return

  if (play) {
    const t = Math.min(1, (performance.now() - play.startedAt) / 1000 / play.seconds)
    model.setFold(play.from + (play.to - play.from) * t)
    $<HTMLInputElement>('scrub').value = String(Math.round(model.foldValue * 1000))
    follow = 0.5
    if (t >= 1) { play = null; syncPlayButton() }
  }

  // The sheet shrinks a lot as it closes, so ease the framing while it moves.
  if (follow > 0) {
    follow -= dt
    viewer.followFrame(model.measure(), dt)
  }
})

function startFold(to: number) {
  if (!model) return
  const from = model.foldValue
  if (Math.abs(to - from) < 1e-4) return
  play = { from, to, startedAt: performance.now(), seconds: FOLD_SECONDS * Math.abs(to - from) }
  syncPlayButton()
}

function syncPlayButton() {
  const closed = (model?.foldValue ?? 0) > 0.5
  $<HTMLButtonElement>('play').textContent = play
    ? 'Folding…'
    : closed ? 'Unfold to flat' : 'Fold it closed'
}

/* ---------------- pipeline ---------------- */

async function run(file: File | Blob, name: string) {
  showOverlay(`Reading ${name}…`)
  try {
    const t0 = performance.now()

    const dieline = await loadDieline(file, name)
    if (dieline.segments.length < 4) throw new Error('Found almost no linework in that file.')

    const arrangement = buildArrangement(dieline.segments)
    if (arrangement.panels.length === 0) throw new Error('No closed panels — the linework does not form regions.')

    const tree = buildFoldTree(arrangement)
    const parseMs = performance.now() - t0

    model?.dispose()
    model = new BoxModel(dieline, arrangement, tree, {
      showLinework: $<HTMLInputElement>('tLinework').checked,
      panelMap: $<HTMLInputElement>('tPanelMap').checked,
    })
    viewer.scene.add(model.object)

    // Measure the closed box, then drop back to flat to start the animation.
    model.setFold(1)
    const closed = model.measure()
    model.setFold(0)
    const flat = model.measure()

    play = null
    $<HTMLInputElement>('scrub').value = '0'
    syncPlayButton()
    viewer.frame(flat)

    report(dieline, arrangement.panels.length, tree, closed, parseMs)
    status(`parsed ${name} in ${parseMs.toFixed(0)} ms`, 'ok')
  } catch (err) {
    status((err as Error).message, 'err')
  } finally {
    hideOverlay()
  }
}

function report(
  d: Dieline,
  panelCount: number,
  tree: ReturnType<typeof buildFoldTree>,
  closed: THREE.Box3,
  ms: number,
) {
  const size = closed.getSize(new THREE.Vector3())
  const dims = [size.x, size.y, size.z].sort((a, b) => b - a)
  const cycles = tree.hinges.length - (tree.nodes.length - 1)
  const byType = { cut: 0, crease: 0, perf: 0 }
  for (const s of d.segments) byType[s.type]++

  const rows: [string, string][] = [
    ['source', d.source],
    ['sheet', `${(d.width * d.mmPerUnit).toFixed(0)} × ${(d.height * d.mmPerUnit).toFixed(0)} mm`],
    ['cut lines', String(byType.cut)],
    ['crease lines', String(byType.crease + byType.perf)],
    ['—', ''],
    ['panels found', String(panelCount)],
    ['hinges', String(tree.hinges.length)],
    ['folded panels', String(tree.nodes.length)],
    ['die-cut openings', String(tree.detached.length)],
    ['closing creases', String(Math.max(0, cycles))],
    ['—', ''],
    // One decimal: the folded box lands within a hair of a .5 boundary on every
    // axis, so whole millimetres flip on floating-point noise and the same
    // carton reads differently from a PDF and from an SVG of that PDF.
    ['closed box', `${dims[0].toFixed(1)} × ${dims[1].toFixed(1)} × ${dims[2].toFixed(1)} mm`],
    ['parse + build', `${ms.toFixed(0)} ms`],
  ]

  $('readout').innerHTML = rows
    .map(([k, v]) => (k === '—' ? '<div class="rule"></div>' : `<div class="k">${k}</div><div class="v">${v}</div>`))
    .join('')
}

/* ---------------- chrome ---------------- */

function status(msg: string, kind: 'ok' | 'err') {
  const el = $('status')
  el.className = `status ${kind}`
  el.textContent = kind === 'err' ? `⚠ ${msg}` : `✓ ${msg}`
}
function showOverlay(text: string) { $('overlayText').textContent = text; $('overlay').hidden = false }
function hideOverlay() { $('overlay').hidden = true }

$('browse').addEventListener('click', () => $<HTMLInputElement>('file').click())
$('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) run(f, f.name)
})
$('loadSample').addEventListener('click', loadSample)

// Drop anywhere on the page, not just on the dashed box.
const drop = $('drop')
for (const ev of ['dragenter', 'dragover'] as const) {
  addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') })
}
addEventListener('dragleave', () => drop.classList.remove('over'))
addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer?.files?.[0]
  if (f) run(f, f.name)
})

$('play').addEventListener('click', () => {
  if (!model) return
  if (play) { play = null; syncPlayButton(); return } // click again to stop
  startFold(model.foldValue > 0.5 ? 0 : 1)
})

$('scrub').addEventListener('input', (e) => {
  if (!model) return
  play = null
  model.setFold(Number((e.target as HTMLInputElement).value) / 1000)
  follow = 0.35
  syncPlayButton()
})

$('reset').addEventListener('click', () => { if (model) viewer.frame(model.measure()) })
$('tLinework').addEventListener('change', (e) => model?.setLinework((e.target as HTMLInputElement).checked))
$('tPanelMap').addEventListener('change', (e) => model?.setPanelMap((e.target as HTMLInputElement).checked))
$('tSpin').addEventListener('change', (e) => {
  viewer.controls.autoRotate = (e.target as HTMLInputElement).checked
})

async function loadSample() {
  const res = await fetch(new URL('./sample_dieline.pdf', document.baseURI).href)
  if (!res.ok) { status('could not load the bundled sample', 'err'); return }
  await run(await res.blob(), 'sample_dieline.pdf')
}

// Handy when poking at the fold from the console during development.
if (import.meta.env.DEV) Object.assign(window, { __app: { viewer, get model() { return model } } })

loadSample()
