import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, documents, pages, textBlocks } from '@/db/schema/documents.ts'
import { normalisePage } from '../documents/images.ts'
import { normalizeText } from '../knowledge/normalize.ts'
import { storage, storageKey, type StorageAdapter } from '../storage/index.ts'
import type { ExtractedPage, ExtractionResult } from './extract.ts'
import { type IngestionLimits } from './limits.ts'

/**
 * Write extracted pages to storage and to the database.
 *
 * Storage first, database second, and deliberately so. A page row that points
 * at a missing object is a broken chapter the user has to debug; an orphaned
 * object is a few kilobytes nobody sees, cleaned up by the same prefix delete
 * that removes the chapter. Given that one of the two will happen when a run
 * dies halfway, this is the direction to fail in.
 *
 * Re-importing the same file replaces the chapter's pages rather than
 * appending to them. Anything else turns a retry — the most natural response
 * to a failed import — into a silently duplicated chapter.
 */

export interface PersistOptions {
  userId: string
  chapterId: string
  documentId: string | null
  limits: IngestionLimits
  /** Injected in tests; defaults to the configured driver. */
  adapter?: StorageAdapter
  onProgress?: (done: number, total: number) => void
}

export interface PersistedPage {
  id: string
  index: number
  width: number
  height: number
  isDoubleSpread: boolean
  phash: string
  textBlockCount: number
}

export async function persistPages(
  extraction: ExtractionResult,
  options: PersistOptions,
): Promise<PersistedPage[]> {
  const store = options.adapter ?? storage()
  const { userId, chapterId, limits } = options

  const prepared: Array<{
    page: ExtractedPage
    keys: { original: string; display: string; thumb: string }
    normalised: Awaited<ReturnType<typeof normalisePage>>
  }> = []

  for (const [position, page] of extraction.pages.entries()) {
    const normalised = await normalisePage(page.bytes, limits)

    // Keys are derived from the page index, never from the uploaded filename.
    // The filename is attacker-controlled and, worse for daily use, unstable:
    // re-importing the same chapter from a differently-named export would
    // otherwise write a second set of objects beside the first.
    const stem = String(page.index).padStart(4, '0')
    const keys = {
      original: storageKey({ userId, chapterId, kind: 'original', filename: `${stem}.bin` }),
      display: storageKey({ userId, chapterId, kind: 'display', filename: `${stem}.webp` }),
      thumb: storageKey({ userId, chapterId, kind: 'thumb', filename: `${stem}.webp` }),
    }

    await Promise.all([
      store.put(keys.original, page.bytes, 'application/octet-stream'),
      store.put(keys.display, normalised.display, 'image/webp'),
      store.put(keys.thumb, normalised.thumb, 'image/webp'),
    ])

    prepared.push({ page, keys, normalised })
    options.onProgress?.(position + 1, extraction.pages.length)
  }

  return withIngest(async (db) => {
    const [chapter] = await db
      .select({ number: chapters.number })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)

    if (!chapter) {
      throw new Error(`Chapitre introuvable : ${chapterId}`)
    }

    // Replace, do not append. Cascades take the panels and text blocks with
    // them, which is what makes a retry idempotent instead of duplicating.
    await db.delete(pages).where(eq(pages.chapterId, chapterId))

    const written: PersistedPage[] = []

    for (const { page, keys, normalised } of prepared) {
      const [row] = await db
        .insert(pages)
        .values({
          chapterId,
          documentId: options.documentId,
          userId,
          chapterNumber: chapter.number,
          index: page.index,
          width: normalised.width,
          height: normalised.height,
          isDoubleSpread: normalised.isDoubleSpread,
          storageKeyOriginal: keys.original,
          storageKeyDisplay: keys.display,
          storageKeyThumb: keys.thumb,
          phash: normalised.phash,
        })
        .returning({ id: pages.id })

      if (!row) throw new Error(`Insertion de la page ${page.index} échouée.`)

      let textBlockCount = 0
      if (page.textBlocks && page.textBlocks.length > 0) {
        await db.insert(textBlocks).values(
          page.textBlocks.map((block, order) => ({
            pageId: row.id,
            chapterId,
            userId,
            chapterNumber: chapter.number,
            bbox: block.bbox,
            text: block.text,
            // Precomputed here rather than by a trigger so the value the
            // application anchors against and the value the database stores
            // are produced by the same function call, not two implementations
            // that have to be kept in agreement.
            normalizedText: normalizeText(block.text),
            confidence: 1,
            // A PDF text layer is the source itself, not a transcription of
            // it: there is no recognition step that could have gone wrong.
            source: 'pdf_text' as const,
            readingOrder: order,
          })),
        )
        textBlockCount = page.textBlocks.length
      }

      written.push({
        id: row.id,
        index: page.index,
        width: normalised.width,
        height: normalised.height,
        isDoubleSpread: normalised.isDoubleSpread,
        phash: normalised.phash,
        textBlockCount,
      })
    }

    await db
      .update(chapters)
      .set({ pageCount: written.length, updatedAt: new Date() })
      .where(eq(chapters.id, chapterId))

    if (options.documentId) {
      await db
        .update(documents)
        .set({ hasTextLayer: extraction.hasTextLayer })
        .where(eq(documents.id, options.documentId))
    }

    return written
  })
}

