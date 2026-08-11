import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { withDestructive, withIngest } from '@/db/boundary.ts'
import { chapters, pages } from '@/db/schema/documents.ts'
import { assertions, auditLog, evidence } from '@/db/schema/knowledge.ts'
import { storage } from '../storage/index.ts'

/**
 * Delete a chapter, and be honest about what that does to the graph.
 *
 * Deletion is the one operation that cannot be append-only, and the retention
 * promise in the README is not kept unless it genuinely works. So this removes
 * the pages, the derivatives in storage, and the rows that cascade from them.
 *
 * What it deliberately does *not* do is delete the knowledge.
 *
 * An assertion published from chapter 40 is something the reader learned. If
 * they delete chapter 40's files — to save space, or because they replaced a
 * bad scan — the fact does not become untrue, and removing it would rewrite
 * their own graph behind their back. So the assertion survives, and becomes
 * *orphaned*: it has no evidence left to point at.
 *
 * That state is derived, not stored. An assertion is orphaned exactly when no
 * evidence row remains for it, and evidence cascades with the chapter — so the
 * flag cannot drift from the truth, needs no column, and needs no exception to
 * the append-only trigger. A stored boolean would have been one more thing to
 * keep in step with reality, and the first re-import would have desynchronised
 * it.
 *
 * The reader keeps their graph and can see exactly which facts stopped being
 * checkable. Re-importing the chapter restores the evidence and the mark
 * disappears on its own.
 */

export interface DeletionPreview {
  chapterId: string
  chapterNumber: number
  pageCount: number
  panelCount: number
  textBlockCount: number
  /** Assertions revealed by this chapter, which will survive as orphans. */
  assertionsRevealed: number
  /** Entities first seen here, which would lose their introduction. */
  entitiesIntroduced: number
  /** Evidence rows that will lose their anchor. */
  evidenceAffected: number
  storageKeys: number
}

/**
 * What would happen, before it happens.
 *
 * A destructive action on someone's own library needs the consequences stated
 * in advance, in counts they can recognise. "Delete chapter 40?" is not enough
 * information to answer when the answer involves eleven assertions becoming
 * uncheckable.
 */
export async function previewDeletion(
  userId: string,
  chapterId: string,
): Promise<DeletionPreview | null> {
  return withIngest(async (db) => {
    const [chapter] = await db
      .select({ id: chapters.id, number: chapters.number })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)

    if (!chapter) return null

    const counts = await db.execute<{
      pages: number
      panels: number
      blocks: number
      keys: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM pages WHERE chapter_id = ${chapterId})       AS pages,
        (SELECT count(*)::int FROM panels WHERE chapter_id = ${chapterId})      AS panels,
        (SELECT count(*)::int FROM text_blocks WHERE chapter_id = ${chapterId}) AS blocks,
        (SELECT count(*)::int FROM pages WHERE chapter_id = ${chapterId})       AS keys
    `)

    const knowledge = await db.execute<{
      revealed: number
      introduced: number
      evidence: number
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM assertions
           WHERE user_id = ${userId} AND knowledge_from_chapter = ${chapter.number}
             AND review_status = 'accepted')                                   AS revealed,
        (SELECT count(*)::int FROM entities
           WHERE user_id = ${userId} AND first_seen_chapter = ${chapter.number}
             AND review_status = 'accepted')                                   AS introduced,
        (SELECT count(*)::int FROM evidence WHERE chapter_id = ${chapterId})   AS evidence
    `)

    const row = counts[0]
    const know = knowledge[0]

    return {
      chapterId,
      chapterNumber: chapter.number,
      pageCount: Number(row?.pages ?? 0),
      panelCount: Number(row?.panels ?? 0),
      textBlockCount: Number(row?.blocks ?? 0),
      assertionsRevealed: Number(know?.revealed ?? 0),
      entitiesIntroduced: Number(know?.introduced ?? 0),
      evidenceAffected: Number(know?.evidence ?? 0),
      // Three objects per page — original, display, thumb — plus the source file.
      storageKeys: Number(row?.keys ?? 0) * 3 + 1,
    }
  })
}

export interface DeletionResult {
  chapterNumber: number
  pagesDeleted: number
  objectsDeleted: number
  assertionsOrphaned: number
  /** Assertions whose evidence was already elsewhere and stay fully sourced. */
  assertionsStillSourced: number
}

