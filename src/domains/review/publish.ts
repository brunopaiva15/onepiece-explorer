import 'server-only'
import { and, eq, lte, ne, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { reviewDecisions, reviewItems } from '@/db/schema/ingestion.ts'
import {
  assertions,
  auditLog,
  entities,
  entityLabels,
  events,
  evidence,
  glossaryTerms,
  mysteries,
  occurrences,
} from '@/db/schema/knowledge.ts'
import { PROMPT_VERSION } from '@/domains/ai/prompts.ts'
import type {
  CandidateAssertion,
  CandidateEntity,
  CandidateEvent,
  CandidateMystery,
  EvidenceRef,
} from '@/domains/ai/schemas.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { PIPELINE_VERSION } from '@/domains/ingestion/import.ts'
import { rebuildRefTable } from '@/domains/pipeline/rebuild-refs.ts'
import { resolveRef, type RefTable } from '@/domains/pipeline/refs.ts'

/**
 * Turn accepted proposals into graph rows, in one transaction.
 *
 * This is the only place anything becomes canon, and it is the narrowest part of
 * the system on purpose. Everything upstream produces candidates; this function
 * is the door, and it is locked from the outside — nothing here reads a model,
 * infers a fact, or resolves an ambiguity. It writes what a human said yes to.
 *
 * Four properties it has to hold, each with a failure it prevents:
 *
 *   Atomic. Half a published delta is a graph where an assertion references an
 *   entity that does not exist, and there is no way to tell which half ran.
 *
 *   Idempotent. Publishing twice — a double-clicked button, a retried request —
 *   must not double the graph. Keyed on the review item's own state, so a second
 *   pass finds nothing left to publish.
 *
 *   Dated by revelation, not by import. `knowledge_from_chapter` is the chapter
 *   whose pages carry the evidence, never "now". Importing chapter 3 after
 *   chapter 40 must still date chapter 3's facts to 3, or the boundary slider
 *   shows the wrong past.
 *
 *   Recorded. Every decision is written to `review_decisions` keyed by
 *   fingerprint, which is what makes it survive a re-import, and to `audit_log`,
 *   which is what makes it explicable six months later.
 */

export type DecisionKind = 'accept' | 'reject' | 'correct' | 'merge' | 'split' | 'defer'

export interface Decision {
  reviewItemId: string
  decision: DecisionKind
  /** Present for 'correct': the payload as the user edited it. */
  correctedPayload?: unknown
  comment?: string
}

export interface PublishResult {
  entitiesCreated: number
  /**
   * Proposals that turned out to be an entity you already have.
   *
   * Counted apart from `entitiesCreated` because nothing was created: the
   * chapter's facts were attached to an existing character. Reporting a merge
   * as a creation would say the graph grew by a node when the point of the
   * operation is that it did not.
   */
  entitiesMerged: number
  /**
   * Proposals joined to an entity of the same name, without being asked.
   *
   * Counted apart from `entitiesMerged` because the reader decided that one and
   * did not decide this one. A number nobody can see is a silent behaviour, and
   * this behaviour changes which row a chapter's facts land on.
   */
  entitiesReused: number
  assertionsCreated: number
  eventsCreated: number
  mysteriesCreated: number
  labelsCreated: number
  rejected: number
  deferred: number
  /** Items whose decision could not be applied, with the reason. */
  failures: Array<{ reviewItemId: string; reason: string }>
  /**
   * Set when this publication finished the chapter's review and opened it.
   *
   * Reviewing a chapter had no end. The pipeline left it in `review`, deciding
   * its proposals left it in `review`, and nothing anywhere moved it on — so
   * the reader's boundary, which is the highest *published* chapter number,
   * stayed at zero and every row published here was hidden by the row-level
   * policies that date facts by revelation. Forty-two accepted proposals, an
   * empty graph, and nothing on screen connecting the two.
   *
   * A chapter with nothing left proposed is a chapter you have finished
   * reading, so publication says so.
   */
  chapterPublished: number | null
}

/** Two publications reported as one, for a step that runs a sweep after yours. */
export function mergePublishResults(a: PublishResult, b: PublishResult): PublishResult {
  return {
    entitiesCreated: a.entitiesCreated + b.entitiesCreated,
    entitiesMerged: a.entitiesMerged + b.entitiesMerged,
    entitiesReused: a.entitiesReused + b.entitiesReused,
    assertionsCreated: a.assertionsCreated + b.assertionsCreated,
    eventsCreated: a.eventsCreated + b.eventsCreated,
    mysteriesCreated: a.mysteriesCreated + b.mysteriesCreated,
    labelsCreated: a.labelsCreated + b.labelsCreated,
    rejected: a.rejected + b.rejected,
    deferred: a.deferred + b.deferred,
    failures: [...a.failures, ...b.failures],
    // Whichever pass finished the chapter; only one of them can have.
    chapterPublished: a.chapterPublished ?? b.chapterPublished,
  }
}

export async function publishDecisions(
  userId: string,
  runId: string,
  decisions: Decision[],
  refTable?: RefTable,
): Promise<PublishResult> {
  const result: PublishResult = {
    entitiesCreated: 0,
    entitiesMerged: 0,
    entitiesReused: 0,
    assertionsCreated: 0,
    eventsCreated: 0,
    mysteriesCreated: 0,
    labelsCreated: 0,
    rejected: 0,
    deferred: 0,
    failures: [],
    chapterPublished: null,
  }

  if (decisions.length === 0) return result

  await withIngest(async (db) => {
    const [run] = await db
      .select({
        chapterId: reviewItems.chapterId,
        workId: chapters.workId,
        chapterNumber: chapters.number,
      })
      .from(reviewItems)
      .innerJoin(chapters, eq(chapters.id, reviewItems.chapterId))
      .where(and(eq(reviewItems.runId, runId), eq(reviewItems.userId, userId)))
      .limit(1)

    if (!run) throw new Error(`Aucune proposition pour le run ${runId}.`)

    /*
     * Rebuild the ref table rather than requiring the caller to carry it.
     *
     * Publication runs in a different request from extraction, so the run's
     * in-memory table is gone. Refs are deterministic, so they can be recomputed
     * from the same rows — and they must be, because a database trigger refuses
     * an evidence row carrying an excerpt without its source block. An
     * unresolvable ref therefore fails loudly here instead of being stored as
     * unsourced evidence, which is the right outcome for a system whose claim is
     * that everything in it is traceable.
     */
    const table = refTable ?? (await rebuildRefTable(userId, run.chapterId))

    const byId = new Map(decisions.map((d) => [d.reviewItemId, d]))

    const items = await db
      .select({
        id: reviewItems.id,
        category: reviewItems.category,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
        confidence: reviewItems.confidence,
        status: reviewItems.status,
      })
      .from(reviewItems)
      .where(and(eq(reviewItems.runId, runId), eq(reviewItems.userId, userId)))

    /*
     * Local ids from the extraction response map to real entity ids as this
     * loop creates them. Entities are published before assertions for exactly
     * this reason — an assertion naming `syn-3` needs `syn-3` to exist.
     *
     * Seeded from the entities this run has already produced, because a chapter
     * is no longer necessarily published in one go: a naming question holds its
     * entity back and the relations that name it with it, and both arrive in a
     * later batch with a different map. Without this the relation would fail on
     * a subject « e1 » whose entity was accepted a moment earlier — the failure
     * that says "son entité a été rejetée ou reportée" about an entity that was
     * neither.
     */
    const localToEntity = new Map<string, string>()

    const alreadyPublished = await db
      .select({ id: entities.id, localId: entities.proposalLocalId })
      .from(entities)
      .where(and(eq(entities.runId, runId), eq(entities.userId, userId)))

    for (const row of alreadyPublished) {
      if (row.localId !== null) localToEntity.set(row.localId, row.id)
    }

    /*
     * The rapprochements you accepted, read before anything is written.
     *
     * « Zoro » at chapter 3 is Roronoa Zoro, settled at chapter 2. Accepting
     * that used to be impossible — publication answered « pas encore
     * implémenté, reportez ou rejetez » — which left one bad choice and one
     * worse: accept the entity and get a second Zoro that nothing will ever
     * join back, or defer it and lose the chapter's facts about him, since
     * every relation naming him fails on a subject that does not exist.
     *
     * So an accepted rapprochement is a merge. The proposal stops being a new
     * entity and becomes another appearance of the one you already have: its
     * local id points at the existing row, and the chapter's relations, events
     * and mysteries land on the character the reader already knows.
     *
     * Keyed by the candidate's fingerprint because that is what the resolution
     * payload carries — the identity of the *proposal*, which survives the
     * review item ids being unknown to each other.
     */
    const mergeInto = new Map<string, string>()
    /** Fingerprints a merge was really applied to, for the resolution loop. */
    const merged = new Set<string>()
    for (const item of items) {
      if (item.category !== 'resolution') continue
      if (item.status !== 'proposed') continue
      const decision = byId.get(item.id)
      if (decision?.decision !== 'accept') continue

      const payload = (item.payload ?? {}) as Record<string, unknown>
      const fingerprint = payload.candidateFingerprint
      const existingId = payload.existingEntityId
      if (typeof fingerprint !== 'string' || typeof existingId !== 'string') continue
      mergeInto.set(fingerprint, existingId)
    }

    // Entities first.
    for (const item of items) {
      if (item.category !== 'entity') continue
      const decision = byId.get(item.id)

      /*
       * A merged proposal needs no decision of its own.
       *
       * Answering « oui, c'est bien lui » on the rapprochement is the decision;
       * asking for the entity card to be accepted as well would be asking the
       * same question twice, and the two cards can be forty apart in the queue.
       */
      const mergeTarget = mergeInto.get(item.fingerprint)
      if (mergeTarget !== undefined && item.status === 'proposed') {
        const candidate = (decision?.correctedPayload ?? item.payload) as CandidateEntity
        localToEntity.set(candidate.local_id, mergeTarget)

        const added = await addMergedLabel(db, {
          userId,
          entityId: mergeTarget,
          label: candidate.label,
          kind: candidate.label_kind,
          chapterNumber: run.chapterNumber,
        })
        if (added) result.labelsCreated++

        await db
          .update(reviewItems)
          .set({ status: 'accepted' })
          .where(eq(reviewItems.id, item.id))
        merged.add(item.fingerprint)
        result.entitiesMerged++
        continue
      }

      if (!decision) continue

      // Idempotency: an item already decided is not decided again. A second
      // publish therefore writes nothing rather than doubling the graph.
      if (item.status !== 'proposed') continue

      if (decision.decision === 'reject') {
        await recordDecision(db, userId, run.workId, item, decision)
        await db
          .update(reviewItems)
          .set({ status: 'rejected' })
          .where(eq(reviewItems.id, item.id))
        result.rejected++
        continue
      }

      if (decision.decision === 'defer') {
        await db
          .update(reviewItems)
          .set({ status: 'deferred' })
          .where(eq(reviewItems.id, item.id))
        result.deferred++
        continue
      }

      const candidate = (decision.correctedPayload ?? item.payload) as CandidateEntity

      /*
       * The same name, already in the graph.
       *
       * Publication used to insert unconditionally, and the only thing that
       * ever stopped a duplicate was the resolution step — which runs at
       * *import* and compares against what was accepted *then*. Import three
       * chapters before reviewing any of them and that comparison sees nothing:
       * each chapter re-proposes the same characters, no rapprochement is ever
       * offered, and publishing them creates three Shanks that nothing will
       * join. At a thousand chapters, "publish between each import" is not an
       * instruction anyone can follow.
       *
       * So the check moves to the moment it can be right: here, where the
       * accepted set is current. Exact normalised label, same node type, same
       * work, first seen at this chapter or before — the strongest signal there
       * is, and the one the trigram matcher approximates with a threshold.
       *
       * What it buys is not only the absence of a duplicate. The chapter's
       * relations name this proposal by its local id; pointing that id at the
       * existing row is what makes them land on the character the reader
       * already knows, which is the whole reason links were missing.
       *
       * What it costs: two genuinely different characters with the same name
       * become one entity to separate. That is a real case in a long fiction,
       * and it is the reason this is counted, audited and reported rather than
       * done quietly.
       */
      const twin = await exactTwin(db, {
        workId: run.workId,
        userId,
        nodeType: candidate.node_type,
        label: candidate.label,
        chapterNumber: run.chapterNumber,
      })

      if (twin !== null) {
        localToEntity.set(candidate.local_id, twin)

        const added = await addMergedLabel(db, {
          userId,
          entityId: twin,
          label: candidate.label,
          kind: candidate.label_kind,
          chapterNumber: run.chapterNumber,
        })
        if (added) result.labelsCreated++

        await db.insert(auditLog).values({
          userId,
          action: 'entity_reused',
          subjectKind: 'entity',
          subjectId: twin,
          detail: {
            label: candidate.label,
            nodeType: candidate.node_type,
            chapterNumber: run.chapterNumber,
            reviewItemId: item.id,
          },
        })

        await recordDecision(db, userId, run.workId, item, decision)
        await db
          .update(reviewItems)
          .set({ status: 'accepted' })
          .where(eq(reviewItems.id, item.id))
        result.entitiesReused++
        continue
      }

      const [entity] = await db
        .insert(entities)
        .values({
          workId: run.workId,
          userId,
          nodeType: candidate.node_type,
          firstSeenChapter: run.chapterNumber,
          reviewStatus: 'accepted',
          // Provenance, so a relation published in a later batch can still find
          // this row from the id the model gave it.
          runId,
          proposalLocalId: candidate.local_id,
        })
        .returning({ id: entities.id })

      if (!entity) {
        result.failures.push({ reviewItemId: item.id, reason: "Création d'entité échouée." })
        continue
      }

      localToEntity.set(candidate.local_id, entity.id)

      await db.insert(entityLabels).values({
        entityId: entity.id,
        userId,
        label: candidate.label,
        normalizedLabel: normalizeText(candidate.label),
        kind: candidate.label_kind,
        // The chapter that revealed this name, not the chapter being imported
        // now. Importing out of order must not change when a name became known.
        revealedInChapter: run.chapterNumber,
        precedence: precedenceFor(candidate.label_kind),
      })

      result.entitiesCreated++
      result.labelsCreated++

      /*
       * The wording the source used, kept as a name of its own.
       *
       * « Foosha Village » is what the chapter says and « Village de Fuchsia »
       * is what we call it, and until now only the second was stored. That cost
       * twice: a reader searching the English name they read in a scan found
       * nothing, and the illustration catalogues — which are English to the
       * last row — could not match a French label, so half the graph stayed
       * faceless with no explanation.
       *
       * Precedence 5, below every kind in LABEL_PRECEDENCE, so it can never
       * become the displayed name: this is the name the entity is *findable*
       * by, not the name it is called by. Its revelation chapter is this one,
       * like the label it accompanies, so it is bounded exactly the same way.
       */
      const sourceWording = candidate.source_term?.trim() ?? ''
      if (
        sourceWording.length > 0 &&
        normalizeText(sourceWording) !== normalizeText(candidate.label)
      ) {
        await db.insert(entityLabels).values({
          entityId: entity.id,
          userId,
          label: sourceWording,
          normalizedLabel: normalizeText(sourceWording),
          kind: 'alias',
          revealedInChapter: run.chapterNumber,
          precedence: 5,
        })
        result.labelsCreated++
      }

      /*
       * The naming decision, recorded so it is never asked again.
       *
       * The model flagged that it did not know the French form; you answered.
       * Without this the next chapter containing the same source wording gets
       * the same question, and — worse — a different guess to review, which is
       * how one person becomes two entities.
       *
       * Two ways to answer, and both count. Retyping the label is the obvious
       * one. Accepting the proposal unchanged *on an entity the model flagged*
       * is the other, and it was not recorded before: the reasoning was that
       * accepting unchanged means "close enough here" rather than "use this
       * everywhere". That reasoning holds for a proposal the model was sure of
       * — and inverts for one where it declared it was not. It asked, the item
       * was queued for explicit review with an editable field, and you accepted
       * the form. Treating that as an abstention is what made « Foosha Village »
       * come back chapter after chapter with the answer already given.
       *
       * Silence is still silence: an entity the model was confident about and
       * you waved through settles nothing.
       */
      const answeredNaming =
        decision.decision === 'correct' || candidate.naming_confident === false

      if (
        answeredNaming &&
        candidate.source_term &&
        candidate.source_term.trim().length > 0
      ) {
        const sourceTerm = candidate.source_term.trim()
        await db
          .insert(glossaryTerms)
          .values({
            workId: run.workId,
            userId,
            sourceTerm,
            normalizedSource: normalizeText(sourceTerm),
            frenchTerm: candidate.label,
            decidedInChapter: run.chapterNumber,
          })
          .onConflictDoUpdate({
            target: [glossaryTerms.workId, glossaryTerms.normalizedSource],
            // Answering again replaces the answer. Keeping the first one would
            // make a correction of a correction impossible.
            set: { frenchTerm: candidate.label, updatedAt: new Date() },
          })
      }

      await recordDecision(db, userId, run.workId, item, decision)
      await db
        .update(reviewItems)
        .set({ status: 'accepted' })
        .where(eq(reviewItems.id, item.id))
    }

    // Then assertions, which may reference the entities just created.
    for (const item of items) {
      if (item.category !== 'assertion') continue
      const decision = byId.get(item.id)
      if (!decision || item.status !== 'proposed') continue

      if (decision.decision === 'reject') {
        await recordDecision(db, userId, run.workId, item, decision)
        await db
          .update(reviewItems)
          .set({ status: 'rejected' })
          .where(eq(reviewItems.id, item.id))
        result.rejected++
        continue
      }

      if (decision.decision === 'defer') {
        await db
          .update(reviewItems)
          .set({ status: 'deferred' })
          .where(eq(reviewItems.id, item.id))
        result.deferred++
        continue
      }

      const candidate = (decision.correctedPayload ?? item.payload) as CandidateAssertion

      const subjectId = localToEntity.get(candidate.subject) ?? candidate.subject
      const objectId = candidate.object
        ? (localToEntity.get(candidate.object) ?? candidate.object)
        : null

      if (!isUuid(subjectId)) {
        // The subject's own entity was rejected or deferred. Publishing the
        // assertion anyway would leave a dangling reference; saying so lets the
        // user go back and accept the entity first.
        result.failures.push({
          reviewItemId: item.id,
          reason:
            `Le sujet « ${candidate.subject} » n'existe pas dans le graphe : ` +
            `son entité a été rejetée ou reportée. Acceptez-la d'abord.`,
        })
        continue
      }

      if (objectId !== null && !isUuid(objectId)) {
        result.failures.push({
          reviewItemId: item.id,
          reason: `L'objet « ${candidate.object} » n'existe pas dans le graphe.`,
        })
        continue
      }

      /*
       * The ontology's last word, and the only place it is enforced.
       *
       * A trigger refuses an edge whose ends do not match the predicate —
       * « destroys » takes an object, a place or a group, never a character.
       * That check is right and it belongs in the database. What was wrong is
       * what happened next: the exception escaped the whole publication, so one
       * nonsensical relation out of eighty threw away the seventy-nine good
       * ones and showed the reader a raw INSERT statement.
       *
       * A savepoint contains it. PostgreSQL aborts a transaction on any error,
       * so catching in JavaScript is not enough — the nested transaction is a
       * SAVEPOINT, and rolling back to it leaves everything already published
       * intact. The refusal then travels the same way every other one does: a
       * line in `failures`, in French, naming the item.
       */
      let assertionId: string | null
      try {
        assertionId = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(assertions)
            .values({
              workId: run.workId,
              userId,
              subjectEntityId: subjectId,
              predicate: candidate.predicate,
              objectEntityId: objectId,
              objectValue:
                candidate.object_value === null ? null : { value: candidate.object_value },
              knowledgeFromChapter: run.chapterNumber,
              observedInChapter: run.chapterNumber,
              confidence: candidate.confidence,
              epistemicStatus:
                decision.decision === 'correct' ? 'user_validated' : candidate.epistemic_status,
              reviewStatus: 'accepted',
              // A corrected assertion is the user's, not the model's, and it is
              // locked: a later run must never supersede a human's own words.
              proposedBy: decision.decision === 'correct' ? 'user' : 'ai',
              locked: decision.decision === 'correct',
              pipelineVersion: PIPELINE_VERSION,
              promptVersion: PROMPT_VERSION,
              runId,
              proposalFingerprint: item.fingerprint,
            })
            .returning({ id: assertions.id })
          return row?.id ?? null
        })
      } catch (error: unknown) {
        result.failures.push({ reviewItemId: item.id, reason: refusalReason(error) })
        continue
      }

      if (assertionId === null) {
        result.failures.push({ reviewItemId: item.id, reason: 'Insertion échouée.' })
        continue
      }

      const anchors = await insertEvidence(db, {
        assertionId,
        userId,
        chapterId: run.chapterId,
        refs: candidate.evidence,
        refTable: table,
      })

      /*
       * Record where each participant was seen.
       *
       * `occurrences` has been boundary-filtered since 0005 and empty ever
       * since — nothing wrote it. It is what makes "where does this character
       * appear" answerable without walking every assertion's evidence, and it
       * gives a search result a page and a panel to link to rather than only a
       * chapter number.
       *
       * `appearance` when the evidence is a drawing, `mention` when it is text:
       * being named in a conversation is not the same as being on the page, and
       * a reader looking for a character's first appearance means the first.
       */
      const participants = [subjectId, objectId].filter(
        (id): id is string => id !== null,
      )
      for (const entityId of participants) {
        for (const anchor of anchors) {
          await db
            .insert(occurrences)
            .values({
              entityId,
              userId,
              chapterId: run.chapterId,
              panelId: anchor.panelId,
              kind: anchor.kind === 'image' ? 'appearance' : 'mention',
              chapterNumber: run.chapterNumber,
              confidence: candidate.confidence,
            })
            .onConflictDoNothing()
        }
      }

      result.assertionsCreated++
      await recordDecision(db, userId, run.workId, item, decision)
      await db
        .update(reviewItems)
        .set({ status: 'accepted' })
        .where(eq(reviewItems.id, item.id))
    }

    // Events and mysteries are entities with a side table, per the schema.
    for (const item of items) {
      if (item.category !== 'event' && item.category !== 'mystery') continue
      const decision = byId.get(item.id)
      if (!decision || item.status !== 'proposed') continue

      if (decision.decision === 'reject' || decision.decision === 'defer') {
        if (decision.decision === 'reject') {
          await recordDecision(db, userId, run.workId, item, decision)
          result.rejected++
        } else {
          result.deferred++
        }
        await db
          .update(reviewItems)
          .set({ status: decision.decision === 'reject' ? 'rejected' : 'deferred' })
          .where(eq(reviewItems.id, item.id))
        continue
      }

      const nodeType = item.category === 'event' ? 'event' : 'mystery'
      const [entity] = await db
        .insert(entities)
        .values({
          workId: run.workId,
          userId,
          nodeType,
          firstSeenChapter: run.chapterNumber,
          reviewStatus: 'accepted',
          runId,
        })
        .returning({ id: entities.id })

      if (!entity) {
        result.failures.push({ reviewItemId: item.id, reason: 'Création échouée.' })
        continue
      }

      if (item.category === 'event') {
        const candidate = (decision.correctedPayload ?? item.payload) as CandidateEvent
        await db.insert(events).values({
          entityId: entity.id,
          userId,
          workId: run.workId,
          summary: candidate.summary,
          isFlashback: candidate.is_flashback,
          /*
           * Shown and told are recorded separately and neither is inferred. A
           * flashback is *shown* in this chapter while happening earlier in the
           * story; collapsing the two axes is exactly the mistake that makes a
           * timeline lie.
           */
          shownInChapter: run.chapterNumber,
          toldInChapter: candidate.is_flashback ? run.chapterNumber : null,
        })
        await db.insert(entityLabels).values({
          entityId: entity.id,
          userId,
          label: candidate.summary.slice(0, 200),
          normalizedLabel: normalizeText(candidate.summary.slice(0, 200)),
          kind: 'alias',
          revealedInChapter: run.chapterNumber,
          precedence: 10,
        })
        result.eventsCreated++
        result.labelsCreated++
      } else {
        const candidate = (decision.correctedPayload ?? item.payload) as CandidateMystery
        await db.insert(mysteries).values({
          entityId: entity.id,
          userId,
          workId: run.workId,
          question: candidate.question,
          openedInChapter: run.chapterNumber,
          state: 'open',
        })
        await db.insert(entityLabels).values({
          entityId: entity.id,
          userId,
          label: candidate.question.slice(0, 200),
          normalizedLabel: normalizeText(candidate.question.slice(0, 200)),
          kind: 'alias',
          revealedInChapter: run.chapterNumber,
          precedence: 10,
        })
        result.mysteriesCreated++
        result.labelsCreated++
      }

      await recordDecision(db, userId, run.workId, item, decision)
      await db
        .update(reviewItems)
        .set({ status: 'accepted' })
        .where(eq(reviewItems.id, item.id))
    }

    /*
     * Rapprochements and contradictions, decided rather than ignored.
     *
     * A rapprochement is now applied where it belongs — in the entity loop
     * above, as a merge — so accepting one here is a matter of recording it,
     * unless the merge could not run: an entity proposal already published as
     * its own row in an earlier batch cannot be un-published, and saying so is
     * more use than a silent success.
     *
     * A contradiction still has no publication path. Accepting one means
     * closing an earlier belief or keeping both, and neither is built. Saying
     * that plainly beats a click that does nothing — the item would stay
     * 'proposed', which also means the chapter could never count as read.
     *
     * Before openIfReviewed, so a batch whose last undecided items are these
     * finishes the chapter instead of leaving it one publication short.
     */
    for (const item of items) {
      if (item.category !== 'resolution' && item.category !== 'conflict') continue
      const decision = byId.get(item.id)
      if (!decision || item.status !== 'proposed') continue

      if (decision.decision === 'reject') {
        await recordDecision(db, userId, run.workId, item, decision)
        await db
          .update(reviewItems)
          .set({ status: 'rejected' })
          .where(eq(reviewItems.id, item.id))
        result.rejected++
        continue
      }

      if (decision.decision === 'defer') {
        await db
          .update(reviewItems)
          .set({ status: 'deferred' })
          .where(eq(reviewItems.id, item.id))
        result.deferred++
        continue
      }

      if (item.category === 'resolution') {
        const payload = (item.payload ?? {}) as Record<string, unknown>
        const fingerprint =
          typeof payload.candidateFingerprint === 'string'
            ? payload.candidateFingerprint
            : ''

        if (merged.has(fingerprint)) {
          await recordDecision(db, userId, run.workId, item, decision)
          await db
            .update(reviewItems)
            .set({ status: 'accepted' })
            .where(eq(reviewItems.id, item.id))
          continue
        }

        result.failures.push({
          reviewItemId: item.id,
          reason:
            'Le rapprochement n’a pas pu être appliqué : la proposition d’entité ' +
            'correspondante a déjà été décidée dans un lot précédent, et une entité ' +
            'publiée ne se replie pas sur une autre. Rejetez ce rapprochement.',
        })
        continue
      }

      result.failures.push({
        reviewItemId: item.id,
        reason:
          'Trancher une contradiction demande de fermer la croyance antérieure ' +
          'ou de garder les deux : ce n’est pas encore implémenté. ' +
          'Reportez-la ou rejetez-la.',
      })
    }

    result.chapterPublished = await openIfReviewed(db, userId, run.chapterId)

    await db.insert(auditLog).values({
      userId,
      action: 'publish_delta',
      subjectKind: 'ingestion_run',
      subjectId: runId,
      detail: {
        chapterNumber: run.chapterNumber,
        ...result,
      },
    })
  })

  return result
}

