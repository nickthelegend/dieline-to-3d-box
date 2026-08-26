# Dieline → 3D Box

Reads a flat packaging dieline, works out which pieces of card are panels and
which lines are hinges, and folds it into a closed 3D box in the browser.

Built for **Sivi Quant Labs Build Challenge 01**.

```bash
npm install
npm run dev      # http://localhost:5173 — the sample carton loads on start
```

| | |
|---|---|
| **Stack** | Vite · TypeScript · Three.js. No framework, no PDF library. |
| **Input** | `.pdf` and `.svg` (exact vector), `.png` / `.jpg` (traced) |
| **Sample** | `public/sample_dieline.pdf` — parses in ~30 ms, 18 panels, 17 hinges |
| **Result** | a closed **154.5 × 95.5 × 17.5 mm** carton |

Other commands:

```bash
npm run check      # headless: parse the sample, print the panel table + fold tree
npm run typecheck  # tsc --noEmit
npm run build      # production bundle into dist/
```

---

## How it works

Four stages, one file each. Nothing downstream knows anything about cartons —
each stage only knows about the stage before it.

```
 PDF / SVG / PNG            classified            planar             fold tree            Three.js
      file        ──────►    segments    ──────►  faces    ──────►  (hinge +   ──────►    scene
                  parse/               arrangement          foldTree  angle)      boxModel
```

### 1 · Parse — get lines, and know what each line means

`src/parse/pdf.ts` is a small PDF reader written from scratch: it scans the file
for `N G obj … endobj` blocks (more forgiving than following the xref table),
inflates streams with `DecompressionStream`, unpacks PDF 1.5 object streams, and
then walks the page's content stream operator by operator — `m` `l` `c` `re`
`cm` `q` `Q` `S` — flattening Béziers and applying the CTM. It recurses into
Form XObjects, which is where Illustrator usually hides the artwork.

A dieline is useless unless you know **which line is a cut and which is a
crease**, and it turns out the file says so directly. The sample uses the German
prepress convention, as named PDF `/Separation` spot colours:

| Separation | Means | Treated as |
|---|---|---|
| `Schneiden` | cut | panel boundary |
| `Rillen` | crease | **hinge** |
| `Rill-Schnitt 10x10` | perforated crease-cut | hinge |

`src/parse/classify.ts` holds the cascade, most reliable signal first:

1. **name** — the separation / layer / CSS class name (`Rillen`, `crease`, `fold`, `score`, …)
2. **colour** — the near-universal print convention: red = cut, green = crease, blue = score
3. **dash pattern** — a dashed line in a dieline is almost always a fold

So a file that uses none of the German vocabulary still parses, as long as it
follows *one* of the three conventions.

### 2 · Panels — faces of a planar arrangement

`src/geom/arrangement.ts`

A dieline is a planar subdivision. Every cut and every crease is a wall, and the
regions those walls enclose are exactly the panels of card. So finding the panels
is the standard problem of extracting the faces of a planar arrangement:

1. snap coincident endpoints so the linework is genuinely connected
2. split every segment at crossings and T-junctions
3. sort each vertex's neighbours by angle
4. walk half-edges, always taking the sharpest right turn

Step 4 traces every face exactly once. Loops that come back counter-clockwise
(positive signed area) are card; clockwise loops are either the outside of the
sheet or a hole punched inside a panel — which one is decided by containment.

No box knowledge here at all. Feed it any closed linework and it returns regions.

### 3 · The fold — where the actual math is

`src/geom/foldTree.ts`

Two panels that share a **crease** are hinged. That gives a graph; a
breadth-first spanning tree over it, rooted at the panel with the most
neighbours, gives a parent for every panel and the hinge it swings on. Extra
crease edges that are not tree edges are *closing creases* — panels that have to
meet when the box shuts, which is a nice free check that the box really closes
(the sample has 2).

Then the one piece of geometry that makes the whole thing work.

Every crease in a carton turns a right angle. The only thing left to decide is
**which way** each panel turns, and that falls out of the geometry. A panel
rotating about a hinge of unit direction **d** moves, to first order, with
velocity ω (**d** × **r**), where **r** points from the hinge to the panel. The
sheet lies flat in z = 0 and the box closes upward, so we want that velocity to
point up:

```
(d × r)·ẑ  =  d.x · r.y − d.y · r.x  >  0
```

If it comes out negative, flip **d**. After that, **every hinge in the tree folds
by the same +90°** — walls, end panels, dust flaps, the tuck tab, all of it.

That is the whole rule. Nothing in the code knows what a "front panel" or a
"glue flap" is:

- four walls in a chain, each turning 90°, *necessarily* close into a rectangular tube
- a flap hanging off a wall *necessarily* swings inward
- a tab hanging off that flap turns 90° again and tucks in

which is why the sample box closes exactly, and why a different carton would too.

### 4 · Render — hierarchy mirrors the fold tree

`src/view/boxModel.ts`

Each panel becomes a `THREE.Group` whose **local origin sits on its hinge line**,
with the panel's geometry translated so it still lands in the right place on the
flat sheet. Because the origin *is* the hinge, folding is nothing more than
setting that group's rotation — and because the groups are nested the way the
panels are joined, a parent carrying its children comes for free.

