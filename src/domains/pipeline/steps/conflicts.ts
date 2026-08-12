import 'server-only'
import { and, eq, isNull, lte, or } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import { assertions, entityLabels, predicates } from '@/db/schema/knowledge.ts'
import type { CandidateAssertion } from '@/domains/ai/schemas.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * Confront each proposal with what has already been accepted.
 *
 * A contradiction is not an error to suppress — it is the most interesting thing
 * the pipeline can find. When chapter 40 says something chapter 12 denied, the
 * correct outcome is *both* records surviving, with the earlier one's knowledge
 * window closed at 40. That is how "the reader believed X until chapter 40"
 * becomes queryable, and it is the difference between a knowledge graph and a
 * wiki that overwrites its own past.
 *
 * So this step never resolves anything. It finds the collisions, explains them,
 * and routes them to explicit review with both sides shown. The user decides
 * which is a correction, which is a genuine change in the world, and which is a
 * character lying.
 *
 * No model involved: a contradiction between two stored assertions is a
 * structural fact, and paying to be told about it would be strange.
 */

export async function runConflicts(context: StepContext): Promise<StepResult> {
  const { userId, chapterId, chapterNumber, runId } = context

  const world = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ workId: chapters.workId })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const proposals = await db
      .select({
        id: reviewItems.id,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
        confidence: reviewItems.confidence,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          eq(reviewItems.category, 'assertion'),
          eq(reviewItems.status, 'proposed'),
        ),
      )

    /*
     * Only assertions the reader could already hold.
     *
     * A proposal cannot contradict something revealed later — from the reader's
     * position that later fact does not exist yet, and flagging the collision
     * would put a future revelation in the review queue as the explanation for
     * a present one. Which is a spoiler delivered by the anti-spoiler system.
     */
    const accepted = await db
      .select({
        id: assertions.id,
        subject: assertions.subjectEntityId,
        predicate: assertions.predicate,
        object: assertions.objectEntityId,
        objectValue: assertions.objectValue,
        knowledgeFrom: assertions.knowledgeFromChapter,
        epistemicStatus: assertions.epistemicStatus,
      })
      .from(assertions)
      .where(
        and(
          eq(assertions.workId, chapter.workId),
          eq(assertions.userId, userId),
          eq(assertions.reviewStatus, 'accepted'),
          lte(assertions.knowledgeFromChapter, chapterNumber),
          // Beliefs already closed by a later chapter are history, not a live
          // claim to contradict.
          or(
            isNull(assertions.knowledgeUntilChapter),
            lte(assertions.knowledgeUntilChapter, chapterNumber),
          ),
        ),
      )

    const functional = await db
      .select({ key: predicates.key, isSymmetric: predicates.isSymmetric })
      .from(predicates)

    const labels = await db
      .select({ entityId: entityLabels.entityId, label: entityLabels.label })
      .from(entityLabels)
      .where(
        and(
          lte(entityLabels.revealedInChapter, chapterNumber),
          eq(entityLabels.lang, 'fr'),
        ),
      )

    return { workId: chapter.workId, proposals, accepted, functional, labels }
  })

  if (world.proposals.length === 0) {
    return { note: 'Aucune assertion proposée à confronter.', status: 'skipped' }
  }

  const labelOf = new Map<string, string>()
  for (const label of world.labels) {
    if (!labelOf.has(label.entityId)) labelOf.set(label.entityId, label.label)
  }

  const conflicts: Array<{
    proposal: CandidateAssertion
    proposalFingerprint: string
    against: (typeof world.accepted)[number]
    kind: ConflictKind
    explanation: string
  }> = []

  for (const item of world.proposals) {
    const proposal = item.payload as CandidateAssertion

    for (const existing of world.accepted) {
      const conflict = detectConflict(proposal, existing)
      if (!conflict) continue

      conflicts.push({
        proposal,
        proposalFingerprint: item.fingerprint,
        against: existing,
        kind: conflict.kind,
        explanation: conflict.explain(
          labelOf.get(existing.subject) ?? existing.subject,
          existing.knowledgeFrom,
          chapterNumber,
        ),
      })
    }
  }

  if (conflicts.length === 0) {
    return { note: `${world.proposals.length} propositions, aucune contradiction.` }
  }

  await withIngest(async (db) => {
    await db.insert(reviewItems).values(
      conflicts.map((conflict) => ({
        runId,
        chapterId,
        userId,
        category: 'conflict',
        // Above ordinary assertions: a contradiction left undecided makes every
        // later reading of that fact ambiguous.
        priority: 85,
        payload: {
          proposal: conflict.proposal,
          proposalFingerprint: conflict.proposalFingerprint,
          conflictsWithAssertionId: conflict.against.id,
          conflictsWithPredicate: conflict.against.predicate,
          conflictsWithSince: conflict.against.knowledgeFrom,
          kind: conflict.kind,
          explanation: conflict.explanation,
          /*
           * The three outcomes, spelled out for the review UI. Naming them here
           * rather than in the interface keeps the vocabulary consistent between
           * what the pipeline detected and what the user is asked.
           */
          options: [
            {
              key: 'correction',
              label: "Le chapitre corrige une erreur : fermer l'ancienne assertion",
            },
            {
              key: 'evolution',
              label: 'Le monde a changé : les deux sont vraies à des moments différents',
            },
            {
              key: 'unreliable',
              label: 'Un personnage mentait ou se trompait : garder les deux comme croyances',
            },
          ],
        },
        // Never bulk-acceptable. A contradiction resolved by a threshold is a
        // decision about the story made by arithmetic.
        proposalFingerprint: `conflict:${conflict.proposalFingerprint}:${conflict.against.id}`,
        requiresExplicitReview: true,
        confidence: 0,
      })),
    )
  })

  return {
    note:
      `${conflicts.length} contradiction(s) avec des assertions déjà acceptées — ` +
      `à trancher explicitement`,
  }
}

