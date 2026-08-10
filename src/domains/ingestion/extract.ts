import 'server-only'
import { extractPdfPages, groupTextItems, type PdfTextItem } from '../documents/pdf.ts'
import { readArchivePages } from './archive.ts'
import { IngestionRejection, type IngestionLimits } from './limits.ts'
import { naturalCompare } from './validate.ts'

/**
 * Turn an accepted upload into an ordered list of pages.
 *
 * Three input shapes converge here — PDF, ZIP/CBZ, loose images — and
 * everything downstream sees one of them: an ordered array of image bytes,
 * each optionally carrying text that came free with the file.
 *
 * The text layer is the reason this returns more than bytes. A digital release
 * carries exact text with coordinates; a scan does not. Where it exists, the
 * OCR step is skipped entirely — no model call, no transcription error, and an
 * excerpt that anchors to a character-exact source. Detecting that here, once,
 * is what lets the rest of the pipeline stop caring which kind of file arrived.
 */

export interface ExtractedPage {
  index: number
  /** Original filename or a synthesised one; kept for display and for ordering. */
  sourceName: string
  bytes: Uint8Array
  /** Present only when the source carried a real text layer. */
  textBlocks?: PdfTextItem[]
}

export interface ExtractionResult {
  pages: ExtractedPage[]
  /** True when at least one page came with usable embedded text. */
  hasTextLayer: boolean
}

export interface LooseImage {
  filename: string
  bytes: Uint8Array
}

export async function extractPages(
  input:
    | { kind: 'pdf' | 'zip' | 'cbz'; bytes: Uint8Array; filename: string }
    | { kind: 'images'; images: LooseImage[] },
  limits: IngestionLimits,
): Promise<ExtractionResult> {
  if (input.kind === 'images') return fromLooseImages(input.images, limits)
  if (input.kind === 'pdf') return fromPdf(input.bytes, input.filename, limits)
  return fromArchive(input.bytes, limits)
}

async function fromPdf(
  bytes: Uint8Array,
  filename: string,
  limits: IngestionLimits,
): Promise<ExtractionResult> {
  const rendered = await extractPdfPages(bytes, limits)

  if (rendered.length === 0) {
    throw new IngestionRejection(
      'no_pages',
      'Le PDF ne contient aucune page.',
      'Vérifiez le fichier, puis réessayez.',
    )
  }

  const base = filename.replace(/\.pdf$/i, '')

  const pages = rendered.map((page): ExtractedPage => {
    /*
     * Group before storing, not at read time.
     *
     * pdfjs emits one item per run of same-styled glyphs, so a speech bubble
     * arrives as a handful of fragments. An excerpt spanning two of them would
     * anchor to neither. Grouping is deterministic, so doing it once here
     * keeps every later reprocessing run producing the same block ids — which
     * is what makes a human correction still match after a re-import.
     */
    const grouped = page.textItems.length > 0 ? groupTextItems(page.textItems) : []
    const usable = grouped.filter((block) => block.text.trim().length > 0)

    return {
      index: page.index,
      sourceName: `${base}-p${String(page.index + 1).padStart(3, '0')}.png`,
      bytes: new Uint8Array(page.png),
      ...(usable.length > 0 ? { textBlocks: usable } : {}),
    }
  })

  /*
   * A handful of stray characters is not a text layer.
   *
   * Some scanners embed a title or a page number without transcribing any of
   * the dialogue. Treating that as "this file has text" would skip OCR and
   * leave the chapter almost entirely unread, which is a worse failure than
   * running OCR unnecessarily: the pipeline would report success on a chapter
   * it never actually transcribed.
   */
  const withText = pages.filter((p) => (p.textBlocks?.length ?? 0) >= 2).length
  const hasTextLayer = withText >= Math.max(1, Math.ceil(pages.length * 0.5))

  return { pages, hasTextLayer }
}

async function fromArchive(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<ExtractionResult> {
  const entries = await readArchivePages(bytes, limits)
  return {
    pages: entries.map((entry, index) => ({
      index,
      sourceName: entry.name,
      bytes: entry.bytes,
    })),
    hasTextLayer: false,
  }
}

function fromLooseImages(
  images: LooseImage[],
  limits: IngestionLimits,
): ExtractionResult {
  if (images.length === 0) {
    throw new IngestionRejection(
      'no_pages',
      'Aucune image fournie.',
      'Sélectionnez les pages du chapitre, puis réessayez.',
    )
  }

  if (images.length > limits.maxPages) {
    throw new IngestionRejection(
      'too_many_pages',
      `${images.length} images fournies (maximum ${limits.maxPages}).`,
      'Importez le chapitre en plusieurs fois, ou augmentez MAX_PAGES_PER_CHAPTER.',
    )
  }

  // Natural order, so page2 precedes page10. A lexicographic sort gets that
  // backwards and produces a scrambled chapter that still looks plausible.
  const sorted = [...images].sort((a, b) => naturalCompare(a.filename, b.filename))

  return {
    pages: sorted.map((image, index) => ({
      index,
      sourceName: image.filename,
      bytes: image.bytes,
    })),
    hasTextLayer: false,
  }
}
