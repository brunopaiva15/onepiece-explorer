import 'server-only'
import { and, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { ingestionRuns, reviewDecisions, reviewItems } from '@/db/schema/ingestion.ts'
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
  type StoryTime,
} from '@/db/schema/knowledge.ts'
import { PROMPT_VERSION } from '@/domains/ai/prompts.ts'
import type {
  CandidateAssertion,
  CandidateEntity,
  CandidateEvent,
  CandidateMystery,
  EvidenceRef,
} from '@/domains/ai/schemas.ts'
import { futureNameReason, nameRevealedLater } from '@/domains/knowledge/naming.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { classifyOccurrence } from '@/domains/knowledge/occurrence.ts'
import { OCCURRENCE_TYPES, type OccurrenceKind } from '@/domains/knowledge/ontology.ts'
import { ECHO_TOO_CLOSE, findEcho } from '@/domains/review/echoes.ts'
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

/**
 * An accepted rapprochement, as the entity loop needs it.
 *
 * Two answers rather than one, because the card asks two questions. Who this
 * is, which decides where the chapter's facts land; and whether this chapter is
 * where the reader learns what he is called, which decides whether the name is
 * written above the one he had. The second is false unless somebody said so.
 */
interface MergeTarget {
  entityId: string
  revealsName: boolean
}

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
  /**
   * Questions this chapter closed, and questions it re-opened.
   *
   * Counted apart from the assertions that caused them because they are not the
   * same event to a reader: `résout le mystère` is one more edge in the graph,
   * and « la question posée au chapitre 16 est refermée » is a line moving from
   * one half of /mysteres to the other.
   */
  mysteriesResolved: number
  mysteriesReopened: number
  labelsCreated: number
  /**
   * Names this chapter teaches for someone the reader already knows.
   *
   * Counted apart from `labelsCreated` because it is the only publication that
   * changes what an existing character is *called* — every other label lands
   * below the displayed name and moves nothing. « Klahadore » becomes « Kuro »
   * from this chapter on, and stays « Klahadore » at every chapter before it.
   * A change of that size does not belong inside a total.
   */
  namesRevealed: number
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
    mysteriesResolved: a.mysteriesResolved + b.mysteriesResolved,
    mysteriesReopened: a.mysteriesReopened + b.mysteriesReopened,
    labelsCreated: a.labelsCreated + b.labelsCreated,
    namesRevealed: a.namesRevealed + b.namesRevealed,
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
    mysteriesResolved: 0,
    mysteriesReopened: 0,
    labelsCreated: 0,
    namesRevealed: 0,
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

    /*
     * The scenes published in this batch, with the cast the reviewer accepted.
     *
     * Held until both the event loop and the assertion loop have run, because
     * the relation this turns into is one the model is *also* asked to write —
     * the prompt says « nommez ses acteurs dans participants et écrivez
     * participe à vers ce même identifiant ». Linking during the event loop
     * would therefore draw the compliant chapters twice, once from each source.
     * Linking afterwards means the derived edge is only ever the one that was
     * missing. See `linkCast`.
     */
    const cast: SceneCast[] = []

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
    const mergeInto = new Map<string, MergeTarget>()
    /** Fingerprints a merge was really applied to, for the resolution loop. */
    const merged = new Set<string>()
    /** Fingerprints a merge was refused for, and why — same loop, honest reason. */
    const refusedMerges = new Map<string, string>()
    for (const item of items) {
      if (item.category !== 'resolution') continue
      if (item.status !== 'proposed') continue
      const decision = byId.get(item.id)
      /*
       * 'correct' as well as 'accept', because the card has a second question.
       *
       * « Oui, c'est lui » and « oui, et c'est ici qu'on apprend son nom » are
       * the same answer about identity and different answers about naming, so
       * the second arrives the way every other edited answer does: as a
       * correction carrying the reviewer's flag. Reading only 'accept' here
       * would drop the flag on the floor and merge in silence.
       */
      if (decision?.decision !== 'accept' && decision?.decision !== 'correct') continue

      const payload = (item.payload ?? {}) as Record<string, unknown>
      const answer = (decision.correctedPayload ?? {}) as Record<string, unknown>
      const fingerprint = payload.candidateFingerprint
      const existingId = payload.existingEntityId
      if (typeof fingerprint !== 'string' || typeof existingId !== 'string') continue
      mergeInto.set(fingerprint, {
        entityId: existingId,
        revealsName: answer.revealsName === true,
      })
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

        /*
         * A merged name is a name on the fiche, so it is checked like one.
         *
         * The guard below the entity path has always covered a name the
         * publication *creates*; a name it folds onto a character reached the
         * graph unchecked, and « aussi appelé » on the fiche lists every label
         * the boundary lets through. Merging a chapter-23 proposal called
         * « Kuro » therefore printed Kuro at chapter 23 — under the right
         * name, in smaller type, three chapters early. Same rule, same
         * refusal, whichever door the name came in by.
         *
         * Refused whole rather than merged-without-the-name: the two halves of
         * this answer are one answer, and applying the half that is safe would
         * settle an identity question on the strength of a naming answer that
         * was just rejected. The card stays open and can be answered again.
         */
        if (candidate.label_kind === 'true_name') {
          const future = await nameRevealedLater(db, {
            userId,
            workId: run.workId,
            chapterNumber: run.chapterNumber,
            label: candidate.label,
            sourceTerm: candidate.source_term,
          })
          if (future) {
            const reason = futureNameReason(future)
            refusedMerges.set(item.fingerprint, reason)
            result.failures.push({ reviewItemId: item.id, reason })
            continue
          }
        }

        localToEntity.set(candidate.local_id, mergeTarget.entityId)

        /*
         * The one case where a merge is allowed to change what he is called.
         *
         * Limited to a true name, and to a reviewer who said so on the card.
         * See `addMergedLabel` for why every other merged label enters below
         * the displayed one.
         */
        const reveals = mergeTarget.revealsName && candidate.label_kind === 'true_name'

        const added = await addMergedLabel(db, {
          userId,
          entityId: mergeTarget.entityId,
          label: candidate.label,
          kind: candidate.label_kind,
          chapterNumber: run.chapterNumber,
          reveals,
        })
        if (added) result.labelsCreated++
        if (added && reveals) {
          result.namesRevealed++
          await db.insert(auditLog).values({
            userId,
            action: 'name_revealed',
            subjectKind: 'entity',
            subjectId: mergeTarget.entityId,
            detail: {
              label: candidate.label,
              revealedInChapter: run.chapterNumber,
              reviewItemId: item.id,
            },
          })
        }

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
       * A name that belongs to a chapter the reader has not reached.
       *
       * Here rather than at extraction, because this is where a naming answer
       * becomes a name: `correctedPayload` is what the review card was given
       * back, and the card asks for a French form while showing nothing about
       * when the reader is. Every mechanism upstream had already agreed —
       * the model proposed the source's own word, the evidence anchored, the
       * ontology was satisfied — and the substitution happened after all of
       * them. See `naming.ts` for why the answer is checkable at all.
       *
       * Refused rather than corrected. The card can be answered again, and
       * choosing a name on the reader's behalf is the one thing the naming
       * question exists to avoid.
       */
      if (candidate.label_kind === 'true_name') {
        const future = await nameRevealedLater(db, {
          userId,
          workId: run.workId,
          chapterNumber: run.chapterNumber,
          label: candidate.label,
          sourceTerm: candidate.source_term,
        })
        if (future) {
          result.failures.push({
            reviewItemId: item.id,
            reason: futureNameReason(future),
          })
          continue
        }
      }

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
        nodeTypes: [candidate.node_type],
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

        await recordPresence(db, {
          userId,
          entityId: twin,
          chapterId: run.chapterId,
          chapterNumber: run.chapterNumber,
          kind: candidate.presence ?? 'appearance',
          confidence: candidate.confidence,
        })

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

      await recordPresence(db, {
        userId,
        entityId: entity.id,
        chapterId: run.chapterId,
        chapterNumber: run.chapterNumber,
        kind: candidate.presence ?? 'appearance',
        confidence: candidate.confidence,
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

    /*
     * Events and mysteries are entities with a side table, per the schema.
     *
     * Before the assertions, not after them. An event is a node the ontology
     * lets a relation point at — « Zoro participe à <la destruction de la
     * maison> », `dies_at` an event — and a relation is resolved against
     * `localToEntity`, which the loop below fills. Published after, the event
     * did not exist yet when its own relations were written, and every one of
     * them failed with « son entité a été rejetée ou reportée » about a scene
     * the reviewer had just accepted.
     */
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

      /*
       * What the extraction said this was, not what category it arrived under.
       *
       * This line read `item.category === 'event' ? 'event' : 'mystery'`, and
       * the left-hand branch is where « Combat » went to die: every extracted
       * scene arrives under the category `event`, so every scene was published
       * as the node type `event`. « Combat » and « Voyage » had a key, a French
       * label, a description, a colour and a filter on the graph page, and no
       * code path anywhere could produce one. The filter was not returning
       * nothing because nothing had been detected — it was returning nothing
       * because the type was unreachable.
       *
       * `kind` is absent on every proposal queued before the extraction learnt
       * to state it, and those are not a closed set: a chapter processed
       * yesterday and reviewed tomorrow publishes through this line with
       * nothing to read. Defaulting them to `event` would keep making new
       * unreachable combats for as long as the queue holds one, so they fall
       * back to the same reading of the summary that migration 0022 applies to
       * what is already in the graph — one word list, in
       * `knowledge/occurrence.ts`, used by both.
       *
       * What the model said always wins. The fallback runs only where nobody
       * said anything.
       */
      const nodeType =
        item.category === 'event'
          ? occurrenceType((decision.correctedPayload ?? item.payload) as CandidateEvent)
          : 'mystery'

      /*
       * The same question, asked twice.
       *
       * An event and a mystery are entities with a side table, and this loop
       * created one unconditionally — the twin check added for the entity
       * category never reached here. Two slices proposing the same question, or
       * a re-import proposing it again, therefore produced two rows saying the
       * same words, and /mysteres showed « Qui est l'homme que Zoro
       * recherchait ? » twice, both opened at chapter 8.
       *
       * The label is what it is compared on, and for these two categories the
       * label *is* the text: an event is named by its summary, a mystery by its
       * question. So the check is the same one, on the same rule — exact
       * normalised label, same node type, at this chapter or before.
       */
      const payload = (decision.correctedPayload ?? item.payload) as
        | CandidateEvent
        | CandidateMystery
      const text =
        item.category === 'event'
          ? (payload as CandidateEvent).summary
          : (payload as CandidateMystery).question
      const label = text.slice(0, 200)

      /*
       * A scene is looked for under all three occurrence types, whichever one
       * this proposal turned out to be. The copy already in the graph predates
       * the classification and is an `event`; this one may be a `battle`, and
       * they are the same scene.
       */
      const twinTypes = item.category === 'event' ? OCCURRENCE_TYPES : ['mystery']

      const twin = await exactTwin(db, {
        workId: run.workId,
        userId,
        nodeTypes: twinTypes,
        label,
        chapterNumber: run.chapterNumber,
      })

      /*
       * The same scene, written twice.
       *
       * `exactTwin` above catches the identical re-proposal. It cannot catch
       * the one a second processing pass produces, because a model does not
       * phrase a scene identically twice — and each accepted copy becomes its
       * own entity, since an event *is* an entity here. Two nodes for one
       * scene, joined by nothing.
       *
       * Refused rather than merged: reusing the existing entity, as the exact
       * path does, would be deciding that two differently-worded texts are one
       * memory. Above ECHO_TOO_CLOSE the words are practically the same and
       * saying so costs nothing; below it, the card carries the resemblance and
       * the reviewer decides. Rejecting is a real way out, so this is a
       * question, not a dead end — the message has to say which.
       */
      if (twin === null) {
        const echo = await findEcho(db, {
          workId: run.workId,
          userId,
          nodeTypes: twinTypes,
          text: label,
          chapterNumber: run.chapterNumber,
        })

        if (echo !== null && echo.overlap >= ECHO_TOO_CLOSE) {
          result.failures.push({
            reviewItemId: item.id,
            reason:
              `Presque mot pour mot ce qui est déjà enregistré au chapitre ` +
              `${echo.chapterNumber} : « ${echo.label.slice(0, 120)} ». Publier les deux ` +
              `créerait deux fiches pour une seule scène. Rejetez celle-ci — ou reportez-la ` +
              `si les deux scènes sont bien distinctes.`,
          })
          continue
        }
      }

      if (twin !== null) {
        if (item.category === 'event') {
          const candidate = (decision.correctedPayload ?? item.payload) as CandidateEvent
          localToEntity.set(candidate.local_id, twin)
          const present = await recordParticipants(db, {
            userId,
            chapterId: run.chapterId,
            chapterNumber: run.chapterNumber,
            participants: candidate.participants,
            localToEntity,
            confidence: candidate.confidence,
          })
          cast.push({
            eventId: twin,
            reviewItemId: item.id,
            fingerprint: item.fingerprint,
            participants: present,
            evidence: candidate.evidence,
            confidence: candidate.confidence,
            corrected: decision.decision === 'correct',
          })
        }

        await db.insert(auditLog).values({
          userId,
          action: 'entity_reused',
          subjectKind: 'entity',
          subjectId: twin,
          detail: {
            label,
            nodeType,
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
          nodeType,
          firstSeenChapter: run.chapterNumber,
          reviewStatus: 'accepted',
          runId,
          // Provenance, like an entity's. It is what lets « Zoro participe à
          // <cette scène> » resolve, in this batch or in a later one.
          ...(item.category === 'event'
            ? {
                proposalLocalId:
                  ((decision.correctedPayload ?? item.payload) as CandidateEvent).local_id,
              }
            : {}),
        })
        .returning({ id: entities.id })

      if (!entity) {
        result.failures.push({ reviewItemId: item.id, reason: 'Création échouée.' })
        continue
      }

      if (item.category === 'event') {
        const candidate = (decision.correctedPayload ?? item.payload) as CandidateEvent
        localToEntity.set(candidate.local_id, entity.id)
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
          storyTime: storyTimeOf(candidate),
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

        /*
         * Who was in the scene, written down at last.
         *
         * `participants` has been in the extraction schema since it was
         * written, has been anchored and filtered on every run since, and was
         * then dropped on the floor here — an event reached the graph knowing
         * nobody. What it costs is the answer to the question the library is
         * for: « qu'est-ce que Nami fait au chapitre 14 » had nothing to read,
         * because the chapter's facts were events and no event named her.
         *
         * Recorded as presence — where someone was seen — and, since `linkCast`
         * below, as a relation too. Presence alone answered « où était Nami au
         * chapitre 14 » and nothing else: an occurrence names a chapter, not
         * the scene, so the graph still had no line between a scene and the
         * people in it. Both are kept because they answer different questions,
         * and one does not derive the other.
         */
        const present = await recordParticipants(db, {
          userId,
          chapterId: run.chapterId,
          chapterNumber: run.chapterNumber,
          participants: candidate.participants,
          localToEntity,
          confidence: candidate.confidence,
        })
        cast.push({
          eventId: entity.id,
          reviewItemId: item.id,
          fingerprint: item.fingerprint,
          participants: present,
          evidence: candidate.evidence,
          confidence: candidate.confidence,
          corrected: decision.decision === 'correct',
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
       * The two ends, once resolved, must still be two.
       *
       * The extraction refuses a relation whose two ends carry the same
       * identifier, and that is not the same check as this one. Here the
       * identifiers have been resolved, and resolution is where a loop is
       * *made*: a proposal joins an entity already in the graph by its
       * normalised label, so a question re-proposed in the chapter that answers
       * it becomes the very node the relation points at — two identifiers on the
       * card, one row underneath.
       *
       * Refused before the insert rather than left to the trigger, so the reason
       * reads in French and names the loop instead of arriving as a raised
       * exception the reviewer has to decode.
       */
      if (objectId !== null && objectId === subjectId) {
        result.failures.push({
          reviewItemId: item.id,
          reason:
            `« ${candidate.predicate} » relie cette entité à elle-même : ` +
            `les deux bouts désignent la même fiche. Une question ne se résout pas ` +
            `elle-même — le sujet doit être ce qui apporte la réponse, en général la scène.`,
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

      /*
       * A question the chapter answers stops being an open question.
       *
       * `résout le mystère` was publishable since the ontology was written, and
       * it went into `assertions` like any other edge and stopped there. The
       * question's own row kept `state = 'open'` and `resolved_in_chapter` null
       * for ever — so /mysteres, which decides open-or-closed by reading that
       * column, showed « Ouverte » next to a question the reader had watched
       * being answered, and « Refermées » was a heading that could never appear.
       * The read side was complete; nothing wrote.
       *
       * Here rather than in a sweep afterwards because it is the same fact: the
       * edge and the state are two ways of saying that this chapter answered
       * this question, and writing one without the other is what created the
       * disagreement in the first place.
       */
      const verdict = await applyMysteryVerdict(db, {
        userId,
        predicate: candidate.predicate,
        mysteryId: objectId,
        chapterNumber: run.chapterNumber,
      })
      if (verdict === 'resolved') result.mysteriesResolved++
      if (verdict === 'reopened') result.mysteriesReopened++

      await recordDecision(db, userId, run.workId, item, decision)
      await db
        .update(reviewItems)
        .set({ status: 'accepted' })
        .where(eq(reviewItems.id, item.id))
    }

    /*
     * A scene, joined to the people it happens to.
     *
     * Every relation loop above is over now, so what is written here is exactly
     * what the chapter did not already say. That ordering is the whole design:
     * the model is asked for « participe à » and sometimes gives it, and this
     * fills in the rest rather than competing with it.
     *
     * Until this ran, an event was a node of degree zero. Not a rare one — a
     * chapter imported as a written summary produces mostly events, so a library
     * of fifty chapters had several hundred scenes in it, each connected to
     * nothing, drawn as the halo of loose dots around the graph and reachable
     * from no character's fiche. The cast was known all along: the model states
     * it, anchoring filters it, the review card lists it and the reviewer
     * accepted it. It was recorded as presence — « Nami est au chapitre 14 » —
     * which cannot express « Nami est dans *cette* scène », because an
     * occurrence points at a chapter and never at the event.
     */
    for (const scene of cast) {
      result.assertionsCreated += await linkCast(db, {
        userId,
        workId: run.workId,
        runId,
        chapterId: run.chapterId,
        chapterNumber: run.chapterNumber,
        refTable: table,
        scene,
        failures: result.failures,
      })
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

        /*
         * The name is why it did not apply, when it is.
         *
         * Both halves of a refused merge produce a failure, and the entity's
         * carries the real reason — a name from a chapter the reader has not
         * reached. Letting this one say « déjà décidée dans un lot précédent »
         * next to it would be two contradictory explanations of one refusal,
         * and the wrong one is the one telling the reviewer to give up.
         */
        const refused = refusedMerges.get(fingerprint)
        if (refused !== undefined) {
          result.failures.push({
            reviewItemId: item.id,
            reason:
              `Le rapprochement n’a pas été appliqué, à cause du nom. ${refused} ` +
              'Corrigez le nom sur la carte d’entité, ou répondez le rapprochement ' +
              'sans « on apprend son nom ici ».',
          })
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
    /*
     * The chapter is read off the run, not off its proposals.
     *
     * This asked `review_items` which chapter the run was about, which answers
     * for every run that queued something and answers *nothing* for the one
     * case where the question matters most: a run whose extraction proposed
     * only things already decided under the same fingerprint re-applies those
     * decisions and queues no card at all. No row, no chapter id, no opening —
     * a chapter that had asked nothing stayed in review for ever, and a lot
     * chaining on openings stopped dead on it.
     */
    const [run] = await db
      .select({ chapterId: ingestionRuns.chapterId })
      .from(ingestionRuns)
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.userId, userId)))
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
/**
 * Carry an accepted `résout le mystère` into the question's own row.
 *
 * The two predicates are the only ones whose acceptance changes something other
 * than the graph, and the rule for each is about *dates*, not about the latest
 * word winning:
 *
 *   Resolving records the earliest chapter that answers the question. A second
 *   chapter saying the same thing does not push the answer later — the reader
 *   learned it the first time — so a resolution already recorded at or before
 *   this chapter is left alone. Re-importing a chapter therefore writes the same
 *   value it wrote before, which is what makes publication idempotent here too.
 *
 *   Re-opening clears a resolution *this chapter invalidates*, meaning one dated
 *   at or before it. A resolution recorded later is a different, later answer
 *   and survives: « on croyait savoir au 40, on rouvre au 60, on répond au 80 »
 *   must not lose the chapter-80 answer because the chapter-60 card was
 *   published afterwards.
 *
 * Returns null when the object is not a question at all. The database trigger
 * already refuses `résout le mystère` towards anything but a mystery, so that
 * case means the row was deleted between the insert and here — nothing to write,
 * and nothing worth failing a publication over.
 */
async function applyMysteryVerdict(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    predicate: string
    mysteryId: string | null
    chapterNumber: number
  },
): Promise<'resolved' | 'reopened' | null> {
  if (input.mysteryId === null) return null
  if (input.predicate !== 'resolves_mystery' && input.predicate !== 'reopens_mystery') {
    return null
  }

  const [current] = await db
    .select({ resolvedInChapter: mysteries.resolvedInChapter })
    .from(mysteries)
    .where(and(eq(mysteries.entityId, input.mysteryId), eq(mysteries.userId, input.userId)))
    .limit(1)

  if (!current) return null

  const recorded = current.resolvedInChapter

  if (input.predicate === 'resolves_mystery') {
    if (recorded !== null && recorded <= input.chapterNumber) return null
    await db
      .update(mysteries)
      .set({ state: 'resolved', resolvedInChapter: input.chapterNumber })
      .where(eq(mysteries.entityId, input.mysteryId))
    return 'resolved'
  }

  if (recorded === null || recorded > input.chapterNumber) return null
  await db
    .update(mysteries)
    .set({ state: 'reopened', resolvedInChapter: null })
    .where(eq(mysteries.entityId, input.mysteryId))
  return 'reopened'
}

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
 * Add the name a merged proposal came in under.
 *
 * Chapter 3 calls him « Zoro » and you settled on « Roronoa Zoro » at chapter
 * 2. Both are names of the same person and the graph should know both — a
 * reader searching either must find him — but the one you settled is the one he
 * is called, and a merge must never quietly change a displayed name behind the
 * reviewer's back. So the new label enters strictly below the entity's current
 * highest precedence, whatever kind it claims to be, and the display is
 * unmoved.
 *
 * `reveals` is the exception, and it is the reason this parameter exists rather
 * than a second function. The butler is Klahadore for three chapters and Kuro
 * from the 26th, and in a work of a thousand chapters that is not an edge case
 * — it is Bon Clay, Robin, Sabo, Hancock, every impostor and every alias in the
 * book. Without it the graph could only be told the new name as a footnote
 * below the old one, and « Klahadore » stayed on the fiche for the rest of the
 * story. With it the reader who answered « oui, et c'est ici qu'on apprend son
 * nom » gets the label at its own precedence, which for a true name is above
 * everything: the fiche says Kuro from chapter 26 and Klahadore at 25, and the
 * slider still moves both ways because nothing was overwritten.
 *
 * Only ever set for a `true_name`, decided by the caller. `naming.ts` has the
 * argument in full: a placeholder is a description, an epithet and an alias are
 * other things he is also called, and the true name is the only one whose
 * arrival is a revelation.
 *
 * Its revelation chapter is the chapter that used it, like every other label:
 * a name is dated by when it was heard, and « Zoro » being known from chapter 3
 * is exactly the sort of thing the boundary exists to keep straight.
 *
 * Returns whether a row was written — a name already on the entity is not a
 * failure, it is the ordinary case of a character named twice.
 */
/**
 * The node type an extracted scene becomes.
 *
 * Stated by the extraction when it could be; read from the summary when the
 * proposal predates the field. Never guesses a `voyage` — see
 * `classifyOccurrence` for why the departure vocabulary has no prudent list.
 */
export function occurrenceType(candidate: CandidateEvent): OccurrenceKind {
  return candidate.kind ?? classifyOccurrence(candidate.summary)
}

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
 *
 * Several types rather than one, because an occurrence has three of them. The
 * same scene re-proposed after this change is a `battle` where the copy already
 * in the graph is an `event` — every scene published before the extraction
 * could classify one is. Looking under a single type would miss it and write
 * the second node, which is precisely the duplicate this check exists to
 * prevent, introduced by the fix for something else.
 */
async function exactTwin(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    workId: string
    userId: string
    nodeTypes: readonly string[]
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
        inArray(entities.nodeType, [...input.nodeTypes]),
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

/**
 * Seen, or merely spoken of, at this chapter.
 *
 * `occurrence_kind` has carried the distinction since the schema was written
 * and publication derived it from the *medium* of the evidence — a drawing was
 * an appearance, text a mention. True of scanned pages, meaningless the day a
 * chapter became prose: everything is text, so everything was a mention. The
 * proposal says it now, because only the model reading the passage can tell
 * « Koby parle de Zoro » from « Zoro dégaine ».
 *
 * Written for the entity itself rather than only for the relations it takes
 * part in: a character can be named by a chapter and take part in nothing, and
 * that is precisely the case this exists to record.
 *
 * Checked before inserting because `occurrences` has no unique index — the
 * `onConflictDoNothing` elsewhere in this file has never had a conflict to
 * catch, and publishing twice would stack rows.
 */
async function recordPresence(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    entityId: string
    chapterId: string
    chapterNumber: number
    kind: 'appearance' | 'mention'
    confidence: number
  },
): Promise<void> {
  const [existing] = await db
    .select({ id: occurrences.id })
    .from(occurrences)
    .where(
      and(
        eq(occurrences.entityId, input.entityId),
        eq(occurrences.chapterId, input.chapterId),
        eq(occurrences.kind, input.kind),
        eq(occurrences.stated, true),
      ),
    )
    .limit(1)

  if (existing) return

  await db.insert(occurrences).values({
    entityId: input.entityId,
    userId: input.userId,
    chapterId: input.chapterId,
    kind: input.kind,
    stated: true,
    chapterNumber: input.chapterNumber,
    confidence: input.confidence,
  })
}

/**
 * The cast of one scene, recorded as having been there.
 *
 * An event's participants are given as identifiers, and which kind depends on
 * when the entity was published: a local id like `e3` for someone this same
 * run proposed, a UUID for someone already in the graph. `localToEntity`
 * answers the first, and the events loop runs after the entities one so the
 * answer is there.
 *
 * `appearance`, not `mention`. An event is a thing that happens on the page and
 * its participants are the people it happens to — « Koby parle de Zoro » is not
 * an event with Zoro in it, it is a relation, and the model has `mentions` for
 * that. An identifier that resolves to nothing is skipped in silence: it means
 * the participant's own proposal was rejected or deferred, which the reviewer
 * decided on purpose and does not need told twice.
 *
 * Returns the entity ids it resolved, deduplicated, so `linkCast` draws the
 * same cast this recorded rather than resolving the identifiers a second time
 * and risking a different answer.
 */
async function recordParticipants(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    chapterId: string
    chapterNumber: number
    participants: string[]
    localToEntity: Map<string, string>
    confidence: number
  },
): Promise<string[]> {
  const seen = new Set<string>()

  for (const participant of input.participants) {
    const entityId = input.localToEntity.get(participant) ?? participant
    if (!isUuid(entityId) || seen.has(entityId)) continue
    seen.add(entityId)

    await recordPresence(db, {
      userId: input.userId,
      entityId,
      chapterId: input.chapterId,
      chapterNumber: input.chapterNumber,
      kind: 'appearance',
      confidence: input.confidence,
    })
  }

  return [...seen]
}

/** One published scene and the cast the reviewer accepted with it. */
interface SceneCast {
  eventId: string
  reviewItemId: string
  fingerprint: string | null
  /** Already resolved to entity ids by `recordParticipants`. */
  participants: string[]
  evidence: EvidenceRef[]
  confidence: number
  /** True when the reviewer edited the proposal rather than accepting it. */
  corrected: boolean
}

/**
 * Which relation says « this entity was in this scene ».
 *
 * Read off the ontology rather than assumed, because `participants` is a flat
 * list of whoever the passage put in the scene and the ontology does not accept
 * them all on the same predicate. Two answers, both of which the type trigger
 * would accept:
 *
 *   • an actor — a character or a group — *takes part*: `participates_in`,
 *     pointing from them at the scene, which is the direction the fiche reads
 *     to fill its « Participants » section.
 *   • a place *is where it happened*: `located_at`, pointing from the scene at
 *     the place, since that is the direction the ontology gives it.
 *
 * Anything else gets no edge. A fruit, a species or a mystery listed among the
 * participants is not wrong of the model — the scene really is about them — but
 * no predicate in the ontology carries "an object was involved in an event",
 * and inventing one here would be adding to the ontology from inside a
 * publication loop. The presence row is still written, so nothing is lost, and
 * `mentions` remains available to the extraction for saying it properly.
 */
function participationLink(
  eventId: string,
  participantId: string,
  nodeType: string,
): { subject: string; predicate: string; object: string } | null {
  if (nodeType === 'character' || nodeType === 'group') {
    return { subject: participantId, predicate: 'participates_in', object: eventId }
  }
  if (nodeType === 'place') {
    return { subject: eventId, predicate: 'located_at', object: participantId }
  }
  return null
}

/**
 * Draw the accepted cast of one scene as relations.
 *
 * Nothing here decides anything. The participants are the ones the reviewer saw
 * listed on the card and accepted, resolved to entities a moment ago; this only
 * writes down, in the shape the graph reads, what accepting that card meant.
 * That is why it is `explicit` and not an inference: the extraction stated who
 * was in the scene, in the same answer that stated the scene.
 *
 * Skips a pair the graph already carries, whatever chapter it came from. The
 * duplicate this prevents is the ordinary case rather than the exotic one — the
 * model is asked for « participe à » and often supplies it, a chapter can be
 * published in several batches, and a re-import re-proposes the same scene.
 * Assertions are append-only, so a duplicate written here could not be taken
 * back.
 *
 * A refused edge is contained by a savepoint and reported, exactly as in the
 * assertion loop: one participant the ontology will not take must not cost the
 * chapter its publication.
 */
async function linkCast(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    workId: string
    runId: string
    chapterId: string
    chapterNumber: number
    refTable: RefTable
    scene: SceneCast
    failures: PublishResult['failures']
  },
): Promise<number> {
  const { scene } = input
  const ids = scene.participants.filter((id) => id !== scene.eventId)
  if (ids.length === 0) return 0

  const rows = await db
    .select({ id: entities.id, nodeType: entities.nodeType })
    .from(entities)
    .where(and(eq(entities.userId, input.userId), inArray(entities.id, ids)))

  let created = 0

  for (const row of rows) {
    const link = participationLink(scene.eventId, row.id, row.nodeType)
    if (link === null) continue

    const [already] = await db
      .select({ id: assertions.id })
      .from(assertions)
      .where(
        and(
          eq(assertions.userId, input.userId),
          eq(assertions.subjectEntityId, link.subject),
          eq(assertions.predicate, link.predicate),
          eq(assertions.objectEntityId, link.object),
        ),
      )
      .limit(1)

    if (already) continue

    try {
      await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(assertions)
          .values({
            workId: input.workId,
            userId: input.userId,
            subjectEntityId: link.subject,
            predicate: link.predicate,
            objectEntityId: link.object,
            knowledgeFromChapter: input.chapterNumber,
            observedInChapter: input.chapterNumber,
            confidence: scene.confidence,
            epistemicStatus: scene.corrected ? 'user_validated' : 'explicit',
            reviewStatus: 'accepted',
            proposedBy: scene.corrected ? 'user' : 'ai',
            locked: scene.corrected,
            pipelineVersion: PIPELINE_VERSION,
            promptVersion: PROMPT_VERSION,
            runId: input.runId,
            proposalFingerprint: scene.fingerprint,
          })
          .returning({ id: assertions.id })

        if (!inserted) throw new Error('Insertion échouée.')

        /*
         * The scene's own citation, carried onto the link.
         *
         * An event proposal's evidence had nowhere to live until now — the
         * `evidence` table hangs off an assertion — so this is the first row
         * that makes a scene traceable to the passage it was read from. Inside
         * the savepoint with the assertion, because an assertion whose citation
         * failed to write is precisely the unsourced row this system claims not
         * to have.
         */
        await insertEvidence(tx, {
          assertionId: inserted.id,
          userId: input.userId,
          chapterId: input.chapterId,
          refs: scene.evidence,
          refTable: input.refTable,
        })
      })
      created++
    } catch (error: unknown) {
      input.failures.push({
        reviewItemId: scene.reviewItemId,
        reason: refusalReason(error),
      })
    }
  }

  return created
}

async function addMergedLabel(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    entityId: string
    label: string
    kind: string
    chapterNumber: number
    /** The chapter teaches this name: let it outrank what he was called. */
    reveals?: boolean
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
  /*
   * A revealed name keeps its own precedence; every other one is capped below
   * what the entity is currently called.
   *
   * Two true names then sit at 100 together — « Klahadore » from chapter 23 and
   * « Kuro » from chapter 26 — and the tie is broken by revelation chapter, the
   * `ORDER BY precedence DESC, revealed_in_chapter DESC` every display in this
   * codebase shares. Which is the right rule and not a lucky one: of two names
   * the reader has read, the one he was told last is the one in use.
   */
  const precedence = input.reveals
    ? precedenceFor(input.kind)
    : Math.max(1, Math.min(precedenceFor(input.kind), highest - 1))

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

/**
 * The proposal's dating, turned into the union the column stores.
 *
 * Two shapes in, three out — and the third is the interesting one. A proposal
 * that says `approximate` without a number has no distance in it, only an
 * ordering, so it is stored as `relative`: « avant l'exécution de Roger » is a
 * true statement about order and a false one about years, and `approximate`
 * with no `yearsAgo` would sort as though it were the latter.
 *
 * A missing dating is stored as null and never as `{ kind: 'unknown' }`. The
 * union carries that member for rows written before this field existed; writing
 * it now would say « the chapter addressed this and gave no answer », which is
 * not what an absent field means.
 */
function storyTimeOf(candidate: CandidateEvent): StoryTime | null {
  const time = candidate.story_time
  if (time === null || time === undefined) return null

  if (time.kind === 'approximate' && typeof time.years_ago === 'number') {
    return { kind: 'approximate', description: time.description, yearsAgo: time.years_ago }
  }
  return { kind: 'relative', note: time.description }
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
