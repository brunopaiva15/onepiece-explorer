import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { startChapterRun } from './start.ts'

/**
 * Chapters imported together, processed one at a time.
 *
 * The whole reason this module exists is one line in `steps/resolve.ts`:
 * `blockByTrigram` only ever compares a proposed entity against entities
 * **already in the graph** at that chapter, and the only thing that puts an
 * entity in the graph is a human publishing it. So the order is not a
 * preference, it is the condition under which resolution works at all.
 *
 * Run chapters 12 to 21 together and each of them sees the graph as it was
 * before the batch: the character introduced in 12 is unknown to 13, unknown to
 * 14, and proposed from scratch every time.
 *
 * The obvious consequence is not the real one. Publication already joins an
 * accepted entity of the same type carrying exactly the same normalised name
 * (`exactTwin` in `review/publish.ts`), so a character re-proposed under an
 * identical name still lands on a single node — that mitigation was written
 * because importing far ahead of review is the normal way to use this.
 *
 * What no later step recovers is everything weaker than an exact name. « L'homme
 * au tablier de cuir » and « Kaelo Renn » are the same person and share no
 * characters; the only thing that can raise that question is `runResolve`, only
 * against entities already in the graph, and it is asked once. A blind batch
 * therefore produces two entities and no `maybe_same_as` to decide — and says
 * nothing, which is what makes it worse than a visible failure. Aliases,
 * spelling variants and translated forms are exactly the identity cases this
 * product is careful about.
 *
 * Processing in order costs nothing but wall-clock, and wall-clock was never the
 * scarce thing here: the reviewer is. By the time you have finished reviewing
 * chapter 12, chapter 13 has long since run.
 */

export interface QueuedChapter {
  id: string
  number: number
  title: string | null
}

/**
 * Put chapters in the queue.
 *
 * Takes ids rather than numbers: the caller has just imported them and holds
 * the ids, and a number is only unique within a work.
 */
export async function queueForRun(userId: string, chapterIds: string[]): Promise<number> {
  if (chapterIds.length === 0) return 0

  return withIngest(async (db) => {
    const updated = await db
      .update(chapters)
      .set({ queuedForRun: true, updatedAt: new Date() })
      .where(and(eq(chapters.userId, userId), inArray(chapters.id, chapterIds)))
      .returning({ id: chapters.id })
    return updated.length
  })
}

/** What is still waiting, in the order it will be processed. */
export async function queuedChapters(userId: string): Promise<QueuedChapter[]> {
  return withIngest(async (db) =>
    db
      .select({ id: chapters.id, number: chapters.number, title: chapters.title })
      .from(chapters)
      .where(and(eq(chapters.userId, userId), eq(chapters.queuedForRun, true)))
      .orderBy(asc(chapters.number)),
  )
}

/** Abandon the queue without deleting anything. The texts stay imported. */
export async function clearQueue(userId: string): Promise<number> {
  return withIngest(async (db) => {
    const cleared = await db
      .update(chapters)
      .set({ queuedForRun: false, updatedAt: new Date() })
      .where(and(eq(chapters.userId, userId), eq(chapters.queuedForRun, true)))
      .returning({ id: chapters.id })
    return cleared.length
  })
}

export interface QueueAdvance {
  /** The chapter whose run was started, when one was. */
  started: { chapterId: string; number: number; runId: string } | null
  /** Set when a chapter was claimed and its run refused to start. */
  error: string | null
}

/**
 * Start the next queued chapter, if there is one.
 *
 * Called after a publication opened a chapter, which is the moment the graph
 * gained the entities the next chapter will be matched against.
 *
 * The claim is a conditional update returning the row, so two publications
 * landing together cannot both take the same chapter — whichever `UPDATE`
 * commits second matches no row, because the flag it filters on is already
 * false. Doing this as a read then a write would leave exactly the window that
 * starts one chapter's run twice, at full price.
 *
 * A run that refuses to start puts the chapter back in the queue rather than
 * dropping it. The realistic refusal is the hourly run limit, which is a
 * "later", not a "never": leaving the chapter claimed would silently end the
 * queue at whatever chapter happened to hit the ceiling.
 */
export async function advanceQueue(userId: string): Promise<QueueAdvance> {
  const claimed = await withIngest(async (db) => {
    const [row] = await db
      .update(chapters)
      .set({ queuedForRun: false, updatedAt: new Date() })
      .where(
        and(
          eq(chapters.userId, userId),
          eq(chapters.queuedForRun, true),
          sql`${chapters.number} = (
            SELECT MIN(c.number) FROM chapters c
            WHERE c.user_id = ${userId} AND c.queued_for_run
          )`,
        ),
      )
      .returning({ id: chapters.id, number: chapters.number })
    return row ?? null
  })

  if (!claimed) return { started: null, error: null }

  const started = await startChapterRun({
    userId,
    chapterId: claimed.id,
    provider: 'auto',
  })

  if (!started.ok || !started.runId) {
    await withIngest(async (db) => {
      await db
        .update(chapters)
        .set({ queuedForRun: true, updatedAt: new Date() })
        .where(and(eq(chapters.id, claimed.id), eq(chapters.userId, userId)))
    })
    return { started: null, error: started.error ?? 'Traitement non démarré.' }
  }

  return {
    started: { chapterId: claimed.id, number: claimed.number, runId: started.runId },
    error: null,
  }
}