/**
 * Open a chapter whose review is finished, and say so.
 *
 * Reviewing had no end. Import left a chapter in `uploaded`, a successful run
 * left it in `review`, and publishing its decisions left it there too — while
 * the reader's boundary is the highest *published* chapter number. With none
 * published the boundary is zero, so every row written by publication is hidden
 * by the very policies that date facts by revelation: forty-two accepted
 * proposals and an empty graph, with nothing on screen connecting the two.
 *
 * Nothing left proposed is the end of a review. Deferred and rejected items
 * were looked at and answered; only 'proposed' is an open question.
 *
 * Counted across the chapter rather than one run, because a second run on the
 * same chapter leaves a queue of its own, and opening the boundary over
 * proposals nobody has read would be the one mistake this whole design exists
 * to prevent.
 */
export async function openIfReviewed(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  chapterId: string,
): Promise<number | null> {
  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.chapterId, chapterId),
        eq(reviewItems.userId, userId),
        eq(reviewItems.status, 'proposed'),
      ),
    )

  if ((pending?.count ?? 0) > 0) return null

  const [opened] = await db
    .update(chapters)
    .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(chapters.id, chapterId),
        eq(chapters.userId, userId),
        // Publishing again must not rewrite the date it was first finished:
        // that date is what the reader's position is built on.
        ne(chapters.status, 'published'),
      ),
    )
    .returning({ number: chapters.number })

  return opened?.number ?? null
}

