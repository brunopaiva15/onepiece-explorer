import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { quarantine } from '@/db/schema/ingestion.ts'
import type { StepContext } from './steps/context.ts'

/**
 * Where a proposal goes when it cannot be traced back to the pages.
 *
 * Quarantine is not a rubbish bin, and treating it as one would waste the most
 * useful diagnostic the pipeline produces. Every row carries the reason and an
 * explanation written to be read: a chapter whose quarantine fills with
 * `unknown_ref` is a chapter where panel detection produced boxes the model
 * could not match, and one full of `excerpt_not_in_source` is one where the OCR
 * is too poor for anything to anchor. Both are actionable; neither is visible if
 * the rejections are simply dropped.
 *
 * What quarantine must never be is a queue a human can approve from. The whole
 * point is that these items failed the mechanical check — putting them in front
 * of someone at the end of a long review session, with a plausible label and a
 * real-looking citation, is exactly how a fabricated fact gets into the graph.
 * So they are recorded, counted, and shown as diagnostics only.
 */

export interface QuarantineItem {
  reason: string
  detail: string
  payload: unknown
}

export async function quarantineItems(
  context: StepContext,
  items: QuarantineItem[],
): Promise<number> {
  if (items.length === 0) return 0

  return withIngest(async (db) => {
    await db.insert(quarantine).values(
      items.map((item) => ({
        runId: context.runId,
        chapterId: context.chapterId,
        userId: context.userId,
        reason: item.reason,
        detail: item.detail,
        // The rejected proposal is stored whole. Without it, "37 items
        // quarantined for unknown_ref" tells you a number and nothing you can
        // act on.
        payload: item.payload as object,
      })),
    )
    return items.length
  })
}

/**
 * Quarantine counts by reason, for the run view.
 *
 * Grouped rather than listed because the shape of the distribution is the
 * diagnostic: thirty of one reason points at a systematic problem, one each of
 * thirty points at a model having an ordinary bad day.
 */
export async function quarantineSummary(
  userId: string,
  runId: string,
): Promise<Array<{ reason: string; count: number }>> {
  return withIngest(async (db) => {
    // Raw SQL: a group-by with a count reads better this way than assembled
    // through the query builder.
    const rows = await db.execute<{ reason: string; count: number }>(sql`
      SELECT reason, count(*)::int AS count
      FROM quarantine
      WHERE run_id = ${runId} AND user_id = ${userId}
      GROUP BY reason
      ORDER BY count DESC
    `)
    return rows.map((row) => ({ reason: row.reason, count: Number(row.count) }))
  })
}
