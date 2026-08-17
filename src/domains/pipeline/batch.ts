import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'

/**
 * Where a batch import has got to, in one query per question.
 *
 * The queue advances on a publication, and a chapter imported with
 * `auto_review` publishes itself when it has nothing left to ask. That is the
 * whole chain — and a chain that only ever moves on an event is unreadable the
 * moment it stops, because "stopped" and "between two chapters" look identical
 * from outside.
 *
 * So this says which of the four states it is in, and each one has a different
 * answer attached:
 *
 *   Running. A chapter is being processed. Nothing to do but wait, and the
 *   answer is "wait" rather than "start the next one" — starting it now would
 *   make the second chapter blind to the first, which is the one thing the
 *   queue exists to prevent.
 *
 *   Stalled. A run has been `running` with nothing moving for longer than any
 *   step takes. The pipeline runs inside the invocation that started it, so the
 *   platform's duration ceiling can take a run down mid-call with no chance to
 *   record a failure; nothing can detect that from inside, because the process
 *   that would have written the failure is the one that died. Said out loud,
 *   with the chapter named, rather than shown as a queue that never moves.
 *
 *   Blocked. A chapter of the batch is neither published, nor queued, nor
 *   running: it asked something. Either its run left proposals a person has to
 *   answer — a name, an identity, a contradiction — or the run failed. Both
 *   need a human, and they need different pages, so the reason is carried.
 *
 *   Ready. Nothing is running and nothing is blocked, so the next queued
 *   chapter can start.
 *
 * Scoped to chapters carrying `auto_review`, deliberately. A chapter imported
 * months ago and never reviewed is not this batch's business: counting it as
 * "blocked" would freeze every future automatic import behind a decision nobody
 * intends to make.
 */

/** How long a run may show no progress before it is called interrupted. */
const STALL_AFTER_MS = 6 * 60 * 1_000

export interface BatchStatus {
  /** Chapters still waiting their turn, whatever the reason. */
  queued: number
  /** True when at least one waiting chapter publishes itself. */
  automatic: boolean
  /** The chapter being processed right now, if any. */
  running: {
    runId: string
    chapterId: string
    chapterNumber: number
    /** No step has moved for longer than any step takes. */
    stalled: boolean
  } | null
  /**
   * The chapter the chain is waiting on, and what it wants.
   *
   * `review` — proposals nobody has answered. `failed` — the run did not
   * finish. `unprocessed` covers the rest: a chapter of the batch that never
   * got a run at all, which is what an abandoned queue leaves behind.
   */
  blocked: {
    chapterId: string
    chapterNumber: number
    runId: string | null
    reason: 'review' | 'failed' | 'unprocessed'
  } | null
}

export async function batchStatus(userId: string): Promise<BatchStatus> {
  return withIngest(async (db) => {
    const [counts] = await db.execute<{ queued: number; automatic: number }>(sql`
      SELECT count(*)::int AS queued,
             count(*) FILTER (WHERE auto_review)::int AS automatic
        FROM chapters
       WHERE user_id = ${userId} AND queued_for_run
    `)

    /*
     * The run in flight, with the last moment anything about it moved.
     *
     * Server truth rather than client bookkeeping: the run's start plus every
     * step that has recorded a duration. A slow extraction writes nothing until
     * it returns, so "started three minutes ago and no step has finished" is
     * normal — which is why the threshold is minutes and not seconds.
     */
    const [active] = await db.execute<{
      run_id: string
      chapter_id: string
      number: number
      idle_ms: number
    }>(sql`
      SELECT r.id AS run_id,
             r.chapter_id,
             c.number,
             EXTRACT(EPOCH FROM (
               now() - GREATEST(
                 coalesce(r.started_at, r.created_at),
                 coalesce((SELECT max(coalesce(s.finished_at, s.started_at))
                             FROM ingestion_steps s
                            WHERE s.run_id = r.id),
                          coalesce(r.started_at, r.created_at))
               )
             )) * 1000 AS idle_ms
        FROM ingestion_runs r
        JOIN chapters c ON c.id = r.chapter_id
       WHERE r.user_id = ${userId}
         AND r.status IN ('pending', 'running')
       ORDER BY r.created_at DESC
       LIMIT 1
    `)

    /*
     * The lowest-numbered chapter of the batch that is stuck.
     *
     * Lowest rather than latest: the queue is walked in order, so the chapter
     * that holds everything up is the earliest one that has not opened. A later
     * one blocked as well is the same answer, arrived at afterwards.
     */
    const [stuck] = await db.execute<{
      chapter_id: string
      number: number
      run_id: string | null
      pending_items: number
      failed_run: string | null
    }>(sql`
      SELECT c.id AS chapter_id,
             c.number,
             (SELECT r.id FROM ingestion_runs r
               WHERE r.chapter_id = c.id AND r.user_id = ${userId}
               ORDER BY r.created_at DESC LIMIT 1) AS run_id,
             (SELECT count(*)::int FROM review_items i
               WHERE i.chapter_id = c.id AND i.user_id = ${userId}
                 AND i.status = 'proposed') AS pending_items,
             (SELECT r.id FROM ingestion_runs r
               WHERE r.chapter_id = c.id AND r.user_id = ${userId}
                 AND r.status IN ('failed', 'cancelled')
               ORDER BY r.created_at DESC LIMIT 1) AS failed_run
        FROM chapters c
       WHERE c.user_id = ${userId}
         AND c.auto_review
         AND c.status <> 'published'
         AND NOT c.queued_for_run
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_runs r
            WHERE r.chapter_id = c.id
              AND r.user_id = ${userId}
              AND r.status IN ('pending', 'running')
         )
       ORDER BY c.number
       LIMIT 1
    `)

    const idleMs = active ? Number(active.idle_ms) : 0

    return {
      queued: Number(counts?.queued ?? 0),
      automatic: Number(counts?.automatic ?? 0) > 0,
      running: active
        ? {
            runId: String(active.run_id),
            chapterId: String(active.chapter_id),
            chapterNumber: Number(active.number),
            stalled: idleMs > STALL_AFTER_MS,
          }
        : null,
      blocked: stuck
        ? {
            chapterId: String(stuck.chapter_id),
            chapterNumber: Number(stuck.number),
            runId: stuck.run_id === null ? null : String(stuck.run_id),
            reason:
              Number(stuck.pending_items) > 0
                ? 'review'
                : stuck.failed_run !== null
                  ? 'failed'
                  : 'unprocessed',
          }
        : null,
    }
  })
}