/**
 * Finish a chapter whose queue was emptied before publication learned to.
 *
 * The automatic path above covers every review from now on. This is for the
 * chapters already decided and already invisible — one call, same rule, no
 * special case in the rule itself.
 */
export async function markChapterReviewed(
  userId: string,
  runId: string,
): Promise<number | null> {
  return withIngest(async (db) => {
    const [run] = await db
      .select({ chapterId: reviewItems.chapterId })
      .from(reviewItems)
      .where(and(eq(reviewItems.runId, runId), eq(reviewItems.userId, userId)))
      .limit(1)
    if (!run) return null
    return openIfReviewed(db, userId, run.chapterId)
  })
}

/**
 * Record the decision against its fingerprint.
 *
 * This is the row that makes a correction survive a re-import: the next run
 * fingerprints the same proposal, finds this decision, and does not ask again.
 * Keyed on `(user, work, fingerprint)` rather than on the review item, because
 * the review item is per-run and would not match anything on the next pass.
 */
async function recordDecision(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  workId: string,
  item: { fingerprint: string },
  decision: Decision,
): Promise<void> {
  await db
    .insert(reviewDecisions)
    .values({
      userId,
      workId,
      proposalFingerprint: item.fingerprint,
      decision: decision.decision,
      correctedPayload: (decision.correctedPayload ?? null) as object | null,
      comment: decision.comment ?? null,
    })
    .onConflictDoUpdate({
      target: [
        reviewDecisions.userId,
        reviewDecisions.workId,
        reviewDecisions.proposalFingerprint,
      ],
      set: {
        decision: decision.decision,
        correctedPayload: (decision.correctedPayload ?? null) as object | null,
        comment: decision.comment ?? null,
        decidedAt: new Date(),
      },
    })
}

