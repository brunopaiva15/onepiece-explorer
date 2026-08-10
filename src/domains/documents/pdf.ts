import 'server-only'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { IngestionRejection, type IngestionLimits } from '../ingestion/limits.ts'
import type { BBox } from '@/db/schema/documents.ts'

/**
 * PDF page extraction.
 *
 * Two things come out of a PDF, and they are worth keeping separate:
 *
 *   the raster  — every PDF has one, rendered here at a capped DPI
 *   the text layer — only some do, and where it exists it is exact, free and
 *                    carries coordinates
 *
 * A digital release usually has a text layer; a scan never does. When one is
 * present the OCR step is skipped entirely: no model call, no tesseract pass,
 * no transcription error. That is the single largest cost saving in the
 * pipeline, and it is also the most accurate path, so it is always preferred.
 */

export interface PdfTextItem {
  text: string
  /** Normalised to [0,1] against page dimensions, like every other bbox. */
  bbox: BBox
}

export interface PdfPage {
  index: number
  width: number
  height: number
  png: Buffer
  /** Empty when the PDF carries no text layer. */
  textItems: PdfTextItem[]
}

/** Cap the render resolution: a PDF can declare an arbitrarily large page. */
const TARGET_WIDTH = 1400
const MAX_SCALE = 4

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfjsModule> | null = null

/**
 * Load the legacy build, which is the one that runs under Node without a DOM.
 *
 * Imported lazily so the module graph stays light for requests that never
 * touch a PDF — pdfjs is several megabytes.
 */
async function pdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

/**
 * Where pdfjs finds its bundled standard-font data.
 *
 * Resolved from the installed package rather than assumed, because pnpm's
 * store means node_modules/pdfjs-dist is a symlink and a hand-built path
 * misses. Without it pdfjs warns on every document and falls back to
 * approximate metrics, which shifts text bounding boxes — and a shifted box
 * assigns a quote to the wrong panel.
 */
let standardFontsDir: string | undefined
function standardFontDataUrl(): string | undefined {
  if (standardFontsDir !== undefined) return standardFontsDir
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('pdfjs-dist/package.json')
    standardFontsDir = `${path.join(path.dirname(pkg), 'standard_fonts')}${path.sep}`
  } catch {
    standardFontsDir = undefined
  }
  return standardFontsDir
}

export async function extractPdfPages(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<PdfPage[]> {
  const lib = await pdfjs()

  const task = lib.getDocument({
    data: bytes,
    // No network, ever. A PDF can reference external resources, and this is an
    // untrusted file: fetching anything it names would turn an upload into a
    // server-side request forgery. Font data comes from the local package,
    // and no cMapUrl is set so remote character maps are never fetched.
    // (Script evaluation is off by default since pdfjs 5 — there is no longer
    // an isEvalSupported option to set.)
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
  })

  let document
  try {
    document = await task.promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/password/i.test(message)) {
      throw new IngestionRejection(
        'encrypted_pdf',
        'Le PDF est protégé par mot de passe.',
        'Retirez la protection depuis votre lecteur PDF, puis réimportez le fichier.',
      )
    }
    throw new IngestionRejection(
      'corrupt_pdf',
      `Le PDF est illisible : ${message}`,
      'Le fichier est probablement corrompu. Réexportez-le et réessayez.',
    )
  }

  try {
    if (document.numPages > limits.maxPages) {
      throw new IngestionRejection(
        'too_many_pages',
        `Le PDF contient ${document.numPages} pages (maximum ${limits.maxPages}).`,
        'Importez le chapitre en plusieurs fois, ou augmentez MAX_PAGES_PER_CHAPTER.',
      )
    }

    const pages: PdfPage[] = []

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })

      const scale = Math.min(MAX_SCALE, TARGET_WIDTH / base.width)
      const viewport = page.getViewport({ scale })

      const width = Math.round(viewport.width)
      const height = Math.round(viewport.height)

      if (width * height > limits.maxPixelsPerPage) {
        throw new IngestionRejection(
          'page_too_large',
          `La page ${pageNumber} dépasse la taille maximale en pixels.`,
          "Cette page est disproportionnée. Vérifiez qu'il s'agit bien d'un chapitre de manga.",
        )
      }

      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')
      // PDFs assume a white page; the canvas starts transparent.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)

      await page.render({
        // @napi-rs/canvas is API-compatible with the browser canvas pdfjs
        // expects, but not nominally typed as one.
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise

      const textItems = await readTextLayer(page, width, height, scale)

      pages.push({
        index: pageNumber - 1,
        width,
        height,
        png: canvas.toBuffer('image/png'),
        textItems,
      })

      page.cleanup()
    }

    return pages
  } finally {
    // Destroying the loading task tears down the worker; the document proxy
    // itself has no destroy() in pdfjs 6.
    await task.destroy()
  }
}

/**
 * Read the text layer, if there is one.
 *
 * pdfjs gives each item a transform matrix in PDF space (origin bottom-left).
 * Converting to the top-left, normalised space the rest of the pipeline uses
 * here means every downstream consumer — panel assignment, evidence anchoring,
 * the "open the source panel" affordance — works in one coordinate system.
 */
