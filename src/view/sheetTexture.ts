import * as THREE from 'three'
import type { Dieline, LineType } from '../geom/types'

const PRINT_COLOR: Record<LineType, string> = {
  cut: '#e2453a',
  crease: '#1fa65c',
  perf: '#3b7ddd',
}

/** Longest side of the generated texture, in pixels. */
const MAX_TEXTURE = 2048

/**
 * Builds one texture of the whole press sheet, which the box model then samples
 * per panel using each panel's own position on that sheet.
 *
 * This is what makes the artwork land in the right place: rather than giving
 * every panel its own image, there is a single sheet and each panel is a window
 * onto it — exactly how the flat actually prints. So a panel that folds to the
 * back of the box carries the part of the sheet that was printed there.
 *
 * For a bitmap dieline the source image itself is the sheet, so whatever was
 * printed on it — logos, type, colour — appears on the folded box. For vector
 * input there is no raster to sample, so the parsed linework is drawn instead.
 */
export function makeSheetTexture(dieline: Dieline): THREE.CanvasTexture {
  const aspect = dieline.width / dieline.height
  const w = aspect >= 1 ? MAX_TEXTURE : Math.round(MAX_TEXTURE * aspect)
  const h = aspect >= 1 ? Math.round(MAX_TEXTURE / aspect) : MAX_TEXTURE

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, w)
  canvas.height = Math.max(1, h)
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // A dieline is drawn as the box is seen from *outside*. The fold lifts every
  // panel's +z toward the box interior (measured: all six walls end up with +z
  // inward), so the printed side is -z. Drawing the sheet mirrored means that
  // when you look at a -z face from outside — through reversed winding — the
  // two mirrors cancel and the artwork reads the right way round on the box.

  if (dieline.image) {
    // A bitmap dieline *is* the sheet — draw it as-is, artwork and all.
    ctx.drawImage(dieline.image, 0, 0, canvas.width, canvas.height)
  } else {
    // Vector input carries no raster, so print the linework we parsed.
    const sx = canvas.width / dieline.width
    const sy = canvas.height / dieline.height
    ctx.lineWidth = Math.max(1, canvas.width / 900)
    ctx.lineCap = 'round'
    for (const s of dieline.segments) {
      ctx.strokeStyle = PRINT_COLOR[s.type]
      ctx.beginPath()
      // Sheet space is Y-up, canvas is Y-down.
      ctx.moveTo(s.a.x * sx, canvas.height - s.a.y * sy)
      ctx.lineTo(s.b.x * sx, canvas.height - s.b.y * sy)
      ctx.stroke()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  // flipY stays at its default, so v = 0 is the bottom of the sheet and the
  // UVs below can use sheet coordinates directly.
  return texture
}