```ts
group.position.set(hinge.x - parentHinge.x, hinge.y - parentHinge.y, 0)
group.setRotationFromAxisAngle(axis, angle * t)   // that's the fold
```

Panels are extruded to a 0.5 mm board thickness and centred on their own
mid-plane, because that is where a real crease lives. The parsed linework is
drawn back onto both faces of the board in its original cut/crease colours, so
you can see the 3D panels really are the parsed 2D geometry.

The animation gives each depth of the tree a slice of the 0→1 fold parameter, so
the walls come up first and the tabs tuck in last. The slices are sized by how
much card is moving at that depth rather than split evenly — this carton ends in
a six-deep chain of small internal lock tabs, and an even split would spend more
than half the animation on panels already sealed inside the closed box. The
slider scrubs the same parameter by hand.

---

## What it found in the sample

`npm run check` prints the tree below — the role labels on the right are added
here for reading. The sample is a 154 × 95 × 16.5 mm carton:

```
fold tree — 16 panels folded, 17 hinges, 2 closing creases, 2 detached
  #1  437x269   root — the front wall (the only panel creased on all four sides)
     #6  437x48    top wall
        #0  437x269   back wall          ← walls #7 #1 #6 #0 close into the tube
           #11 176x40    tuck tab        ← tucks into the slot cut in #7
     #7  437x48    bottom wall
        #4  437x113   lock panel
           #13 #14 #15  lock tabs
              #5 #12 #16  ... which fold round into an internal platform
     #9  47x269    left end wall (exactly the size of the opening)
        #2  218x269   end reinforcement flap
     #8  47x269    right end wall
        #3  218x269   end reinforcement flap
```

The 2 **detached** panels are the die-cut slot and the finger hole: closed
regions with no crease anywhere on their boundary, so they are waste, not card.
They drop out of the fold tree on their own — no special case needed.

The 4 wall panels measure 45.35, 269.29, 48.19 and 269.29 pt. The 2.8 pt
difference between the two "equal" walls is the material caliper allowance a real
dieline carries, which is a good sign the parse is reading the actual file rather
than an idealised one.

---

## Choices, and what is simplified

**Why write the PDF reader instead of using pdf.js.** The one thing this
challenge really depends on is knowing a crease from a cut, and that information
lives in the *separation colour space* of each stroke. Going through a rendering
library means asking it for something it is not really built to hand back. It is
about 300 lines to read it directly, and the result is exact.

**Why 90° everywhere rather than per-panel angles.** A carton is a
right-angled object; a rule that derives the *direction* from geometry and keeps
the *magnitude* constant is both shorter and more general than classifying panels
by role. If a dieline needed a non-right-angle fold, `FoldNode.angle` is per-node
and already plumbed through — only the planner would change.

**Raster input is best-effort.** Vector input is exact. For a PNG, the tracer
classifies pixels by hue, collects long single-colour runs, and reconstructs the
outline; curves are recovered as chamfers by a corner-bridging pass that only
joins mutually-nearest, perpendicular loose ends. On the bundled PNG it finds 15
of the 18 panels — the three it misses are entirely bounded by curves — and folds
to the same 154.5 × 95.5 × 17.5 mm box. Physical size is assumed from 300 dpi, since a
bitmap carries no units.

**Printing the sheet on the box.** One texture is built for the whole press
sheet, and each panel's UVs are its own position on that sheet — so a panel that
folds to the back of the box carries the part of the flat that was printed there.
For a bitmap dieline the uploaded image *is* the sheet, so real artwork shows on
the folded box; for vector input the parsed linework is drawn instead. Verified
by mapping a labelled sheet: FRONT, BACK, TOP and BASE each land on the right
face. **Known limitation:** the board is printed on both faces from one sheet
image, so text on the top and bottom panels reads mirrored when viewed head-on
from directly above or below. It reads correctly from the normal three-quarter
product angle. Fixing it properly needs per-panel handedness derived from each
panel's folded orientation, which is not done — the toggle is there so it can be
turned off.

**Not handled.** Non-planar or curved creases; panels that must bend rather than
hinge; collision between panels (the fold is kinematic, not physical); dielines
where cut and crease are distinguished by stroke *width* alone.

---

## Layout

```
src/
  parse/
    pdfLexer.ts     PDF tokenizer + object model
    pdf.ts          document reader + content-stream interpreter
    svg.ts          SVG reader (uses the browser's own path geometry)
    raster.ts       PNG/JPG tracer
    classify.ts     cut vs crease: name → colour → dash cascade
    index.ts        dispatch on file type
  geom/
    types.ts        Segment · Panel · Hinge · FoldNode
    arrangement.ts  planar arrangement → panel faces
    foldTree.ts     crease graph → spanning tree, hinge axes, fold angles
  view/
    scene.ts        renderer, lighting, orbit, camera framing
    sheetTexture.ts one texture of the whole press sheet
    boxModel.ts     fold tree → Three.js hierarchy + the fold animation
  main.ts           upload, pipeline, UI wiring
tools/
  check.ts          headless pipeline check (npm run check)
```

`public/sample_dieline.pdf` and `.png` are the files bundled with the challenge,
kept so the app runs with nothing to download. The challenge brief itself is not
redistributed here.