async function readTextLayer(
  page: Awaited<ReturnType<Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>['getPage']>>,
  width: number,
  height: number,
  scale: number,
): Promise<PdfTextItem[]> {
  const content = await page.getTextContent()
  const items: PdfTextItem[] = []

  for (const raw of content.items) {
    if (!('str' in raw)) continue
    const text = raw.str.trim()
    if (text.length === 0) continue

    const [, , , , e, f] = raw.transform as number[]
    const itemWidth = (raw.width ?? 0) * scale
    const itemHeight = (raw.height ?? 0) * scale
    const x = (e ?? 0) * scale
    // PDF y grows upward from the bottom; ours grows downward from the top.
    const yTop = height - (f ?? 0) * scale - itemHeight

    items.push({
      text: raw.str,
      bbox: {
        x: clamp01(x / width),
        y: clamp01(yTop / height),
        w: clamp01(itemWidth / width),
        h: clamp01(itemHeight / height),
      },
    })
  }

  return items
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * Group loose text items into lines and then blocks.
 *
 * pdfjs emits one item per run of same-styled glyphs, so a single speech
 * bubble arrives as a handful of fragments. Anchoring an excerpt against a
 * fragment would fail for any quote spanning two of them, so they are merged
 * back into the blocks a reader would perceive.
 */
export function groupTextItems(items: PdfTextItem[]): PdfTextItem[] {
  if (items.length === 0) return []

  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox.y - b.bbox.y
    if (Math.abs(dy) > 0.008) return dy
    return a.bbox.x - b.bbox.x
  })

  const lines: PdfTextItem[][] = []
  let current: PdfTextItem[] = [sorted[0]!]

  for (const item of sorted.slice(1)) {
    const previous = current[current.length - 1]!
    const verticallyAligned = Math.abs(item.bbox.y - previous.bbox.y) <= 0.008

    /*
     * Vertical alignment alone is not enough. Two bubbles in two side-by-side
     * panels sit at the same height, and merging them produces one block whose
     * box straddles the gutter — so the quote gets attributed to whichever
     * panel the midpoint happens to fall in, which is neither of them.
     *
     * A word space is well under 1% of page width; a panel gutter is several
     * percent. The threshold scales with text height so it holds at any
     * render resolution.
     *
     * This is a heuristic standing in for information we do not have yet:
     * panel detection runs after this step. Once panels are known, blocks are
     * re-assigned to the panel that contains them, which is the real fix.
     */
    const horizontalGap = item.bbox.x - (previous.bbox.x + previous.bbox.w)
    const sameBlock =
      horizontalGap <= Math.max(0.02, previous.bbox.h * 1.5)

    if (verticallyAligned && sameBlock) current.push(item)
    else {
      lines.push(current)
      current = [item]
    }
  }
  lines.push(current)

  /*
   * Merge consecutive lines into blocks.
   *
   * Vertical proximity is necessary but not sufficient, for the same reason as
   * above: after the horizontal split, two lines from two side-by-side panels
   * are adjacent in this array and sit at the same height, so a purely
   * vertical test would immediately glue them back together. Lines of one
   * paragraph also overlap horizontally; lines in different panels do not.
   */
  const blocks: PdfTextItem[][] = []
  let block: PdfTextItem[][] = [lines[0]!]

  for (const line of lines.slice(1)) {
    const previousLine = block[block.length - 1]!

    const previousBottom = Math.max(
      ...previousLine.map((i) => i.bbox.y + i.bbox.h),
    )
    const gap = Math.min(...line.map((i) => i.bbox.y)) - previousBottom
    const lineHeight = Math.max(...line.map((i) => i.bbox.h))

    const left = Math.max(
      Math.min(...previousLine.map((i) => i.bbox.x)),
      Math.min(...line.map((i) => i.bbox.x)),
    )
    const right = Math.min(
      Math.max(...previousLine.map((i) => i.bbox.x + i.bbox.w)),
      Math.max(...line.map((i) => i.bbox.x + i.bbox.w)),
    )
    const narrowest = Math.min(
      Math.max(...previousLine.map((i) => i.bbox.x + i.bbox.w)) -
        Math.min(...previousLine.map((i) => i.bbox.x)),
      Math.max(...line.map((i) => i.bbox.x + i.bbox.w)) -
        Math.min(...line.map((i) => i.bbox.x)),
    )
    const overlaps = right - left > narrowest * 0.3

    if (gap <= lineHeight * 1.2 && overlaps) block.push(line)
    else {
      blocks.push(block.flat())
      block = [line]
    }
  }
  blocks.push(block.flat())

  return blocks.map(mergeItems)
}

function mergeItems(group: PdfTextItem[]): PdfTextItem {
  const x = Math.min(...group.map((i) => i.bbox.x))
  const y = Math.min(...group.map((i) => i.bbox.y))
  const right = Math.max(...group.map((i) => i.bbox.x + i.bbox.w))
  const bottom = Math.max(...group.map((i) => i.bbox.y + i.bbox.h))

  // Join with a space unless the fragments already butt up against each other
  // mid-word, which pdfjs does for kerning runs.
  let text = ''
  let previous: PdfTextItem | null = null
  for (const item of group) {
    if (previous) {
      const sameLine = Math.abs(item.bbox.y - previous.bbox.y) <= 0.008
      const touching =
        sameLine && item.bbox.x - (previous.bbox.x + previous.bbox.w) < 0.004
      text += touching ? '' : ' '
    }
    text += item.text
    previous = item
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    bbox: { x, y, w: right - x, h: bottom - y },
  }
}