export async function deleteChapter(
  userId: string,
  chapterId: string,
  options: { keepKnowledge?: boolean } = {},
): Promise<DeletionResult> {
  const keepKnowledge = options.keepKnowledge !== false

  const store = storage()

  // Gather the keys before the rows go: after the cascade there is nothing left
  // to tell us what to remove from the bucket, and orphaned objects would then
  // sit there indefinitely with no record that they exist.
  const { chapterNumber, keys, sourceKeys } = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ number: chapters.number })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const pageRows = await db
      .select({
        original: pages.storageKeyOriginal,
        display: pages.storageKeyDisplay,
        thumb: pages.storageKeyThumb,
      })
      .from(pages)
      .where(eq(pages.chapterId, chapterId))

    const documentRows = await db.execute<{ storage_key: string }>(sql`
      SELECT storage_key FROM documents WHERE chapter_id = ${chapterId}
    `)

    return {
      chapterNumber: chapter.number,
      keys: pageRows.flatMap((row) =>
        [row.original, row.display, row.thumb].filter(
          (key): key is string => key !== null,
        ),
      ),
      sourceKeys: documentRows.map((row) => String(row.storage_key)),
    }
  })

  const result = await withDestructive(
    `Suppression du chapitre ${chapterNumber} demandée par l'utilisateur`,
    async (db) => {
      let orphaned = 0
      let stillSourced = 0

      if (keepKnowledge) {
        /*
         * Count what is about to lose its last source, before the cascade.
         *
         * An assertion is orphaned only when *every* piece of its evidence
         * pointed at this chapter. One that also cites another chapter stays
         * checkable and must not be counted — telling a reader a verifiable
         * fact is unverifiable erodes exactly the trust the mark exists to
         * protect.
         *
         * Nothing is written: the state is derived from the absence of evidence,
         * which the cascade is about to produce. These numbers are for the
         * report and the audit entry.
         */
        const affected = await db.execute<{ id: string; remaining: number }>(sql`
          SELECT a.id,
                 count(ev.id) FILTER (WHERE ev.chapter_id <> ${chapterId})::int AS remaining
          FROM assertions a
          JOIN evidence ev ON ev.assertion_id = a.id
          WHERE a.user_id = ${userId}
            AND EXISTS (
              SELECT 1 FROM evidence e2
              WHERE e2.assertion_id = a.id AND e2.chapter_id = ${chapterId}
            )
          GROUP BY a.id
        `)

        orphaned = affected.filter((row) => Number(row.remaining) === 0).length
        stillSourced = affected.length - orphaned
      } else {
        const deleted = await db.execute<{ count: number }>(sql`
          WITH removed AS (
            DELETE FROM assertions
            WHERE user_id = ${userId} AND knowledge_from_chapter = ${chapterNumber}
            RETURNING 1
          )
          SELECT count(*)::int AS count FROM removed
        `)
        orphaned = Number(deleted[0]?.count ?? 0)
      }

      // Pages, panels, text blocks, documents and evidence all cascade from the
      // chapter row.
      await db.delete(chapters).where(eq(chapters.id, chapterId))

      await db.insert(auditLog).values({
        userId,
        action: keepKnowledge ? 'delete_chapter' : 'delete_chapter_and_knowledge',
        subjectKind: 'chapter',
        subjectId: chapterId,
        detail: { chapterNumber, orphaned, stillSourced, objects: keys.length },
      })

      return { orphaned, stillSourced }
    },
  )

  /*
   * Storage last, and outside the transaction.
   *
   * A failed object delete must not roll back the database — the rows are gone
   * and re-running would find nothing to delete, leaving the objects orphaned
   * forever. Deleting after means the worst case is a few unreferenced objects,
   * which is recoverable, rather than a chapter that cannot be removed.
   */
  let objectsDeleted = 0
  for (const batch of chunk([...keys, ...sourceKeys], 50)) {
    try {
      await store.remove(batch)
      objectsDeleted += batch.length
    } catch (error) {
      console.error(
        `[suppression] ${batch.length} objet(s) non supprimé(s) du stockage :`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return {
    chapterNumber,
    pagesDeleted: keys.length / 3,
    objectsDeleted,
    assertionsOrphaned: result.orphaned,
    assertionsStillSourced: result.stillSourced,
  }
}

/**
 * Assertions that can no longer be checked.
 *
 * Derived: accepted, and with no evidence row left. Surfaced rather than
 * hidden — a reader who deleted a chapter should see exactly what it cost, and
 * re-importing restores the evidence, at which point these stop being returned
 * without anything having to be un-marked.
 */
export async function listOrphanedAssertions(
  userId: string,
): Promise<Array<{ id: string; predicate: string; chapter: number }>> {
  return withIngest(async (db) => {
    const rows = await db
      .select({
        id: assertions.id,
        predicate: assertions.predicate,
        chapter: assertions.knowledgeFromChapter,
      })
      .from(assertions)
      .leftJoin(evidence, eq(evidence.assertionId, assertions.id))
      .where(
        and(
          eq(assertions.userId, userId),
          eq(assertions.reviewStatus, 'accepted'),
          isNull(evidence.id),
        ),
      )
      .orderBy(assertions.knowledgeFromChapter)
    return rows
  })
}

/** Entities left with no visible relations after a deletion. */
export async function countIsolatedEntities(userId: string): Promise<number> {
  return withIngest(async (db) => {
    const [row] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM entities e
      WHERE e.user_id = ${userId}
        AND e.review_status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM assertions a
          WHERE a.review_status = 'accepted'
            AND (a.subject_entity_id = e.id OR a.object_entity_id = e.id)
        )
    `)
    return Number(row?.count ?? 0)
  })
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}
