import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { reviewDecisions, reviewItems } from '@/db/schema/ingestion.ts'
import { auditLog } from '@/db/schema/knowledge.ts'

/**
 * Take back a decision.
 *
 * Until this existed, a decision was final in the strongest sense: rejecting a
 * proposal set its item to `rejected` *and* recorded the verdict against its
 * fingerprint, and a re-import then skipped that proposal rather than asking
 * again — deliberately, because being asked the same question every re-import
 * is what makes a correction not survive. The consequence nobody wanted was
 * that a mistaken rejection had no way back at all, and it took the chapter's
 * relations with it: « le sujet e5 n'existe pas dans le graphe : son entité a
 * été rejetée ». The advice that followed — accept it first — described
 * something the interface could not do.
 *
 * So the recorded verdict is deleted along with the reopening. Setting the item
 * back to `proposed` without that would put the question in front of the
 * reviewer and have the next re-import silently answer it again with the answer
 * they just withdrew.
 *
 * Only a decision may be taken back. An item already published is a row in the
 * graph, and unpublishing is a different operation with different consequences
 * — that one is chapter deletion, which exists and says what it destroys.
 */
export interface ReopenResult {
  reopened: number
}

export async function reopenItems(
  userId: string,
  runId: string,
  itemIds: string[],
): Promise<ReopenResult> {
  if (itemIds.length === 0) return { reopened: 0 }

  return withIngest(async (db) => {
    const targets = await db
      .select({
        id: reviewItems.id,
        fingerprint: reviewItems.proposalFingerprint,
        status: reviewItems.status,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          inArray(reviewItems.id, itemIds),
          inArray(reviewItems.status, ['rejected', 'deferred']),
        ),
      )

    if (targets.length === 0) return { reopened: 0 }

    const ids = targets.map((row) => row.id)
    const fingerprints = targets
      .map((row) => row.fingerprint)
      .filter((value): value is string => value !== null)

    await db
      .update(reviewItems)
      .set({ status: 'proposed' })
      .where(and(eq(reviewItems.userId, userId), inArray(reviewItems.id, ids)))

    if (fingerprints.length > 0) {
      await db
        .delete(reviewDecisions)
        .where(
          and(
            eq(reviewDecisions.userId, userId),
            inArray(reviewDecisions.proposalFingerprint, fingerprints),
          ),
        )
    }

    await db.insert(auditLog).values({
      userId,
      action: 'review_reopened',
      subjectKind: 'ingestion_run',
      subjectId: runId,
      detail: { itemIds: ids, count: ids.length },
    })

    return { reopened: ids.length }
  })
}
