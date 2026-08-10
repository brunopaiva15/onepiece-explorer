import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, documents, works } from '@/db/schema/documents.ts'
import { storage, storageKey, type StorageAdapter } from '../storage/index.ts'
import { extractPages, type ExtractionResult, type LooseImage } from './extract.ts'
import { IngestionRejection, ingestionLimits, type IngestionLimits } from './limits.ts'
import { persistPages, type PersistedPage } from './persist.ts'
import { sha256, validateUpload } from './validate.ts'

/**
 * Import a chapter: validate, extract, store, record.
 *
 * This is the whole of what the plan calls steps 1-3 — the part that runs
 * before any model is involved and produces something the user can look at.
 * Everything after it (panels, OCR, extraction, review) operates on the rows
 * this writes.
 *
 * It is deliberately synchronous and re-runnable rather than queued. The
 * asynchronous pipeline begins at panel detection, where the work is long and
 * the user is expected to walk away; getting pages on screen is the moment
 * they are still watching, and a job queue between the upload and the preview
 * buys latency and a progress bar to explain it.
 */

export const PIPELINE_VERSION = '1'

export interface ImportRequest {
  userId: string
  workId: string
  chapterNumber: number
  title?: string
  volume?: number
  language?: string
  readingDirection?: 'rtl' | 'ltr'
  /** Exactly one of these. */
  file?: { filename: string; bytes: Uint8Array }
  images?: LooseImage[]
  limits?: IngestionLimits
  adapter?: StorageAdapter
  onProgress?: (stage: ImportStage, done: number, total: number) => void
}

export type ImportStage = 'validate' | 'extract' | 'store'

export interface ImportResult {
  chapterId: string
  documentId: string | null
  pages: PersistedPage[]
  hasTextLayer: boolean
  /** True when this chapter already existed and its pages were replaced. */
  replaced: boolean
  /** Set when the same bytes were already imported for this chapter. */
  unchanged: boolean
}

