import 'server-only'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { assertions, evidence } from '@/db/schema/knowledge.ts'
import type { EvidenceRef } from '@/domains/ai/schemas.ts'
import { resolveRef, type RefTable } from './refs.ts'

/**
 * Re-attach evidence to a fact whose pages came back.
 *
 * Deleting a chapter leaves its assertions orphaned on purpose: the reader still
 * learned those facts, so removing them would rewrite their graph. But the
 * obvious next move — re-import a better scan of the same chapter — used to be a
 * trap. The recorded review decisions correctly suppress the proposals, so
 * nothing was published, so no new evidence was written, and the facts stayed
 * permanently uncheckable. Replacing a bad scan silently destroyed the one
 * property this product is built on.
 *
 * The fix does not need a new assertion. `assertions.proposal_fingerprint` is
 * the same value the extraction step computes, so a re-import can find the
 * existing row and give it evidence again. Inserting evidence does not touch the
 * assertion, so the append-only trigger is untroubled and no history is
 * rewritten — the fact was always true, and now it is checkable again.
 *
 * Only orphans are healed. An assertion that still has evidence is left alone:
 * adding a second copy of the same citation would inflate the source list on
 * every re-import.
 */

export interface ReanchorResult {
  healed: number
  /** Fingerprints that matched an accepted decision but no stored assertion. */
  unmatched: number
}

export async function reanchorOrphans(
  input: {
    userId: string
    chapterId: string
    refTable: RefTable
    /** Fingerprint → the evidence refs the fresh extraction produced for it. */
    proposals: Map<string, EvidenceRef[]>
  },
): Promise<ReanchorResult> {
  if (input.proposals.size === 0) return { healed: 0, unmatched: 0 }

  const fingerprints = [...input.proposals.keys()]

  return withIngest(async (db) => {
    const orphans = await db
      .select({
        id: assertions.id,
        fingerprint: assertions.proposalFingerprint,
      })
      .from(assertions)
      .leftJoin(evidence, eq(evidence.assertionId, assertions.id))
      .where(
        and(
          eq(assertions.userId, input.userId),
          eq(assertions.reviewStatus, 'accepted'),
          inArray(assertions.proposalFingerprint, fingerprints),
          // The orphan condition, derived rather than stored.
          isNull(evidence.id),
        ),
      )

    if (orphans.length === 0) {
      return { healed: 0, unmatched: fingerprints.length }
    }

    const rows: Array<typeof evidence.$inferInsert> = []

    for (const orphan of orphans) {
      if (!orphan.fingerprint) continue
      const refs = input.proposals.get(orphan.fingerprint)
      if (!refs) continue

      for (const ref of refs) {
        const resolved = resolveRef(input.refTable, ref.ref)
        // A ref that does not resolve against the *new* pages is skipped rather
        // than stored pointing at nothing — the whole reason the fact was
        // orphaned in the first place.
        if (!resolved) continue

        rows.push({
          assertionId: orphan.id,
          userId: input.userId,
          chapterId: input.chapterId,
          panelId: resolved.kind === 'panel' ? resolved.id : null,
          textBlockId: resolved.kind === 'block' ? resolved.id : null,
          kind: ref.kind === 'text' ? 'dialogue' : 'image',
          excerpt: ref.excerpt,
        })
      }
    }

    if (rows.length === 0) {
      return { healed: 0, unmatched: fingerprints.length - orphans.length }
    }

    await db.insert(evidence).values(rows)

    return {
      healed: new Set(rows.map((row) => row.assertionId)).size,
      unmatched: fingerprints.length - orphans.length,
    }
  })
}

/** How many of a reader's accepted facts currently have no evidence. */
export async function orphanCount(userId: string): Promise<number> {
  return withIngest(async (db) => {
    const [row] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count
      FROM assertions a
      WHERE a.user_id = ${userId}
        AND a.review_status = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.assertion_id = a.id)
    `)
    return Number(row?.count ?? 0)
  })
}