/**
 * Store the evidence behind an assertion.
 *
 * Refs are translated back to real ids where a table is available. Without one —
 * publishing from a stored payload in a later session, after the run's in-memory
 * table is gone — the excerpt and chapter are still recorded, because an excerpt
 * with no panel id is weaker evidence but is not *no* evidence, and dropping it
 * would leave an assertion looking unsourced.
 */
async function insertEvidence(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    assertionId: string
    userId: string
    chapterId: string
    refs: EvidenceRef[]
    refTable: RefTable
  },
): Promise<Array<{ panelId: string | null; kind: 'dialogue' | 'image' }>> {
  if (input.refs.length === 0) return []

  const rows = input.refs.map((ref) => {
    const resolved = resolveRef(input.refTable, ref.ref)
    if (!resolved) {
      /*
       * A ref that no longer resolves means the pages moved under the proposal
       * — a re-cut panel, a reordered page. Failing here is correct: the
       * alternative is an assertion in the graph whose citation points at
       * nothing, which looks sourced and is not.
       */
      throw new Error(
        `La preuve « ${ref.ref} » ne correspond plus à aucune case ou bloc de ce chapitre. ` +
          `Relancez le traitement avant de publier.`,
      )
    }
    return {
        assertionId: input.assertionId,
        userId: input.userId,
        chapterId: input.chapterId,
        panelId: resolved.kind === 'panel' ? resolved.id : null,
        textBlockId: resolved.kind === 'block' ? resolved.id : null,
        /*
         * 'dialogue' for a text citation, 'image' for a visual one.
         *
         * The enum distinguishes where the evidence lives on the page, not which
         * pipeline produced it: a quote is dialogue whether it came from a PDF
         * text layer, tesseract or a model, and how it was read is recorded on
         * the text block instead.
         */
        kind: ref.kind === 'text' ? ('dialogue' as const) : ('image' as const),
        excerpt: ref.excerpt,
      }
  })

  await db.insert(evidence).values(rows)
  return rows.map((row) => ({ panelId: row.panelId, kind: row.kind }))
}

