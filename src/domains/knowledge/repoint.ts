import 'server-only'
import { reviseAssertion } from './revise.ts'

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
 *
 * The mechanism above now lives in `revise.ts`, which does the same thing to a
 * predicate and to a literal value — the fiche needed all three the day it grew
 * a « corriger » button. This is the object case, kept under its own name
 * because a repair script reads for it and because « repoint » is the word the
 * scripts, the tests and the audit log have used since the Usopp bug.
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

export async function repointAssertion(
  userId: string,
  input: RepointInput,
): Promise<RepointResult> {
  const result = await reviseAssertion(userId, {
    assertionId: input.assertionId,
    objectEntityId: input.objectEntityId,
    comment: input.comment,
  })

  return {
    previousAssertionId: result.previousAssertionId,
    assertionId: result.assertionId,
    predicate: result.predicate,
    fromEntityId: result.fromEntityId,
    // A repoint always names its target, including on the repeat run where
    // nothing was written: a caller looping over a list of repairs reads this
    // to know where the relation ended up, not what this call did.
    toEntityId: result.toEntityId ?? input.objectEntityId,
    evidenceCopied: result.evidenceCopied,
    alreadyDone: result.alreadyDone,
  }
}