export async function importChapter(request: ImportRequest): Promise<ImportResult> {
  const limits = request.limits ?? ingestionLimits()
  const store = request.adapter ?? storage()

  if (!Number.isInteger(request.chapterNumber) || request.chapterNumber < 0) {
    throw new IngestionRejection(
      'invalid_chapter_number',
      `Numéro de chapitre invalide : ${String(request.chapterNumber)}`,
      'Le numéro doit être un entier positif.',
    )
  }

  if (!request.file === !request.images) {
    throw new IngestionRejection(
      'invalid_request',
      'Fournissez soit un fichier, soit une liste d’images — pas les deux.',
      'Sélectionnez un PDF, une archive CBZ, ou un ensemble d’images.',
    )
  }

  request.onProgress?.('validate', 0, 1)

  let extraction: ExtractionResult
  let uploadSha: string
  let documentMeta: {
    kind: 'pdf' | 'zip' | 'cbz' | 'images'
    filename: string
    byteSize: number
    mime: string
    bytes: Uint8Array
  } | null = null

  if (request.file) {
    const validated = await validateUpload(
      request.file.bytes,
      request.file.filename,
      limits,
    )

    if (validated.kind === 'images') {
      // A single loose image is a legitimate one-page chapter; treat it as an
      // image list of one rather than refusing.
      extraction = await extractPages(
        { kind: 'images', images: [{ filename: request.file.filename, bytes: request.file.bytes }] },
        limits,
      )
    } else {
      request.onProgress?.('extract', 0, 1)
      extraction = await extractPages(
        { kind: validated.kind, bytes: request.file.bytes, filename: request.file.filename },
        limits,
      )
    }

    uploadSha = validated.sha256
    documentMeta = {
      kind: validated.kind,
      filename: request.file.filename,
      byteSize: validated.byteSize,
      mime: validated.mime,
      bytes: request.file.bytes,
    }
  } else {
    const images = request.images ?? []

    // Loose images bypass the archive reader, so each one is validated on its
    // own. Skipping this because "they came from a file picker" would leave
    // the one input path with no content sniffing at all.
    for (const image of images) {
      const validated = await validateUpload(image.bytes, image.filename, limits)
      if (validated.kind !== 'images') {
        throw new IngestionRejection(
          'unexpected_entry',
          `« ${image.filename} » n'est pas une image (détecté : ${validated.mime}).`,
          'Sélectionnez uniquement des images JPEG, PNG, WebP ou AVIF.',
        )
      }
    }

    request.onProgress?.('extract', 0, 1)
    extraction = await extractPages({ kind: 'images', images }, limits)
    uploadSha = fingerprintImages(images)
  }

  if (extraction.pages.length > limits.maxPages) {
    throw new IngestionRejection(
      'too_many_pages',
      `Le chapitre contient ${extraction.pages.length} pages (maximum ${limits.maxPages}).`,
      'Importez-le en plusieurs fois, ou augmentez MAX_PAGES_PER_CHAPTER.',
    )
  }

  const { chapterId, replaced, unchanged } = await withIngest(async (db) => {
    const [work] = await db
      .select({ id: works.id, direction: works.defaultReadingDirection })
      .from(works)
      .where(and(eq(works.id, request.workId), eq(works.userId, request.userId)))
      .limit(1)

    if (!work) {
      throw new IngestionRejection(
        'unknown_work',
        'Œuvre introuvable.',
        'Rechargez la page ; si le problème persiste, recréez la bibliothèque.',
      )
    }

    const [existing] = await db
      .select({ id: chapters.id, fingerprint: chapters.sourceFingerprint })
      .from(chapters)
      .where(
        and(eq(chapters.workId, request.workId), eq(chapters.number, request.chapterNumber)),
      )
      .limit(1)

    const values = {
      title: request.title ?? null,
      volume: request.volume ?? null,
      language: request.language ?? 'fr',
      readingDirection: request.readingDirection ?? work.direction,
      sourceFingerprint: uploadSha,
      updatedAt: new Date(),
    }

    if (existing) {
      await db.update(chapters).set(values).where(eq(chapters.id, existing.id))
      return {
        chapterId: existing.id,
        replaced: true,
        unchanged: existing.fingerprint === uploadSha,
      }
    }

    const [created] = await db
      .insert(chapters)
      .values({
        workId: request.workId,
        userId: request.userId,
        number: request.chapterNumber,
        status: 'draft',
        ...values,
      })
      .returning({ id: chapters.id })

    if (!created) throw new Error('Création du chapitre échouée.')
    return { chapterId: created.id, replaced: false, unchanged: false }
  })

  // Keep the uploaded file itself. Reprocessing with a better pipeline must
  // never mean asking the user to find the original again — and re-rendering
  // from the source is the only way to fix a rendering bug retroactively.
  let documentId: string | null = null
  if (documentMeta) {
    const sourceKey = storageKey({
      userId: request.userId,
      chapterId,
      kind: 'source',
      filename: documentMeta.filename,
    })
    await store.put(sourceKey, documentMeta.bytes, documentMeta.mime)

    documentId = await withIngest(async (db) => {
      // One source document per chapter: a re-import replaces the record
      // rather than accumulating one row per attempt.
      await db.delete(documents).where(eq(documents.chapterId, chapterId))
      const [row] = await db
        .insert(documents)
        .values({
          chapterId,
          userId: request.userId,
          kind: documentMeta.kind,
          originalFilename: documentMeta.filename,
          byteSize: documentMeta.byteSize,
          sha256: uploadSha,
          mime: documentMeta.mime,
          storageKey: sourceKey,
          hasTextLayer: extraction.hasTextLayer,
        })
        .returning({ id: documents.id })
      return row?.id ?? null
    })
  }

  request.onProgress?.('store', 0, extraction.pages.length)

  const pages = await persistPages(extraction, {
    userId: request.userId,
    chapterId,
    documentId,
    limits,
    adapter: store,
    onProgress: (done, total) => request.onProgress?.('store', done, total),
  })

  return {
    chapterId,
    documentId,
    pages,
    hasTextLayer: extraction.hasTextLayer,
    replaced,
    unchanged,
  }
}

/**
 * Content fingerprint for a set of loose images.
 *
 * Hashes each image and then the ordered list of hashes, so the same pages
 * picked in a different order are a different import — which they are, since
 * order is the chapter.
 */
function fingerprintImages(images: LooseImage[]): string {
  const perImage = images.map((image) => sha256(image.bytes))
  return createHash('sha256').update(perImage.join('\n')).digest('hex')
}