/**
 * Which label wins when several are visible.
 *
 * A true name outranks an epithet outranks an alias outranks a placeholder. The
 * placeholder is the floor precisely so that it disappears from the display the
 * moment anything better is revealed — while remaining in the table, because at
 * an earlier boundary it is still the only thing the reader knew.
 */
/**
 * Add the name a merged proposal came in under, without renaming anything.
 *
 * Chapter 3 calls him « Zoro » and you settled on « Roronoa Zoro » at chapter
 * 2. Both are names of the same person and the graph should know both — a
 * reader searching either must find him — but the one you settled is the one he
 * is called, and a merge must never quietly change a displayed name behind the
 * reviewer's back. So the new label enters strictly below the entity's current
 * highest precedence, whatever kind it claims to be, and the display is
 * unmoved.
 *
 * Its revelation chapter is the chapter that used it, like every other label:
 * a name is dated by when it was heard, and « Zoro » being known from chapter 3
 * is exactly the sort of thing the boundary exists to keep straight.
 *
 * Returns whether a row was written — a name already on the entity is not a
 * failure, it is the ordinary case of a character named twice.
 */
/**
 * An accepted entity of the same type carrying exactly this name.
 *
 * Exact on the *normalised* label, which is the same normalisation the graph
 * indexes and searches by — « Monkey D. Luffy » and « monkey d luffy » are the
 * same name, « Luffy » is not. Fuzzy resemblance is deliberately not handled
 * here: that is what the resolution step asks a human about, and answering it
 * without asking is the one thing this must not start doing.
 *
 * Bounded by the chapter like everything else. An entity first seen later than
 * the chapter being published cannot be what this chapter is naming.
 */
