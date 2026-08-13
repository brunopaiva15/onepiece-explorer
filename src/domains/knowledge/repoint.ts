import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { reviewDecisions } from '@/db/schema/ingestion.ts'
import { assertions, auditLog, entities, evidence } from '@/db/schema/knowledge.ts'

/**
 * Send a relation to the entity it was always about.
 *
 * The failure this exists for looks like nothing at all. At chapter 41 Usopp is
 * told to get on board « as captain, which Luffy instantly states is his job »,
 * and the extraction wrote « Luffy dirige … » — correctly — at a group called
 * « Équipage du Capitaine Usopp », because Luffy's own crew is not a node and
 * never has been: the story does not name it for another fifty chapters, so
 * nothing ever proposed it. Every check the pipeline owns passed. The predicate
 * takes a group and the object is a group; the excerpt is anchored word for
 * word in the block it cites; the confidence was ordinary. The fiche then says
 * Luffy belongs to Usopp's crew, in the same typeface as everything true.
 *
 * That is the class of mistake this repository is built around — a wrong claim
 * that is indistinguishable from a right one — and until now there was no way
 * to answer it. The fiche can rename an entity and retype it. It cannot say
 * « this fact is about someone else », and the review queue is behind the
 * chapter's publication, so a relation noticed a week later had nowhere to go
 * but a chapter deletion, which throws away every correction made since.
 *
 * A repoint is deliberately not an UPDATE. Assertions are append-only (ADR
 * 0002) and the trigger enforces it: the old row keeps its evidence, its run,
 * its model and its date, and gains `superseded_by` pointing at the corrected
 * one. Two consequences worth stating, because both are the point:
 *
 *   - The record still holds what the machine proposed and why. « The graph
 *     once said this » stays answerable, which is what makes the correction
 *     auditable rather than an act of faith.
 *   - Nothing that reads knowledge sees the old row again. The row-level
 *     security policy admits `review_status = 'accepted'` only, so
 *     `superseded` disappears from the sheet, the graph, the search and the
 *     assistant in one write, with no second list to keep in step.
 *
 * The replacement is the user's word: `proposed_by = 'user'`, `locked`, and
 * `epistemic_status = 'user_validated'`. Locking is not decoration — the
 * append-only trigger refuses to let an AI proposal supersede a locked row, so
 * re-importing the chapter cannot quietly undo this. The decision is recorded
 * against the original proposal's fingerprint for the same reason, one layer
 * up: a re-import recognises the proposal it already asked about and does not
 * queue it again.
 */

export interface RepointInput {
  /** The assertion whose object is wrong. */
  assertionId: string
  /** The entity it should have pointed at. */
  objectEntityId: string
  /** Kept on the review decision, for whoever reads it in a year. */
  comment?: string
}

