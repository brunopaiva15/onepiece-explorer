import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, pages, panels, textBlocks } from '@/db/schema/documents.ts'
import {
  assignToPanel,
  detectPanels,
  type DetectedPanel,
} from '@/domains/documents/panels.ts'
import { greyscaleMatrix } from '@/domains/documents/images.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { storage, type StorageAdapter } from '@/domains/storage/index.ts'

/**
 * Cut every page of a chapter into panels.
 *
 * Deterministic and free — no model is involved, which is why this runs first
 * and why its output can be trusted as a fixed frame for everything after it.
 * A panel is the unit every later citation points at: get the boxes wrong and
 * every quote is attributed to the wrong picture, so the evidence link that
 * makes a fact checkable points somewhere misleading.
 *
 * Detection runs on the *original* bytes rather than the display derivative.
 * The derivative is WebP at quality 82, and lossy compression softens exactly
 * the thing the detector looks for: the sharp, uniformly white line of a
 * gutter.
 */

export interface PanelDetectResult {
  pagesProcessed: number
  panelsCreated: number
  lowConfidencePages: number
}

export async function runPanelDetect(
  userId: string,
  chapterId: string,
  adapter?: StorageAdapter,
): Promise<PanelDetectResult> {
  const store = adapter ?? storage()
  const limits = ingestionLimits()

  const { chapterNumber, direction, pageRows } = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ number: chapters.number, direction: chapters.readingDirection })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)

    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const rows = await db
      .select({
        id: pages.id,
        index: pages.index,
        originalKey: pages.storageKeyOriginal,
      })
      .from(pages)
      .where(
        and(
          eq(pages.chapterId, chapterId),
          eq(pages.userId, userId),
          // Excluded pages are kept but not processed: paying to analyse a
          // page the reader removed would be the wrong kind of thorough.
          eq(pages.excluded, false),
        ),
      )
      .orderBy(asc(pages.index))

    return {
      chapterNumber: chapter.number,
      direction: chapter.direction,
      pageRows: rows,
    }
  })

  let panelsCreated = 0
  let lowConfidencePages = 0

  for (const page of pageRows) {
    const bytes = await store.get(page.originalKey)
    const grey = await greyscaleMatrix(bytes, limits)
    const detected = detectPanels(grey, { direction })

    if (detected.some((panel) => panel.confidence < 0.6)) lowConfidencePages++

    await withIngest(async (db) => {
      // Replace rather than append: re-running the step must be idempotent,
      // and panel ids are not referenced by anything accepted yet — the AI
      // steps that will cite them have not run.
      await db.delete(panels).where(eq(panels.pageId, page.id))

      const inserted = await db
        .insert(panels)
        .values(
          detected.map((panel, index) => ({
            pageId: page.id,
            chapterId,
            userId,
            chapterNumber,
            index,
            bbox: panel.bbox,
            readingOrder: panel.readingOrder,
            confidence: panel.confidence,
            source: 'auto' as const,
          })),
        )
        .returning({ id: panels.id, index: panels.index })

      panelsCreated += inserted.length
      await assignTextBlocks(db, page.id, detected, inserted)
    })
  }

  return {
    pagesProcessed: pageRows.length,
    panelsCreated,
    lowConfidencePages,
  }
}

/**
 * Attach each text block to the panel that contains it.
 *
 * This supersedes the geometric guesswork the PDF text grouper had to do
 * before panels were known. A block matching no panel keeps a null panel and
 * stays stored: page furniture — a chapter title, a page number, a credit —
 * is text too, and dropping it would lose evidence that a later question might
 * legitimately need.
 */
async function assignTextBlocks(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  pageId: string,
  detected: DetectedPanel[],
  inserted: Array<{ id: string; index: number }>,
): Promise<void> {
  const blocks = await db
    .select({ id: textBlocks.id, bbox: textBlocks.bbox })
    .from(textBlocks)
    .where(eq(textBlocks.pageId, pageId))

  if (blocks.length === 0) return

  const idByIndex = new Map(inserted.map((panel) => [panel.index, panel.id]))

  for (const block of blocks) {
    // A block with no bounding box belongs to no panel, and cannot be made to:
    // that is a passage of a written summary, which has no geometry to compare.
    // Such blocks carry no page either, so this loop never sees one — the guard
    // is here because "never" is a claim about today's callers.
    const panelIndex = block.bbox === null ? null : assignToPanel(block.bbox, detected)
    await db
      .update(textBlocks)
      .set({ panelId: panelIndex === null ? null : (idByIndex.get(panelIndex) ?? null) })
      .where(eq(textBlocks.id, block.id))
  }
}

/**
 * How much of a chapter's text is attached to a panel.
 *
 * Reported by the text_detect step because it is the honest measure of whether
 * panel detection worked. A chapter where a third of the dialogue floats
 * outside every box is one where the boxes are wrong, and that is worth
 * surfacing before a model spends money describing them.
 */
export async function runTextDetect(
  userId: string,
  chapterId: string,
): Promise<{ blocks: number; assigned: number; unassigned: number }> {
  return withIngest(async (db) => {
    const all = await db
      .select({ id: textBlocks.id })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))

    const orphans = await db
      .select({ id: textBlocks.id })
      .from(textBlocks)
      .where(
        and(
          eq(textBlocks.chapterId, chapterId),
          eq(textBlocks.userId, userId),
          isNull(textBlocks.panelId),
        ),
      )

    return {
      blocks: all.length,
      assigned: all.length - orphans.length,
      unassigned: orphans.length,
    }
  })
}