async function exactTwin(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    workId: string
    userId: string
    nodeType: string
    label: string
    chapterNumber: number
  },
): Promise<string | null> {
  const normalized = normalizeText(input.label)
  if (normalized.length === 0) return null

  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(entityLabels, eq(entityLabels.entityId, entities.id))
    .where(
      and(
        eq(entities.workId, input.workId),
        eq(entities.userId, input.userId),
        eq(entities.nodeType, input.nodeType),
        eq(entities.reviewStatus, 'accepted'),
        lte(entities.firstSeenChapter, input.chapterNumber),
        eq(entityLabels.normalizedLabel, normalized),
        lte(entityLabels.revealedInChapter, input.chapterNumber),
      ),
    )
    .limit(1)

  return row?.id ?? null
}

/**
 * What the database refused, in the words it refused it with.
 *
 * The triggers raise French sentences that name the predicate and the type —
 * they are better error messages than anything this layer could compose. The
 * driver wraps them in « Failed query: insert into … » plus the parameters,
 * which is the part nobody can read and the part that was shown.
 */
function refusalReason(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause
  const message =
    (cause instanceof Error ? cause.message : null) ??
    (error instanceof Error ? error.message : null)

  if (!message) return 'Refusée par la base.'
  const firstLine = message.split('\n')[0]?.trim() ?? message
  return firstLine.startsWith('Failed query') ? 'Refusée par la base.' : firstLine
}

