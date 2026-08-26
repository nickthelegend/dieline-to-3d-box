import { parsePdfDieline } from './pdf'
import { parseSvgDieline } from './svg'
import type { Dieline } from '../geom/types'

/** Reads whatever the user dropped and hands back classified linework. */
export async function loadDieline(file: File | Blob, name: string): Promise<Dieline> {
  // `split('.').pop()` would report a whole extensionless filename as if it
  // were the extension, so check for a real dot first.
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

  if (ext === 'pdf') {
    return parsePdfDieline(new Uint8Array(await file.arrayBuffer()))
  }
  if (ext === 'svg') {
    return parseSvgDieline(await file.text())
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) {
    const { parseRasterDieline } = await import('./raster')
    return parseRasterDieline(file)
  }
  throw new Error(ext
    ? `Unsupported file type ".${ext}". Drop a PDF, an SVG, or a colour-coded PNG.`
    : 'That file has no extension, so there is nothing to identify it by. Drop a PDF, an SVG, or a colour-coded PNG.')
}

export type { Dieline }
