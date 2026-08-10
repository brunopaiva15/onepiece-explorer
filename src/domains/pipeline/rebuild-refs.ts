import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { buildRefTable, type RefTable } from './refs.ts'

/**
 * Rebuild a run's ref table from the database.
 *
 * Refs are assigned deterministically — `p<page+1>c<panel+1>` over panels
 * ordered by index, `b<n>` over text blocks ordered by reading order — which
 * means the mapping can be reconstructed at any time from the same rows the
 * pipeline read. That is not a convenience: publication happens in a different
 * request from extraction, often a different session, so the in-memory table
 * built during the run is long gone by then.
 *
 * The alternative was storing refs alongside each proposal. It would work, and
 * it would also mean a proposal's citation could disagree with the current
 * panels after a page was re-cut — a stored ref pointing at a panel that no
 * longer exists, resolved against nothing, and evidence quietly recorded with a
 * null source. Recomputing means the citation is always checked against what is
 * actually there now.
 *
 * The database enforces this too: a trigger refuses an evidence row that carries
 * an excerpt without the block it came from. An unresolvable ref must therefore
 * fail loudly at publication rather than be stored as unsourced evidence —
 * which is the correct outcome, and the trigger is the reason it cannot be
 * quietly skipped.
 */
export async function rebuildRefTable(
  userId: string,
  chapterId: string,
): Promise<RefTable> {
  return withIngest(async (db) => {
    const pageRows = await db
      .select({ id: pages.id, index: pages.index })
      .from(pages)
      .where(and(eq(pages.chapterId, chapterId), eq(pages.userId, userId)))
      .orderBy(asc(pages.index))

    const panelRows = await db
      .select({ id: panels.id, pageId: panels.pageId, index: panels.index })
      .from(panels)
      .where(and(eq(panels.chapterId, chapterId), eq(panels.userId, userId)))
      .orderBy(asc(panels.index))

    const blockRows = await db
      .select({ id: textBlocks.id })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))
      .orderBy(asc(textBlocks.readingOrder))

    const pageIndexById = new Map(pageRows.map((page) => [page.id, page.index]))

    return buildRefTable({
      panels: panelRows.map((panel) => ({
        id: panel.id,
        pageIndex: pageIndexById.get(panel.pageId) ?? 0,
        index: panel.index,
      })),
      blocks: blockRows,
    })
  })
}
