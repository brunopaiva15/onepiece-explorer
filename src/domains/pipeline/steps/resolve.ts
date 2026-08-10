import 'server-only'
import { and, eq, lte, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import { assertions, entities, entityLabels } from '@/db/schema/knowledge.ts'
import { proposalFingerprint } from '@/domains/ai/anchoring.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import type { CandidateEntity } from '@/domains/ai/schemas.ts'
import {
  LIKELY_SAME,
  scoreResolution,
  WORTH_CHECKING,
  type ResolutionScore,
} from '@/domains/resolution/scoring.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * Match newly proposed entities against ones already in the graph.
 *
 * Two stages, and the split is about cost. Trigram blocking in Postgres narrows
 * thousands of entities to a handful for the price of an index scan; only then
 * is anything scored, and only the genuinely ambiguous cases reach a model.
 * Scoring every pair would be quadratic and would spend an escalation budget on
 * comparisons that a similarity index answers for free.
 *
 * What comes out is never a merge. It is a `maybe_same_as` proposal carrying its
 * own reasoning, queued for explicit review. A merge, when the user makes one,
 * is itself an assertion dated to the chapter that revealed it — which is what
 * makes it reversible and what keeps the chapter-20 view showing two people.
 */

/** Trigram floor for the blocking query. Below this, not worth scoring. */
const TRIGRAM_FLOOR = 0.25
/** Candidates per proposal, after blocking. */
const MAX_CANDIDATES = 8

export async function runResolve(context: StepContext): Promise<StepResult> {
  const { userId, chapterId, chapterNumber, runId } = context

  const pending = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ workId: chapters.workId })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const items = await db
      .select({
        id: reviewItems.id,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          eq(reviewItems.category, 'entity'),
          eq(reviewItems.status, 'proposed'),
        ),
      )

    return { workId: chapter.workId, items }
  })

  if (pending.items.length === 0) {
    return { note: 'Aucune nouvelle entité à rapprocher.', status: 'skipped' }
  }

  const provider = modelProvider()
  let scored = 0
  let queued = 0
  let escalated = 0
  let costCents = 0
  let modelId: string | undefined

  for (const item of pending.items) {
    const candidate = item.payload as CandidateEntity

    const blocked = await blockByTrigram(
      userId,
      pending.workId,
      candidate,
      chapterNumber,
    )
    if (blocked.length === 0) continue

    const scores = blocked
      .map((existing) =>
        scoreResolution({
          candidate: {
            label: candidate.label,
            isPlaceholder: candidate.label_kind === 'placeholder',
            nodeType: candidate.node_type,
          },
          existing: {
            id: existing.id,
            label: existing.label,
            isPlaceholder: existing.labelKind === 'placeholder',
            nodeType: existing.nodeType,
            firstSeenChapter: existing.firstSeenChapter,
          },
          candidateChapter: chapterNumber,
          candidateDescriptors: descriptorsFor(candidate),
          existingDescriptors: existing.descriptors,
          candidateNeighbours: [],
          existingNeighbours: existing.neighbours,
        }),
      )
      .sort((a, b) => b.total - a.total)

    scored += scores.length

    const worth = scores.filter((score) => score.total >= WORTH_CHECKING)
    if (worth.length === 0) continue

    /*
     * Escalate only the ambiguous band.
     *
     * A score above LIKELY_SAME already has enough corroborating signal to put
     * in front of a human with a recommendation; below WORTH_CHECKING there is
     * nothing to discuss. The middle is where a model's reading of the art adds
     * something the weights cannot, and it is a small fraction of comparisons.
     */
    const ambiguous = worth.filter((score) => score.total < LIKELY_SAME)
    const modelVerdicts = new Map<string, { verdict: string; reasoning: string }>()

    if (ambiguous.length > 0) {
      const existingById = new Map(blocked.map((e) => [e.id, e]))
      const result = await provider.resolve({
        chapterNumber,
        candidate: {
          label: candidate.label,
          nodeType: candidate.node_type,
          description: descriptorsFor(candidate).join(' ; '),
        },
        existing: ambiguous.map((score) => {
          const existing = existingById.get(score.entityId)!
          return {
            id: existing.id,
            label: existing.label,
            nodeType: existing.nodeType,
            firstSeenChapter: existing.firstSeenChapter,
            description: existing.descriptors.join(' ; '),
          }
        }),
      })

      costCents += result.usage.costCents
      modelId = result.usage.modelId
      escalated += ambiguous.length

      if (!result.refusal) {
        for (const verdict of result.value.candidates) {
          modelVerdicts.set(verdict.existing_entity_id, {
            verdict: verdict.verdict,
            reasoning: verdict.reasoning,
          })
        }
      }
    }

    await withIngest(async (db) => {
      const rows = worth.slice(0, MAX_CANDIDATES).map((score) => {
        const opinion = modelVerdicts.get(score.entityId)
        const payload = {
          candidateLabel: candidate.label,
          candidateFingerprint: item.fingerprint,
          existingEntityId: score.entityId,
          score: score.total,
          suggestion: score.suggestion,
          // Every signal keeps its own sentence. A single number tells the user
          // nothing they can check; the sentences are what make the decision
          // reviewable rather than an act of faith in a threshold.
          signals: score.signals,
          modelVerdict: opinion?.verdict ?? null,
          modelReasoning: opinion?.reasoning ?? null,
          evidence: candidate.evidence,
        }

        return {
          runId,
          chapterId,
          userId,
          category: 'resolution',
          // Identity sits at the top of the queue: its mistakes are the ones
          // that quietly rewrite the past.
          priority: 95,
          payload,
          proposalFingerprint: proposalFingerprint({
            kind: 'assertion',
            subject: item.fingerprint,
            predicate: 'maybe_same_as',
            object: score.entityId,
            evidence: candidate.evidence,
          }),
          // Always. No score routes an identity past a human.
          requiresExplicitReview: true,
          confidence: score.total,
        }
      })

      if (rows.length > 0) {
        await db.insert(reviewItems).values(rows)
        queued += rows.length
      }
    })
  }

  const parts = [`${scored} comparaisons`, `${queued} rapprochements à trancher`]
  if (escalated > 0) parts.push(`${escalated} arbitrés par un modèle`)
  if (queued === 0) parts.push('aucune ambiguïté détectée')

  return {
    note: parts.join(' · '),
    costCents,
    ...(modelId ? { modelId } : {}),
  }
}

