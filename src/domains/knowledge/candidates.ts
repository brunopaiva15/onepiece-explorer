import 'server-only'
import { and, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { entities, entityLabels } from '@/db/schema/knowledge.ts'
import { normalizeText } from './normalize.ts'

/**
 * « Alors, laquelle ? » — the entities a wrong fact could have been about.
 *
 * A correction on the fiche needs a target, and a target cannot be typed: the
 * graph holds uuids, and two crews forty chapters apart can carry names that
 * differ by one word. So the reader searches, and this is what they search.
 *
 * Three properties, each of which is the reason this is not `search()`:
 *
 *   Entities only, and only the ones the predicate accepts. `leads` takes a
 *   group; offering a character would offer a row the database is about to
 *   refuse (ADR 0004), and discovering that after clicking is exactly the
 *   experience the review board's type-mismatch notice exists to prevent.
 *
 *   Read at the reader's boundary, through row-level security like everything
 *   else. Correcting a fact is not a reason to be shown a crew from four
 *   hundred chapters ahead — and the corollary is honest rather than annoying:
 *   at chapter 19 the Équipage de Roger is not a node yet, so « Baggy appartient
 *   à l'Équipage du Roux » has no right target and the answer is to retract it.
 *
 *   Names, not prose. `search()` fuses full text over chapter blocks with
 *   trigram over names and is right for a reader asking a question; here the
 *   only question is which node bears which name.
 */

export interface EntityCandidate {
  entityId: string
  label: string
  nodeType: string
  /** The chapter that gave this name — printed, so the reader can tell two apart. */
  revealedInChapter: number
}

export interface CandidateQuery {
  query: string
  /** Node types the predicate accepts at that end. Empty means no restriction. */
  accepts?: readonly string[]
  /** Entities that are not answers: the current object, the subject itself. */
  exclude?: readonly string[]
  limit?: number
}

/** Shorter than this, every name matches and the list means nothing. */
const MIN_QUERY = 2

/** Below this, a trigram match is noise rather than a typo. Same floor as search. */
const FUZZY_FLOOR = 0.3

export async function entityCandidates(
  userId: string,
  boundaryChapter: number,
  input: CandidateQuery,
): Promise<EntityCandidate[]> {
  const normalised = normalizeText(input.query)
  if (normalised.length < MIN_QUERY) return []

  const limit = input.limit ?? 12
  const accepts = input.accepts ?? []
  const exclude = input.exclude ?? []

  return withBoundary({ userId, boundaryChapter }, async (db) => {
    /*
     * Contains, then similar. « roger » should find « Équipage de Roger »,
     * which trigram similarity scores low — the query is a quarter of the
     * name — and a reader typing three letters of a crew's name is the ordinary
     * case here, not the exotic one. Similarity still runs beside it, for the
     * spelling nobody agrees on: Baggy, Buggy.
     *
     * The pattern is escaped rather than interpolated: `%` and `_` in a typed
     * name are literal characters, and a lone `\` would otherwise make the
     * LIKE itself invalid.
     */
    const contains = `%${normalised.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    /*
     * `word_similarity`, not `similarity` — the difference matters here and not
     * in search.
     *
     * An entity label is sometimes a whole sentence: an event is an entity and
     * its label is its summary. Whole-string similarity between « buggy » and
     * « Baggy le Clown » is 0.17, under any floor worth having, because most of
     * the target is not the word being looked for. `word_similarity` scores the
     * query against the best matching extent of the label instead, which is
     * what a reader typing one word of a name means.
     */
    const similarity = sql<number>`word_similarity(${normalised}, ${entityLabels.normalizedLabel})`

    const rows = await db
      .select({
        entityId: entityLabels.entityId,
        label: entityLabels.label,
        precedence: entityLabels.precedence,
        revealedInChapter: entityLabels.revealedInChapter,
        nodeType: entities.nodeType,
        similarity,
        // A name the query is a piece of beats a name that merely resembles it:
        // « Équipage du Roux » for "roux" is an answer, « Roger » is a guess.
        contained: sql<boolean>`${entityLabels.normalizedLabel} LIKE ${contains}`,
      })
      .from(entityLabels)
      .innerJoin(entities, eq(entities.id, entityLabels.entityId))
      .where(
        and(
          or(
            sql`${entityLabels.normalizedLabel} LIKE ${contains}`,
            sql`${similarity} >= ${FUZZY_FLOOR}`,
          ),
          accepts.length > 0 ? inArray(entities.nodeType, [...accepts]) : undefined,
          exclude.length > 0 ? notInArray(entities.id, [...exclude]) : undefined,
        ),
      )
      .orderBy(
        desc(sql`${entityLabels.normalizedLabel} LIKE ${contains}`),
        desc(similarity),
        desc(entityLabels.precedence),
      )
      // Room for the fold below: an entity carrying an alias and a true name
      // close to the query occupies two rows here and one in the answer.
      .limit(limit * 4)

    const best = new Map<string, EntityCandidate>()
    for (const row of rows) {
      // One row per entity, keeping the first — the ordering above has already
      // put its strongest name in front.
      if (best.has(row.entityId)) continue
      best.set(row.entityId, {
        entityId: row.entityId,
        label: row.label,
        nodeType: row.nodeType,
        revealedInChapter: row.revealedInChapter,
      })
      if (best.size >= limit) break
    }

    return [...best.values()]
  })
}