/**
 * Reorder or exclude pages after a human has looked at them.
 *
 * Automatic ordering is a guess from filenames or PDF page order, and it is
 * wrong often enough — covers, credits pages, a double spread split into two
 * files in the wrong sequence — that correcting it has to be a first-class
 * operation rather than a reason to re-import.
 *
 * The reindex runs in two passes through a negative range, because
 * `(chapter_id, index)` is unique and any single-pass permutation collides
 * with itself the moment two pages swap places.
 */
export async function reorderPages(
  userId: string,
  chapterId: string,
  order: Array<{ pageId: string; index: number; excluded?: boolean }>,
): Promise<void> {
  if (order.length === 0) return

  const seen = new Set<number>()
  for (const entry of order) {
    if (!Number.isInteger(entry.index) || entry.index < 0) {
      throw new Error(`Position invalide : ${String(entry.index)}`)
    }
    if (seen.has(entry.index)) {
      throw new Error(`Position ${entry.index} attribuée deux fois.`)
    }
    seen.add(entry.index)
  }

  await withIngest(async (db) => {
    const existing = await db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.chapterId, chapterId), eq(pages.userId, userId)))

    const known = new Set(existing.map((p) => p.id))
    for (const entry of order) {
      if (!known.has(entry.pageId)) {
        throw new Error(`Page ${entry.pageId} n'appartient pas à ce chapitre.`)
      }
    }

    // Park every page being moved outside the range the final indices occupy,
    // so the second pass can land on any target without hitting the unique
    // constraint against a page that has not moved yet.
    for (const [position, entry] of order.entries()) {
      await db
        .update(pages)
        .set({ index: -1 - position })
        .where(and(eq(pages.id, entry.pageId), eq(pages.chapterId, chapterId)))
    }

    for (const entry of order) {
      await db
        .update(pages)
        .set({
          index: entry.index,
          ...(entry.excluded === undefined ? {} : { excluded: entry.excluded }),
        })
        .where(and(eq(pages.id, entry.pageId), eq(pages.chapterId, chapterId)))
    }

    // Excluded pages are kept, not deleted: the user may have excluded a page
    // by mistake, and the original bytes are the one thing the pipeline cannot
    // reconstruct. They simply stop counting.
    const [counted] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pages)
      .where(and(eq(pages.chapterId, chapterId), eq(pages.excluded, false)))

    await db
      .update(chapters)
      .set({ pageCount: counted?.count ?? 0, updatedAt: new Date() })
      .where(eq(chapters.id, chapterId))
  })
}
