import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { reviewDecisions } from '@/db/schema/ingestion.ts'
import {
  assertions,
  auditLog,
  entities,
  evidence,
  predicates,
} from '@/db/schema/knowledge.ts'

/**
 * Correct a fact the fiche is showing, or take it back.
 *
 * « Baggy appartient à l'Équipage du Roux », at chapter 19, on the evidence of
 * « He has a flashback about their time as fellow pirates. » The two of them
 * were cabin boys on Roger's ship; Shanks' own crew does not exist yet and
 * Baggy is never in it. Every check the pipeline owns passed — the predicate
 * takes a group, the object is a group, the excerpt is anchored word for word —
 * and the fiche prints the claim in the same typeface as everything true.
 *
 * Until now the fiche could rename an entity and retype it, and had nothing at
 * all to say about a fact. `repoint.ts` could send a relation to another entity,
 * but only from a repair script: no page ever offered it, and a wrong fact
 * noticed while reading had one remedy, deleting the chapter, which throws away
 * every correction made since.
 *
 * Two gestures, because a wrong fact is wrong in one of two ways:
 *
 *   `reviseAssertion` — it is about the wrong thing, or says the wrong thing.
 *   The object moves to another entity, the predicate changes to one that fits,
 *   or a literal value is rewritten. Anything the reader can see on the line.
 *
 *   `retractAssertion` — it is not a fact at all. Nothing replaces it.
 *
 * Neither is an UPDATE of what was claimed. Assertions are append-only (ADR
 * 0002) and the trigger enforces it: a revision inserts the corrected row and
 * points the old one's `superseded_by` at it; a retraction moves `review_status`
 * to `rejected`, which is one of the two columns that may change after
 * insertion. Both consequences are the point:
 *
 *   - The record still holds what the machine proposed and why, with its
 *     evidence, its run and its model. « The graph once said this » stays
 *     answerable, which is what makes a correction auditable rather than an act
 *     of faith.
 *   - Nothing that reads knowledge sees the old row again. The row-level
 *     security policy admits `review_status = 'accepted'` only, so the claim
 *     leaves the fiche, the graph, the search and the assistant in one write,
 *     with no second list to keep in step.
 *
 * The replacement is the reader's word: `proposed_by = 'user'`, `locked`, and
 * `epistemic_status = 'user_validated'`. Locking is not decoration — the
 * append-only trigger refuses to let an AI proposal supersede a locked row, so
 * re-importing the chapter cannot quietly undo this. The decision is filed
 * against the original proposal's fingerprint for the same reason one layer up:
 * a re-import recognises the proposal it already asked about and does not queue
 * it again.
 */

/** What the reader changed about a fact. */
export type ReviseChange = 'predicate' | 'object' | 'value'

export interface ReviseInput {
  /** The assertion as the fiche shows it. */
  assertionId: string
  /** The predicate it should have used. Absent leaves it alone. */
  predicate?: string
  /** The entity it should have pointed at. Absent leaves it alone. */
  objectEntityId?: string
  /** What it should have said, for a fact carrying a literal rather than a node. */
  objectValue?: string
  /** Kept on the review decision, for whoever reads it in a year. */
  comment?: string
}

export interface ReviseResult {
  /** The row that was superseded — still there, still citable. */
  previousAssertionId: string
  /** The correction. Equal to `previousAssertionId` when nothing was done. */
  assertionId: string
  changed: ReviseChange[]
  /** The end that did not move — the fiche it is written on, most of the time. */
  subjectEntityId: string
  previousPredicate: string
  predicate: string
  fromEntityId: string | null
  toEntityId: string | null
  previousValue: string | null
  value: string | null
  evidenceCopied: number
  /** True when the assertion had already been superseded: a repeat run. */
  alreadyDone: boolean
}

export interface RetractInput {
  assertionId: string
  comment?: string
}