interface BlockedEntity {
  id: string
  label: string
  labelKind: string
  nodeType: string
  firstSeenChapter: number
  descriptors: string[]
  neighbours: string[]
}

/**
 * Narrow the field with a trigram index before scoring anything.
 *
 * `pg_trgm` on the normalised label turns "which of my four thousand entities
 * might this be" into an index scan. The alternative — scoring every entity — is
 * quadratic in the size of the graph and gets slower with every chapter
 * imported, which is the wrong direction for a tool meant to be used across
 * hundreds of them.
 *
 * The chapter filter is not an optimisation. Comparing against an entity the
 * reader has not met would let a chapter-3 figure be matched to a chapter-300
 * one, and the proposal alone — sitting in the review queue, naming a character
 * from the future — is already the spoiler.
 */
async function blockByTrigram(
  userId: string,
  workId: string,
  candidate: CandidateEntity,
  chapterNumber: number,
): Promise<BlockedEntity[]> {
  const normalised = normalizeText(candidate.label)

  return withIngest(async (db) => {
    const rows = await db
      .select({
        id: entities.id,
        label: entityLabels.label,
        labelKind: entityLabels.kind,
        nodeType: entities.nodeType,
        firstSeenChapter: entities.firstSeenChapter,
        similarity: sql<number>`similarity(${entityLabels.normalizedLabel}, ${normalised})`,
      })
      .from(entityLabels)
      .innerJoin(entities, eq(entities.id, entityLabels.entityId))
      .where(
        and(
          eq(entities.workId, workId),
          eq(entities.userId, userId),
          eq(entities.nodeType, candidate.node_type),
          eq(entities.reviewStatus, 'accepted'),
          lte(entities.firstSeenChapter, chapterNumber),
          lte(entityLabels.revealedInChapter, chapterNumber),
          sql`similarity(${entityLabels.normalizedLabel}, ${normalised}) >= ${TRIGRAM_FLOOR}`,
        ),
      )
      .orderBy(sql`similarity(${entityLabels.normalizedLabel}, ${normalised}) DESC`)
      .limit(MAX_CANDIDATES * 2)

    const results: BlockedEntity[] = []
    for (const row of rows) {
      if (results.some((r) => r.id === row.id)) continue
      results.push({
        id: row.id,
        label: row.label,
        labelKind: row.labelKind,
        nodeType: row.nodeType,
        firstSeenChapter: row.firstSeenChapter,
        descriptors: await descriptorsForEntity(db, row.id, chapterNumber),
        neighbours: await neighboursOf(db, row.id, chapterNumber),
      })
    }
    return results.slice(0, MAX_CANDIDATES)
  })
}

/** Every label visible at this chapter, as the entity's visual signature. */
async function descriptorsForEntity(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  entityId: string,
  chapterNumber: number,
): Promise<string[]> {
  const rows = await db
    .select({ label: entityLabels.label })
    .from(entityLabels)
    .where(
      and(
        eq(entityLabels.entityId, entityId),
        lte(entityLabels.revealedInChapter, chapterNumber),
      ),
    )
  return rows.map((row) => row.label)
}

/**
 * Who this entity appears alongside, as far as the reader knows.
 *
 * The chapter filter matters here too: an entity's entourage as of chapter 300
 * is not evidence available at chapter 3, and using it would smuggle future
 * knowledge into a present-tense decision.
 */
async function neighboursOf(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  entityId: string,
  chapterNumber: number,
): Promise<string[]> {
  const rows = await db
    .select({
      subject: assertions.subjectEntityId,
      object: assertions.objectEntityId,
    })
    .from(assertions)
    .where(
      and(
        eq(assertions.reviewStatus, 'accepted'),
        lte(assertions.knowledgeFromChapter, chapterNumber),
        sql`(${assertions.subjectEntityId} = ${entityId} OR ${assertions.objectEntityId} = ${entityId})`,
      ),
    )
    .limit(50)

  const neighbours = new Set<string>()
  for (const row of rows) {
    if (row.subject !== entityId) neighbours.add(row.subject)
    if (row.object && row.object !== entityId) neighbours.add(row.object)
  }
  return [...neighbours]
}

/**
 * Visual descriptors for a proposal.
 *
 * A placeholder label *is* a visual descriptor — "l'homme au foulard rayé" is
 * exactly what the vision step saw. A real name is not, so it contributes
 * nothing here and lets the name signal carry that weight alone.
 */
function descriptorsFor(candidate: CandidateEntity): string[] {
  return candidate.label_kind === 'placeholder' ? [candidate.label] : []
}

export { type ResolutionScore }