async function addMergedLabel(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    entityId: string
    label: string
    kind: string
    chapterNumber: number
  },
): Promise<boolean> {
  const normalized = normalizeText(input.label)

  const existing = await db
    .select({
      normalizedLabel: entityLabels.normalizedLabel,
      precedence: entityLabels.precedence,
    })
    .from(entityLabels)
    .where(eq(entityLabels.entityId, input.entityId))

  if (existing.some((row) => row.normalizedLabel === normalized)) return false

  const highest = existing.reduce((top, row) => Math.max(top, row.precedence), 0)
  const precedence = Math.max(1, Math.min(precedenceFor(input.kind), highest - 1))

  await db.insert(entityLabels).values({
    entityId: input.entityId,
    userId: input.userId,
    label: input.label,
    normalizedLabel: normalized,
    kind: input.kind as 'placeholder' | 'alias' | 'true_name' | 'epithet' | 'translation',
    revealedInChapter: input.chapterNumber,
    precedence,
  })

  return true
}

function precedenceFor(kind: string): number {
  switch (kind) {
    case 'true_name':
      return 100
    case 'epithet':
      return 70
    case 'alias':
      return 50
    case 'translation':
      return 40
    default:
      return 10
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** Counts for the "narrative delta" summary shown after publishing. */
export async function deltaSummary(
  userId: string,
  runId: string,
): Promise<{ pending: number; accepted: number; rejected: number; deferred: number }> {
  return withIngest(async (db) => {
    const rows = await db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int AS count
      FROM review_items
      WHERE run_id = ${runId} AND user_id = ${userId}
      GROUP BY status
    `)

    const by = new Map(rows.map((row) => [row.status, Number(row.count)]))
    return {
      pending: by.get('proposed') ?? 0,
      accepted: by.get('accepted') ?? 0,
      rejected: by.get('rejected') ?? 0,
      deferred: by.get('deferred') ?? 0,
    }
  })
}