export interface RetractResult {
  assertionId: string
  predicate: string
  subjectEntityId: string
  objectEntityId: string | null
  /** True when the fact was already rejected: a repeat click. */
  alreadyDone: boolean
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The longest literal the fiche will take. Prose belongs in an event summary. */
const MAX_VALUE = 500

export async function reviseAssertion(
  userId: string,
  input: ReviseInput,
): Promise<ReviseResult> {
  if (!UUID_RE.test(input.assertionId)) throw new Error('Assertion introuvable.')
  if (input.objectEntityId !== undefined && !UUID_RE.test(input.objectEntityId)) {
    throw new Error('Entité cible introuvable.')
  }

  return withIngest(async (db) => {
    /*
     * Read by id *and* by owner. `withIngest` runs as the ingestion role, which
     * bypasses row-level security, so every clause that scopes this to one
     * library is written out here rather than assumed — the same rule retype.ts
     * and repoint.ts follow next door.
     */
    const [old] = await db
      .select()
      .from(assertions)
      .where(and(eq(assertions.id, input.assertionId), eq(assertions.userId, userId)))
      .limit(1)

    if (!old) throw new Error('Assertion introuvable.')

    /*
     * Already corrected. Not an error: a second tab, a double click, or a repair
     * script run twice should find the work done and say so rather than stack a
     * second superseding row on the first.
     */
    if (old.superseded_by !== null || old.reviewStatus === 'superseded') {
      return {
        previousAssertionId: old.id,
        assertionId: old.superseded_by ?? old.id,
        changed: [],
        subjectEntityId: old.subjectEntityId,
        previousPredicate: old.predicate,
        predicate: old.predicate,
        fromEntityId: old.objectEntityId,
        toEntityId: old.objectEntityId ?? input.objectEntityId ?? null,
        previousValue: literalOf(old.objectValue),
        value: literalOf(old.objectValue),
        evidenceCopied: 0,
        alreadyDone: true,
      }
    }

    if (old.reviewStatus === 'rejected') {
      throw new Error('Ce fait a été retiré : il n’y a plus rien à corriger.')
    }

    /*
     * A fact points at a node or carries a string, never both, and a correction
     * does not turn one into the other. « travels_to "la base de la Marine" »
     * becoming a relation to a place is a different gesture — it needs a node
     * that may not exist — and doing it silently here would leave the reader
     * unable to tell which of the two they had asked for.
     */
    if (input.objectEntityId !== undefined && old.objectEntityId === null) {
      throw new Error(
        'Cette assertion porte une valeur littérale, pas une entité : il n’y a ' +
          'pas d’objet à réorienter.',
      )
    }
    if (input.objectValue !== undefined && old.objectEntityId !== null) {
      throw new Error(
        'Cette assertion pointe vers une entité : c’est l’entité qui se corrige, ' +
          'pas un texte.',
      )
    }

    const previousValue = literalOf(old.objectValue)
    const value =
      input.objectValue === undefined ? previousValue : input.objectValue.trim()

    if (input.objectValue !== undefined) {
      if (value === null || value.length === 0) {
        throw new Error('Une valeur vide ne dit rien : retirez le fait plutôt.')
      }
      if (value.length > MAX_VALUE) {
        throw new Error(`Une valeur littérale ne dépasse pas ${MAX_VALUE} caractères.`)
      }
    }

    const changed: ReviseChange[] = []
    if (input.predicate !== undefined && input.predicate !== old.predicate) {
      changed.push('predicate')
    }
    if (
      input.objectEntityId !== undefined &&
      input.objectEntityId !== old.objectEntityId
    ) {
      changed.push('object')
    }
    if (input.objectValue !== undefined && value !== previousValue) changed.push('value')

    if (changed.length === 0) {
      // Said in terms of what was asked for. « Rien n'a changé » in front of a
      // form where the reader picked an entity reads as a failure of the form.
      if (input.objectEntityId !== undefined) {
        throw new Error('Cette assertion pointe déjà vers cette entité.')
      }
      if (input.predicate !== undefined) throw new Error('C’est déjà sa relation.')
      if (input.objectValue !== undefined) {
        throw new Error('Cette assertion dit déjà exactement cela.')
      }
      throw new Error('Rien à corriger : indiquez ce qui change.')
    }

    const predicate = changed.includes('predicate') ? input.predicate! : old.predicate

    /*
     * The predicate, checked against the table rather than against the shipped
     * list. The ontology lives in data precisely so a user-created predicate
     * works like a built-in one (ADR 0004), and the foreign key would refuse an
     * unknown one anyway — as a driver exception reaching the reader as
     * « Refusée par la base ». This is the same refusal, said in French and
     * before anything else runs.
     */
    if (changed.includes('predicate')) {
      const [known] = await db
        .select({ key: predicates.key })
        .from(predicates)
        .where(eq(predicates.key, predicate))
        .limit(1)

      if (!known) throw new Error(`Prédicat inconnu : ${predicate}.`)
    }

    const toEntityId = changed.includes('object')
      ? input.objectEntityId!
      : old.objectEntityId

    /*
     * The target, checked in the same library. A relation across two works would
     * be refused by nothing else here: the ontology trigger validates the node
     * *type* and has no opinion about which work the node belongs to.
     */
    if (changed.includes('object')) {
      const [target] = await db
        .select({ id: entities.id, workId: entities.workId })
        .from(entities)
        .where(and(eq(entities.id, toEntityId!), eq(entities.userId, userId)))
        .limit(1)

      if (!target) throw new Error('Entité cible introuvable.')
      if (target.workId !== old.workId) {
        throw new Error('L’entité cible appartient à une autre œuvre.')
      }
    }

    /*
     * Everything about *when* is copied, not recomputed.
     *
     * `knowledge_from_chapter` is the chapter at which the reader could know
     * this, and correcting what a fact says does not move it. Dating the
     * replacement to today would be the one edit that breaks the product's
     * promise: a past view would stop reproducing.
     */
    const [fresh] = await db
      .insert(assertions)
      .values({
        workId: old.workId,
        userId,
        subjectEntityId: old.subjectEntityId,
        predicate,
        objectEntityId: toEntityId,
        objectValue: value === null ? null : { value },
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

    const correctedPayload: Record<string, string> = {}
    if (changed.includes('predicate')) correctedPayload.predicate = predicate
    if (changed.includes('object')) correctedPayload.objectEntityId = toEntityId!
    if (changed.includes('value')) correctedPayload.objectValue = value!

    await recordDecision(db, {
      userId,
      workId: old.workId,
      fingerprint: old.proposalFingerprint,
      decision: 'correct',
      correctedPayload,
      comment: input.comment ?? null,
    })

    await db.insert(auditLog).values({
      userId,
      action: 'assertion_revised',
      subjectKind: 'assertion',
      subjectId: old.id,
      detail: {
        changed,
        subjectEntityId: old.subjectEntityId,
        predicate: { from: old.predicate, to: predicate },
        object: { from: old.objectEntityId, to: toEntityId },
        value: { from: previousValue, to: value },
        replacedBy: fresh.id,
        comment: input.comment ?? null,
      },
    })

    return {
      previousAssertionId: old.id,
      assertionId: fresh.id,
      changed,
      subjectEntityId: old.subjectEntityId,
      previousPredicate: old.predicate,
      predicate,
      fromEntityId: old.objectEntityId,
      toEntityId,
      previousValue,
      value,
      evidenceCopied: cited.length,
      alreadyDone: false,
    }
  })
}

/**
 * Take back a fact that is not one.
 *
 * The case a repoint cannot answer: nothing is *nearly* right about « Baggy
 * appartient à l'Équipage du Roux » — there is no other crew the sentence was
 * about, because the reader has not met one, and the flashback it cites says
 * only that the two of them once sailed together. What the graph needs is for
 * the claim to stop being made.
 *
 * `review_status = 'rejected'` and nothing else. The row, its evidence, its run
 * and its model stay exactly where they are, and the audit entry names the id —
 * so a retraction decided too fast is undone by hand rather than by archaeology.
 * The same status the retype uses when a new node type makes a fact impossible,
 * for the same reason: a deletion would take the record with it.
 */
export async function retractAssertion(
  userId: string,
  input: RetractInput,
): Promise<RetractResult> {
  if (!UUID_RE.test(input.assertionId)) throw new Error('Assertion introuvable.')

  return withIngest(async (db) => {
    const [old] = await db
      .select()
      .from(assertions)
      .where(and(eq(assertions.id, input.assertionId), eq(assertions.userId, userId)))
      .limit(1)

    if (!old) throw new Error('Assertion introuvable.')

    if (old.superseded_by !== null || old.reviewStatus === 'superseded') {
      throw new Error(
        'Ce fait a déjà été remplacé par une correction : c’est celle-ci qu’il ' +
          'faut retirer.',
      )
    }

    // Already gone. A second click, or a page opened before the first one.
    if (old.reviewStatus === 'rejected') {
      return {
        assertionId: old.id,
        predicate: old.predicate,
        subjectEntityId: old.subjectEntityId,
        objectEntityId: old.objectEntityId,
        alreadyDone: true,
      }
    }

    await db
      .update(assertions)
      .set({ reviewStatus: 'rejected' })
      .where(and(eq(assertions.id, old.id), eq(assertions.userId, userId)))

    await recordDecision(db, {
      userId,
      workId: old.workId,
      fingerprint: old.proposalFingerprint,
      decision: 'reject',
      correctedPayload: null,
      comment: input.comment ?? null,
    })

    await db.insert(auditLog).values({
      userId,
      action: 'assertion_retracted',
      subjectKind: 'assertion',
      subjectId: old.id,
      detail: {
        predicate: old.predicate,
        subjectEntityId: old.subjectEntityId,
        objectEntityId: old.objectEntityId,
        objectValue: literalOf(old.objectValue),
        knowledgeFromChapter: old.knowledgeFromChapter,
        comment: input.comment ?? null,
      },
    })

    return {
      assertionId: old.id,
      predicate: old.predicate,
      subjectEntityId: old.subjectEntityId,
      objectEntityId: old.objectEntityId,
      alreadyDone: false,
    }
  })
}

/**
 * The same verdict one layer up, so a re-import does not ask again.
 *
 * Keyed on the proposal's fingerprint, which the extraction step recomputes from
 * the subject, the predicate, the object and the evidence — identical on the
 * next pass over the same chapter. Without this row the corrected relation would
 * come back as a fresh proposal every time the chapter is reprocessed.
 * Assertions predating the fingerprint column simply skip it: inventing one
 * would key the decision to a proposal that never existed.
 */
async function recordDecision(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    workId: string
    fingerprint: string | null
    decision: 'correct' | 'reject'
    correctedPayload: Record<string, string> | null
    comment: string | null
  },
): Promise<void> {
  if (input.fingerprint === null) return

  await db
    .insert(reviewDecisions)
    .values({
      userId: input.userId,
      workId: input.workId,
      proposalFingerprint: input.fingerprint,
      decision: input.decision,
      correctedPayload: input.correctedPayload,
      comment: input.comment,
    })
    .onConflictDoUpdate({
      target: [
        reviewDecisions.userId,
        reviewDecisions.workId,
        reviewDecisions.proposalFingerprint,
      ],
      set: {
        decision: input.decision,
        correctedPayload: input.correctedPayload,
        comment: input.comment,
        decidedAt: new Date(),
      },
    })
}

/** `object_value` is stored as `{ value: … }`; a reader wants the string. */
function literalOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value
    return inner === null || inner === undefined ? null : String(inner)
  }
  return String(value)
}
