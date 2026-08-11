import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'

/**
 * What the pipeline has actually cost.
 *
 * Read from `ingestion_steps`, which records the real usage the provider
 * reported, next to the estimate made before each run. Keeping both is the
 * point: an estimator nobody compares to the outcome is decoration, and the
 * only way to find out that a model got more expensive, or that a prompt got
 * longer, is to look at the two side by side.
 *
 * Everything here is ownership-scoped rather than boundary-filtered. What a run
 * cost is a fact about processing, not about the story — knowing chapter 40 cost
 * eleven cents reveals nothing about chapter 40.
 */

export interface CostByStep {
  stepKey: string
  runs: number
  totalCents: number
  averageCents: number
  tokensIn: number
  tokensOut: number
  /** Cache reads are a tenth of the input rate; this is what caching saved. */
  cacheReadTokens: number
  cacheWriteTokens: number
  modelId: string | null
}

export interface CostByChapter {
  chapterNumber: number
  chapterId: string
  runs: number
  totalCents: number
  estimatedCents: number | null
}

export interface CostSummary {
  totalCents: number
  chaptersProcessed: number
  /** Cents per chapter, which is the number worth watching over time. */
  averagePerChapterCents: number
  byStep: CostByStep[]
  byChapter: CostByChapter[]
  /**
   * Estimate against reality, as a ratio. Above 1 means the estimator was
   * optimistic. Null until at least one run recorded both.
   */
  estimateAccuracy: number | null
  /** Tokens served from cache, as a fraction of all input tokens. */
  cacheHitRate: number | null
}

export async function costSummary(userId: string): Promise<CostSummary> {
  return withIngest(async (db) => {
    const steps = await db.execute<{
      step_key: string
      runs: number
      total: number
      tokens_in: number
      tokens_out: number
      cache_read: number
      cache_write: number
      model_id: string | null
    }>(sql`
      SELECT
        s.step_key,
        count(DISTINCT s.run_id)::int          AS runs,
        coalesce(sum(s.cost_cents), 0)::int    AS total,
        coalesce(sum(s.tokens_in), 0)::bigint  AS tokens_in,
        coalesce(sum(s.tokens_out), 0)::bigint AS tokens_out,
        coalesce(sum(s.cache_read_tokens), 0)::bigint  AS cache_read,
        coalesce(sum(s.cache_write_tokens), 0)::bigint AS cache_write,
        max(s.model_id)                        AS model_id
      FROM ingestion_steps s
      WHERE s.user_id = ${userId}
      GROUP BY s.step_key
      ORDER BY total DESC, s.step_key
    `)

    const chapters = await db.execute<{
      chapter_number: number
      chapter_id: string
      runs: number
      total: number
      estimated: number | null
    }>(sql`
      SELECT
        c.number                                      AS chapter_number,
        c.id                                          AS chapter_id,
        count(*)::int                                 AS runs,
        coalesce(sum(r.total_cost_cents), 0)::int     AS total,
        avg(r.estimated_cost_cents)::int              AS estimated
      FROM ingestion_runs r
      JOIN chapters c ON c.id = r.chapter_id
      WHERE r.user_id = ${userId}
      GROUP BY c.number, c.id
      ORDER BY c.number
    `)

    const byStep: CostByStep[] = steps.map((row) => ({
      stepKey: String(row.step_key),
      runs: Number(row.runs),
      totalCents: Number(row.total),
      averageCents: Number(row.runs) === 0 ? 0 : Number(row.total) / Number(row.runs),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      cacheReadTokens: Number(row.cache_read),
      cacheWriteTokens: Number(row.cache_write),
      modelId: row.model_id === null ? null : String(row.model_id),
    }))

    const byChapter: CostByChapter[] = chapters.map((row) => ({
      chapterNumber: Number(row.chapter_number),
      chapterId: String(row.chapter_id),
      runs: Number(row.runs),
      totalCents: Number(row.total),
      estimatedCents: row.estimated === null ? null : Number(row.estimated),
    }))

    const totalCents = byChapter.reduce((sum, row) => sum + row.totalCents, 0)

    /*
     * Only chapters where both numbers exist. Averaging over runs that never
     * recorded an estimate would silently pull the ratio towards 1 and make a
     * broken estimator look accurate.
     */
    const comparable = byChapter.filter(
      (row) => row.estimatedCents !== null && row.estimatedCents > 0 && row.totalCents > 0,
    )
    const estimateAccuracy =
      comparable.length === 0
        ? null
        : comparable.reduce((sum, row) => sum + row.totalCents / row.estimatedCents!, 0) /
          comparable.length

    const inputTokens = byStep.reduce((sum, row) => sum + row.tokensIn, 0)
    const cacheReads = byStep.reduce((sum, row) => sum + row.cacheReadTokens, 0)
    const cacheHitRate =
      inputTokens + cacheReads === 0 ? null : cacheReads / (inputTokens + cacheReads)

    return {
      totalCents,
      chaptersProcessed: byChapter.length,
      averagePerChapterCents:
        byChapter.length === 0 ? 0 : totalCents / byChapter.length,
      byStep,
      byChapter,
      estimateAccuracy,
      cacheHitRate,
    }
  })
}

/**
 * Quarantine, grouped, across every run.
 *
 * The distribution is the diagnostic. Thirty rejections all of one reason points
 * at something systematic — panel detection producing boxes the model cannot
 * match, or OCR too poor for anything to anchor. One each of thirty is a model
 * having an ordinary bad day, and needs no action.
 */
export async function quarantineHealth(
  userId: string,
): Promise<Array<{ reason: string; count: number; lastSeen: Date }>> {
  return withIngest(async (db) => {
    const rows = await db.execute<{
      reason: string
      count: number
      last_seen: Date
    }>(sql`
      SELECT reason, count(*)::int AS count, max(created_at) AS last_seen
      FROM quarantine
      WHERE user_id = ${userId}
      GROUP BY reason
      ORDER BY count DESC
    `)
    return rows.map((row) => ({
      reason: String(row.reason),
      count: Number(row.count),
      lastSeen: new Date(row.last_seen),
    }))
  })
}

/** Step failures, so a recurring one is visible rather than buried per run. */
export async function failureHealth(
  userId: string,
): Promise<Array<{ stepKey: string; attempts: number; lastError: string }>> {
  return withIngest(async (db) => {
    const rows = await db.execute<{
      step_key: string
      attempts: number
      last_error: string
    }>(sql`
      SELECT step_key, count(*)::int AS attempts,
             (array_agg(error ORDER BY created_at DESC))[1] AS last_error
      FROM ingestion_steps
      WHERE user_id = ${userId} AND status = 'failed' AND error IS NOT NULL
      GROUP BY step_key
      ORDER BY attempts DESC
    `)
    return rows.map((row) => ({
      stepKey: String(row.step_key),
      attempts: Number(row.attempts),
      lastError: String(row.last_error),
    }))
  })
}