type ConflictKind = 'same_predicate_different_object' | 'explicit_refutation' | 'death_after_action'

interface Conflict {
  kind: ConflictKind
  explain: (subjectLabel: string, since: number, now: number) => string
}

/**
 * Does a proposal collide with an accepted assertion?
 *
 * Three shapes, and the list is deliberately short. A broad conflict detector
 * flags everything and trains the user to dismiss the category, which costs more
 * than missing a subtle collision — the review queue only works while the things
 * in it are worth reading.
 */
function detectConflict(
  proposal: CandidateAssertion,
  existing: {
    subject: string
    predicate: string
    object: string | null
    objectValue: unknown
  },
): Conflict | null {
  const sameSubject = proposal.subject === existing.subject
  if (!sameSubject) return null

  // A refutation predicate aimed at the same subject is a contradiction by
  // construction — that is what the predicate means.
  if (
    proposal.predicate === 'refutes' ||
    proposal.predicate === 'contradicts'
  ) {
    return {
      kind: 'explicit_refutation',
      explain: (label, since, now) =>
        `Le chapitre ${now} réfute explicitement ce qui était établi à propos de ` +
        `« ${label} » depuis le chapitre ${since}.`,
    }
  }

  /*
   * Acting after dying.
   *
   * Worth its own case because the ordinary object comparison misses it: the
   * predicates differ, so nothing structural marks the pair. And in this work
   * specifically, an apparent death that is later contradicted is a recurring
   * device — which makes the flag valuable rather than pedantic.
   */
  if (existing.predicate === 'dies_at' && ACTION_PREDICATES.has(proposal.predicate)) {
    return {
      kind: 'death_after_action',
      explain: (label, since, now) =>
        `« ${label} » est mort selon le chapitre ${since}, mais le chapitre ${now} le montre ` +
        `encore actif. Soit la mort n'était qu'apparente, soit l'un des deux passages est ` +
        `un souvenir ou un récit.`,
    }
  }

  if (proposal.predicate !== existing.predicate) return null

  /*
   * Same subject, same predicate, different object — but only for predicates
   * that admit one answer.
   *
   * `member_of` legitimately holds several times over; `dies_at` does not. Only
   * the second kind is a contradiction, and treating the first as one would
   * flood the queue with every character who belongs to two groups.
   */
  if (!SINGLE_VALUED.has(proposal.predicate)) return null

  const proposalObject = normalizeText(
    proposal.object ?? proposal.object_value ?? '',
  )
  const existingObject = normalizeText(
    existing.object ?? String(existing.objectValue ?? ''),
  )

  if (proposalObject.length === 0 || existingObject.length === 0) return null
  if (proposalObject === existingObject) return null

  return {
    kind: 'same_predicate_different_object',
    explain: (label, since, now) =>
      `Le chapitre ${now} donne une valeur différente pour « ${proposal.predicate} » ` +
      `à propos de « ${label} », établie autrement depuis le chapitre ${since}.`,
  }
}

/**
 * Predicates that admit exactly one answer at a time.
 *
 * Everything else can hold several times over without contradiction — a person
 * belongs to two groups, knows many people, visits many places.
 */
const SINGLE_VALUED = new Set([
  'dies_at',
  'parent_of',
  'child_of',
  'belongs_to_species',
  'leads',
])

/** Predicates that imply the subject is present and acting. */
const ACTION_PREDICATES = new Set([
  'fights',
  'speaks_to',
  'meets',
  'travels_to',
  'travels_from',
  'captures',
  'protects',
  'creates',
  'destroys',
  'promises',
  'seeks',
])
