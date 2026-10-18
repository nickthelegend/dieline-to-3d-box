# recording.md — demo plan

## Blockchain determination: NONE

Checked before planning, not assumed:

```
grep -rniE "web3|ethers|wallet|rpc|contract|solana|algorand|sign(er|ature)" src/   -> no matches
package.json dependencies                                                          -> { "three": "^0.170.0" }
grep -rnE "fetch\(|XMLHttpRequest|WebSocket"                                       -> one hit: fetch('./sample_dieline.pdf')
```

There is no chain, no wallet, no signer and no network call beyond one static
asset. **No beat involves a wallet signature**, so the signing overlay, the
testnet key injection and the wallet auto-approve are all inert for this app and
are deliberately skipped rather than staged. No beat below is flagged SIGNING.

## What the app is

A dieline (flat packaging cutting layout) is uploaded, parsed into panels and
crease lines, and folded into a closed 3D carton. Everything is client-side.

## Beats

| id | what it shows | driver action | "finished" = real state change |
|----|---------------|---------------|-------------------------------|
| `b01_flat` | App loaded, sample carton already parsed, flat on screen | none — opening frame | `status` text contains `parsed` and `__app.model` exists |
| `b02_readout` | Readout: 202 cut lines, 18 creases, 18 panels, 17 hinges, 2 die-cut openings | glide cursor down the readout | readout row `panels found` === `18` |
| `b03_linework` | Die lines drawn on the board — red cut, green crease — and the legend | glide across the legend | `model.linework.length === 16` and all visible |
| `b04_fold` | **The money shot.** Click "Fold it closed"; the flat sheet folds into a carton | real click on `#play` | `model.foldValue === 1` (poll the real value, not a UI class) |
| `b05_orbit` | Orbit the closed carton to show it is a real closed 3D box | real pointer drag on the canvas | camera position changed AND `controls.target` unchanged |
| `b06_scrub` | Scrub the slider back through the fold and closed again | real `input` events on `#scrub` | `foldValue` tracks the slider to <0.001 |
| `b07_panels` | Toggle "Colour panels": 16 distinct hues, one per folded panel | real click on `#tPanelMap` | 16 distinct face colours |
| `b08_raster` | Upload the PNG — traced from pixels — folds to the identical box | real file upload of `sample_dieline.png` | `source` === `bitmap (traced)` AND box === `154.5 × 95.5 × 17.5 mm` |
| `b09_artwork` | Upload a printed dieline; fold; artwork lands on the correct faces | real upload + real fold | every panel material has a `.map` AND `foldValue === 1` |
| `b10_outro` | Final closed carton, slow orbit | slow drag | none — hold for audio |

## Pre-flight (each of these has eaten a take)

1. **Clear persisted state** — `localStorage`/`sessionStorage` cleared and a hard
   reload before driving. (App stores nothing, but clear anyway so a stale
   toggle state can never change what the take shows.)
2. **Finished = real state** — every `until()` polls `__app.model` /
   `foldValue` / material state. Never "wait for a second element to appear".
3. **No native dialogs** — the file input is driven via CDP `setFiles`, never a
   click that opens the OS picker (that swallowed clicks in an earlier session).
4. **Errors scoped to this run** — count console errors *before* driving, then
   fail only if the count grows.
5. **Recorder proves itself** — record 2 s, pull a frame, assert it is not blank
   and matches the app, before the real take.
