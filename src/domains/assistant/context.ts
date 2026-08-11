import 'server-only'
import { and, inArray, sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { assertions, entityLabels, evidence } from '@/db/schema/knowledge.ts'
import { normalizeText } from '../knowledge/normalize.ts'
import { search } from '../search/index.ts'

/**
 * Assemble what the assistant is allowed to reason from.
 *
 * The ordering is the whole safety argument: retrieve, *then* filter, is the
 * wrong way round and is how most of these systems leak. Here every read runs
 * inside `withBoundary`, so the search that finds candidates and the query that
 * expands them into assertions are both filtered by the database before
 * anything reaches a prompt. The model never sees a row it could have leaked,
 * so no amount of prompt engineering on its side can produce one.
 *
 * The context is also the *allowlist* the answer is checked against afterwards.
 * That is why it is built here rather than assembled inline in the prompt: the
 * verification step needs the same object the model was given, not a
 * reconstruction of it.
 */

export interface ContextEntry {
  assertionId: string
  chapter: number
  statement: string
  excerpt: string | null
  subjectId: string
  objectId: string | null
}

export interface AssistantContext {
  boundaryChapter: number
  entries: ContextEntry[]
  /** Entities the search surfaced, for "I looked at these" transparency. */
  entityIds: string[]
  /** Modes that could not run, passed through so the answer can say so. */
  notes: string[]
}

/** How many assertions to hand the model. */
const MAX_ENTRIES = 40

export async function buildContext(
  userId: string,
  boundaryChapter: number,
  question: string,
): Promise<AssistantContext> {
  let found = await search(userId, boundaryChapter, question, { limit: 20 })
  let entityIds = entitiesIn(found.hits)

  /*
   * A question is not a search query.
   *
   * `websearch_to_tsquery` conjoins terms, which is right for a search box —
   * type two words, get rows containing both. Run a sentence through it and
   * every word becomes mandatory, so "Que sait-on de la Guilde des Marées ?"
   * asks for a page containing *savoir* as well as the two words that matter,
   * and finds nothing. The reader then gets "insufficient data" about
   * something the corpus plainly contains, which is the wrong kind of
   * honesty: correct, unhelpful, and indistinguishable from a real gap.
   *
   * So: retry with the same terms disjoined. Ranking sorts out which matches
   * are worth anything, and a broader retrieval cannot widen what the reader
   * is allowed to see — the boundary is applied by the database on both
   * passes, and every citation is still checked against what came back.
   */
  if (entityIds.length === 0) {
    const broadened = disjoin(question)
    if (broadened !== null) {
      found = await search(userId, boundaryChapter, broadened, { limit: 20 })
      entityIds = entitiesIn(found.hits)
    }
  }

  const notes = found.modes
    .filter((mode) => !mode.ran && mode.note)
    .map((mode) => mode.note!)

  if (entityIds.length === 0) {
    return { boundaryChapter, entries: [], entityIds: [], notes }
  }

  const entries = await withBoundary({ userId, boundaryChapter }, async (db) => {
    /*
     * Every assertion touching a found entity, in either direction.
     *
     * Subject-only would answer "what did X do" and not "who did something to
     * X", and for a story the second question is at least as common — who
     * betrayed whom, who is looking for whom.
     */
    const rows = await db
      .select({
        id: assertions.id,
        predicate: assertions.predicate,
        subjectId: assertions.subjectEntityId,
        objectId: assertions.objectEntityId,
        objectValue: assertions.objectValue,
        chapter: assertions.knowledgeFromChapter,
        epistemicStatus: assertions.epistemicStatus,
      })
      .from(assertions)
      .where(
        sql`${assertions.subjectEntityId} IN ${entityIds} OR ${assertions.objectEntityId} IN ${entityIds}`,
      )
      .orderBy(assertions.knowledgeFromChapter)
      .limit(MAX_ENTRIES)

    if (rows.length === 0) return []

    const involved = [
      ...new Set(
        rows.flatMap((row) =>
          [row.subjectId, row.objectId].filter((id): id is string => id !== null),
        ),
      ),
    ]

    const labels = await db
      .select({
        entityId: entityLabels.entityId,
        label: entityLabels.label,
      })
      .from(entityLabels)
      .where(inArray(entityLabels.entityId, involved))
      .orderBy(sql`${entityLabels.precedence} DESC`)

    const labelOf = new Map<string, string>()
    for (const row of labels) {
      if (!labelOf.has(row.entityId)) labelOf.set(row.entityId, row.label)
    }

    // One excerpt per assertion, so the model can quote what the page said
    // rather than paraphrasing the predicate.
    const excerpts = await db
      .select({ assertionId: evidence.assertionId, excerpt: evidence.excerpt })
      .from(evidence)
      .where(
        and(
          inArray(
            evidence.assertionId,
            rows.map((row) => row.id),
          ),
          sql`${evidence.excerpt} IS NOT NULL`,
        ),
      )

    const excerptOf = new Map<string, string>()
    for (const row of excerpts) {
      if (row.excerpt && !excerptOf.has(row.assertionId)) {
        excerptOf.set(row.assertionId, row.excerpt)
      }
    }

    return rows.map((row): ContextEntry => {
      const subject = labelOf.get(row.subjectId) ?? 'une entité sans nom révélé'
      const object = row.objectId
        ? (labelOf.get(row.objectId) ?? 'une entité sans nom révélé')
        : literalOf(row.objectValue)

      return {
        assertionId: row.id,
        chapter: row.chapter,
        // Rendered as a sentence rather than passed as a triple: the model
        // reads prose better, and the qualifier keeps a hypothesis from being
        // quoted back as though it were established.
        statement:
          `${subject} — ${row.predicate} — ${object ?? '(valeur absente)'}` +
          (row.epistemicStatus === 'explicit' ? '' : ` [${row.epistemicStatus}]`),
        excerpt: excerptOf.get(row.id) ?? null,
        subjectId: row.subjectId,
        objectId: row.objectId,
      }
    })
  })

  return { boundaryChapter, entries, entityIds, notes }
}

function entitiesIn(hits: Array<{ entityId: string | null }>): string[] {
  return [
    ...new Set(
      hits.map((hit) => hit.entityId).filter((id): id is string => id !== null),
    ),
  ]
}

/**
 * French question scaffolding: words a reader types to ask, never to name.
 *
 * Deliberately short. Dropping too much turns a specific question into a vague
 * one, and the failure that causes — plausible neighbours retrieved instead of
 * the right rows — is worse than the failure it fixes, because the model will
 * happily build an answer from them.
 */
const QUESTION_WORDS = new Set([
  'que', 'qui', 'quoi', 'quel', 'quelle', 'quels', 'quelles', 'quand', 'ou',
  'comment', 'pourquoi', 'combien', 'est', 'sont', 'etait', 'etaient', 'sait',
  'savons', 'connait', 'peux', 'peut', 'dis', 'dit', 'moi', 'nous', 'vous',
  'les', 'des', 'une', 'aux', 'dans', 'pour', 'avec', 'sur', 'par', 'plus',
  'tout', 'tous', 'toute', 'toutes', 'cette', 'ces', 'son', 'sa', 'ses',
  'leur', 'leurs', 'passe', 'arrive', 'fait', 'donne', 'parle', 'raconte',
])

/**
 * Rewrite a question as a disjunction the same search path understands.
 *
 * `websearch_to_tsquery` treats a bare `or` as the OR operator, so this stays
 * inside the existing query language rather than adding a second one. Returns
 * null when nothing is left to broaden with — a one-word question is already
 * as broad as it gets, and re-running it would just cost a round trip.
 */
export function disjoin(question: string): string | null {
  const words = normalizeText(question)
    .split(' ')
    .filter((word) => word.length > 2 && !QUESTION_WORDS.has(word))

  const unique = [...new Set(words)]
  if (unique.length < 2) return null
  return unique.join(' or ')
}

function literalOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value
    return inner === null || inner === undefined ? null : String(inner)
  }
  return String(value)
}