export interface RepointResult {
  /** The row that was superseded — still there, still citable. */
  previousAssertionId: string
  /** The correction. Equal to `previousAssertionId` when nothing was done. */
  assertionId: string
  predicate: string
  fromEntityId: string | null
  toEntityId: string
  evidenceCopied: number
  /** True when the assertion had already been superseded: a repeat run. */
  alreadyDone: boolean
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function repointAssertion(
  userId: string,
  input: RepointInput,
): Promise<RepointResult> {
  if (!UUID_RE.test(input.assertionId)) throw new Error('Assertion introuvable.')
  if (!UUID_RE.test(input.objectEntityId)) throw new Error('Entité cible introuvable.')

  return withIngest(async (db) => {
    /*
     * Read by id *and* by owner. `withIngest` runs as the ingestion role, which
     * bypasses row-level security, so every clause that scopes this to one
     * library is written out rather than assumed — the same rule retype.ts
     * follows next door.
     */
    const [old] = await db
      .select()
      .from(assertions)
      .where(and(eq(assertions.id, input.assertionId), eq(assertions.userId, userId)))
      .limit(1)

    if (!old) throw new Error('Assertion introuvable.')

    /*
     * Already corrected. Not an error: a repair script that runs twice, or a
     * second reader reaching the same conclusion, should find the work done and
     * say so rather than stack a second superseding row on the first.
     */
    if (old.superseded_by !== null || old.reviewStatus === 'superseded') {
      return {
        previousAssertionId: old.id,
        assertionId: old.superseded_by ?? old.id,
        predicate: old.predicate,
        fromEntityId: old.objectEntityId,
        toEntityId: old.objectEntityId ?? input.objectEntityId,
        evidenceCopied: 0,
        alreadyDone: true,
      }
    }

    if (old.objectEntityId === null) {
      throw new Error(
        'Cette assertion porte une valeur littérale, pas une entité : il n’y a ' +
          'pas d’objet à réorienter.',
      )
    }
    if (old.objectEntityId === input.objectEntityId) {
      throw new Error('Cette assertion pointe déjà vers cette entité.')
    }

    /*
     * The target, checked in the same library. A relation across two works
     * would be refused by nothing else here: the ontology trigger validates the
     * node *type* and has no opinion about which work the node belongs to.
     */
    const [target] = await db
      .select({ id: entities.id, workId: entities.workId })
      .from(entities)
      .where(and(eq(entities.id, input.objectEntityId), eq(entities.userId, userId)))
      .limit(1)

    if (!target) throw new Error('Entité cible introuvable.')
    if (target.workId !== old.workId) {
      throw new Error('L’entité cible appartient à une autre œuvre.')
    }

    /*
     * Everything about *when* is copied, not recomputed.
     *
     * `knowledge_from_chapter` is the chapter at which the reader could know
     * this, and correcting who the fact is about does not move it. Dating the
     * replacement to today would be the one edit that breaks the product's
     * promise: a past view would stop reproducing.
     */
    const [fresh] = await db
      .insert(assertions)
      .values({
        workId: old.workId,
        userId,
        subjectEntityId: old.subjectEntityId,
        predicate: old.predicate,
        objectEntityId: target.id,
        objectValue: old.objectValue,
        knowledgeFromChapter: old.knowledgeFromChapter,
        knowledgeUntilChapter: old.knowledgeUntilChapter,
        storyValidFrom: old.storyValidFrom,
        storyValidUntil: old.storyValidUntil,
        observedInChapter: old.observedInChapter,
        confidence: old.confidence,
        epistemicStatus: 'user_validated',
        reviewStatus: 'accepted',
        proposedBy: 'user',
        locked: true,
        pipelineVersion: old.pipelineVersion,
        promptVersion: old.promptVersion,
        runId: old.runId,
        proposalFingerprint: old.proposalFingerprint,
      })
      .returning({ id: assertions.id })

    if (!fresh) throw new Error('La correction n’a pas pu être écrite.')

    /*
     * The evidence, copied rather than moved.
     *
     * The passage that was read is the same passage; what was wrong is the
     * conclusion drawn from it. Moving the rows would leave the superseded
     * assertion uncheckable — a claim in the record with nothing behind it —
     * and the whole reason the old row survives is that it can still be read.
     */
    const cited = await db
      .select()
      .from(evidence)
      .where(and(eq(evidence.assertionId, old.id), eq(evidence.userId, userId)))

    if (cited.length > 0) {
      await db.insert(evidence).values(
        cited.map((row) => ({
          assertionId: fresh.id,
          userId,
          chapterId: row.chapterId,
          pageId: row.pageId,
          panelId: row.panelId,
          textBlockId: row.textBlockId,
          bbox: row.bbox,
          kind: row.kind,
          excerpt: row.excerpt,
        })),
      )
    }

    await db
      .update(assertions)
      .set({ reviewStatus: 'superseded', superseded_by: fresh.id })
      .where(and(eq(assertions.id, old.id), eq(assertions.userId, userId)))

    /*
     * And the same decision one layer up, so a re-import does not ask again.
     *
     * Keyed on the proposal's fingerprint, which the extraction step recomputes
     * from the subject, the predicate, the object and the evidence — identical
     * on the next pass over the same chapter. Without this row the corrected
     * relation would come back as a fresh proposal every time the chapter is
     * reprocessed. Assertions predating the fingerprint column simply skip it.
     */
    if (old.proposalFingerprint !== null) {
      await db
        .insert(reviewDecisions)
        .values({
          userId,
          workId: old.workId,
          proposalFingerprint: old.proposalFingerprint,
          decision: 'correct',
          correctedPayload: { objectEntityId: target.id },
          comment: input.comment ?? null,
        })
        .onConflictDoUpdate({
          target: [
            reviewDecisions.userId,
            reviewDecisions.workId,
            reviewDecisions.proposalFingerprint,
          ],
          set: {
            decision: 'correct',
            correctedPayload: { objectEntityId: target.id },
            comment: input.comment ?? null,
            decidedAt: new Date(),
          },
        })
    }

    await db.insert(auditLog).values({
      userId,
      action: 'assertion_repointed',
      subjectKind: 'assertion',
      subjectId: old.id,
      detail: {
        predicate: old.predicate,
        subjectEntityId: old.subjectEntityId,
        from: old.objectEntityId,
        to: target.id,
        replacedBy: fresh.id,
        comment: input.comment ?? null,
      },
    })

    return {
      previousAssertionId: old.id,
      assertionId: fresh.id,
      predicate: old.predicate,
      fromEntityId: old.objectEntityId,
      toEntityId: target.id,
      evidenceCopied: cited.length,
      alreadyDone: false,
    }
  })
}
