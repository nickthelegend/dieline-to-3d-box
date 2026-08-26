import { parsePdfDieline } from './pdf'
import { parseSvgDieline } from './svg'
import type { Dieline } from '../geom/types'

/** Reads whatever the user dropped and hands back classified linework. */
export async function loadDieline(file: File | Blob, name: string): Promise<Dieline> {
  const ext = name.toLowerCase().split('.').pop() ?? ''

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
  throw new Error(`Unsupported file type ".${ext}". Drop a PDF, an SVG, or a colour-coded PNG.`)
}

export type { Dieline }
