import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import {
  labelNames,
  PONEGLYPH_WORDS,
  poneglyphCountsAtChapter,
  poneglyphsKnownAt,
  type PoneglyphView,
} from './poneglyphs.ts'
import { identityComponents } from './projection.ts'

/**
 * What the front door can put on show at one chapter.
 *
 * The home page had nothing of the story on it: six links, three counters and
 * a paragraph about the product. Everything that makes this thing worth
 * opening lived one click away, so the page said « un graphe de connaissances »
 * to someone who came for pirates.
 *
 * This is the read that fixes it, and it exists as its own module for one
 * reason: the front page needs *a few* entities and *a few* open questions,
 * and every existing read is shaped for a whole page of one thing.
 * `projectGraph()` builds the entire graph with every label and every
 * assertion in it; `getTimeline()` reads every event and every mystery in the
 * library. Either one would work and both would make the front door the
 * slowest route on the site.
 *
 * The boundary rules are the same as everywhere else, because they are the
 * database's rather than this file's: a character whose first chapter is past
 * the cursor is not in the cast, a name lands on the chapter that reveals it,
 * and a question is open until the reader has read its answer. There is no
 * path here that widens what a reader can see, and a spoiler on the home page
 * would be the worst place in the site to put one.
 */

export interface CastMember {
  /** The identity component's representative, and the id `/entite` expects. */
  entityId: string
  /** Every entity folded into this one at this boundary. */
  memberIds: string[]
  /** Highest-precedence name revealed at or before the boundary. */
  label: string
  nodeType: string
  /** The earliest chapter any member of the component appeared in. */
  firstSeenChapter: number
  /** Visible relations touching it. Not shown as such; it ranks the pool. */
  factCount: number
}

interface CandidateRow extends Record<string, unknown> {
  id: string
  fact_count: number
}

interface MemberRow extends Record<string, unknown> {
  id: string
  node_type: string
  first_seen_chapter: number
  label: string | null
  precedence: number | null
}

/** Candidates read before the draw. Enough to vary, small enough to be cheap. */
const DEFAULT_POOL = 60

/**
 * The most connected entities of a few types, as they stand at one chapter.
 *
 * Ranked by how many visible relations touch them, and returned in that order.
 * The ranking is not a popularity contest for its own sake: a caller that drew
 * uniformly from every entity in the library would show a reader six names
 * mentioned once each, which is a worse advertisement for a knowledge graph
 * than showing nothing. Callers that want variety shuffle the pool; the pool
 * itself is the part worth showing.
 */
export async function castAtChapter(
  userId: string,
  boundaryChapter: number,
  options: { nodeTypes?: string[]; pool?: number } = {},
): Promise<CastMember[]> {
  const nodeTypes = options.nodeTypes ?? ['character']
  const pool = options.pool ?? DEFAULT_POOL
  if (nodeTypes.length === 0) return []

  const candidates = await ranked(userId, boundaryChapter, sql`e.node_type IN ${nodeTypes}`, pool)
  return assemble(userId, boundaryChapter, candidates)
}

/**
 * The same people, chosen by name rather than by rank.
 *
 * `castAtChapter` answers « who matters here », and answering it by degree is
 * right for a draw that has nothing else to go on. It is wrong the moment
 * something else already decided who belongs on screen — and the wanted posters
 * did. Higuma is a mountain bandit with three relations to his name and an
 * eight-million-berry poster on the first page of chapter 1; he is nowhere near
 * the sixty most connected characters in the library and he is exactly who a
 * reader of chapter 100 should see. Ranking, applied to a list somebody else
 * already picked, is a filter that throws away the picks.
 *
 * So the folding and the naming are shared and the choosing is not. What comes
 * back is folded through the same identity components — two appearances the
 * reader knows to be one person are one card — which is also why the result can
 * carry members that were never asked for.
 */
export async function castOf(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<CastMember[]> {
  if (entityIds.length === 0) return []
  const candidates = await ranked(userId, boundaryChapter, sql`e.id IN ${entityIds}`, null)
  return assemble(userId, boundaryChapter, candidates)
}

/**
 * Entities matching a scope, heaviest first.
 *
 * Degree by union rather than by `OR` on the join: `subject = e.id OR object =
 * e.id` cannot use either index and degrades into a scan of the assertions
 * table per entity. The two halves counted separately and added is the same
 * number, and each half is an index lookup. Same shape as projectGraph(), for
 * the same reason.
 *
 * The scope is a fragment rather than a parameter because the two callers differ
 * only in it, and the boundary applies to both identically: whatever the scope
 * says, an entity the reader has not reached is not in the result.
 */
async function ranked(
  userId: string,
  boundaryChapter: number,
  scope: SQL,
  limit: number | null,
): Promise<CandidateRow[]> {
  const cap = limit === null ? sql.empty() : sql`LIMIT ${limit}`
  return withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<CandidateRow>(sql`
      SELECT e.id, coalesce(sum(d.n), 0)::int AS fact_count
      FROM entities e
      LEFT JOIN (
        SELECT subject_entity_id AS id, count(*) AS n
        FROM assertions WHERE predicate <> 'same_as' GROUP BY 1
        UNION ALL
        SELECT object_entity_id AS id, count(*) AS n
        FROM assertions
        WHERE object_entity_id IS NOT NULL AND predicate <> 'same_as' GROUP BY 1
      ) d ON d.id = e.id
      WHERE ${scope}
      GROUP BY e.id, e.first_seen_chapter
      ORDER BY coalesce(sum(d.n), 0) DESC, e.first_seen_chapter, e.id
      ${cap}
    `),
  )
}

/** Fold the candidates into people, and give each one the name it has here. */
async function assemble(
  userId: string,
  boundaryChapter: number,
  candidates: CandidateRow[],
): Promise<CastMember[]> {
  if (candidates.length === 0) return []

  /*
   * Merges, folded before the draw rather than after.
   *
   * Two appearances the reader now knows to be one person are one poster, and
   * drawing them separately would put the same face on the wall twice under
   * two different names. Which of the two is the representative is decided by
   * the same union-find the graph uses, so a click from here lands on the
   * node the graph would have shown.
   */
  const components = await identityComponents(
    userId,
    boundaryChapter,
    candidates.map((row) => row.id),
  )

  const memberIds = [...new Set([...components.values()].flat())]

  const members = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<MemberRow>(sql`
      SELECT e.id, e.node_type, e.first_seen_chapter,
             (SELECT l.label FROM entity_labels l
              WHERE l.entity_id = e.id
              ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
              LIMIT 1) AS label,
             (SELECT l.precedence FROM entity_labels l
              WHERE l.entity_id = e.id
              ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
              LIMIT 1) AS precedence
      FROM entities e
      WHERE e.id IN ${memberIds}
    `),
  )

  const memberById = new Map(members.map((row) => [row.id, row]))

  const cast: CastMember[] = []
  const taken = new Set<string>()

  for (const candidate of candidates) {
    const group = components.get(candidate.id) ?? [candidate.id]
    const root = group.reduce((low, id) => (id < low ? id : low), group[0]!)
    if (taken.has(root)) continue
    taken.add(root)

    const rows = group.map((id) => memberById.get(id)).filter((row) => row !== undefined)
    const self = memberById.get(candidate.id)
    const nodeType = memberById.get(root)?.node_type ?? self?.node_type ?? rows[0]?.node_type
    if (!nodeType) continue

    /*
     * The name comes from the whole component, not from the representative.
     *
     * After a merge the true name can sit on the half that did not become the
     * representative, which is chosen by id and has nothing to do with which
     * appearance carried the name.
     */
    let best: MemberRow | undefined
    for (const row of rows) {
      if (row.label === null) continue
      if (!best || (row.precedence ?? 0) > (best.precedence ?? 0)) best = row
    }

    cast.push({
      entityId: root,
      memberIds: group,
      label: best?.label ?? 'entité sans nom révélé',
      nodeType,
      firstSeenChapter: Math.min(
        ...rows.map((row) => row.first_seen_chapter),
        self?.first_seen_chapter ?? boundaryChapter,
      ),
      factCount: candidate.fact_count,
    })
  }

  return cast
}

export interface OpenQuestion {
  entityId: string
  question: string
  openedInChapter: number
}

/**
 * Questions the story has asked and not yet answered, as far as the reader knows.
 *
 * « As far as the reader knows » is the whole of it, and it is why the filter
 * is on the chapter rather than on `state`. A row saying `resolved` was
 * resolved somewhere, possibly six hundred chapters past the cursor, and
 * showing that question as settled would tell a reader that an answer exists
 * before they have read a page of it. Compared against the boundary, the same
 * column answers the only honest version of the question.
 *
 * Oldest first: a question left standing for four hundred chapters is the one
 * worth putting on a front page, and the one nobody has the number for.
 */
export async function openQuestionsAtChapter(
  userId: string,
  boundaryChapter: number,
  limit = 12,
): Promise<OpenQuestion[]> {
  const rows = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<{ entity_id: string; question: string; opened_in_chapter: number }>(sql`
      SELECT entity_id, question, opened_in_chapter
      FROM mysteries
      WHERE resolved_in_chapter IS NULL OR resolved_in_chapter > ${boundaryChapter}
      ORDER BY opened_in_chapter, entity_id
      LIMIT ${limit}
    `),
  )

  /*
   * The same question, asked once. Publication refuses duplicates now, but a
   * library built before that refusal holds them, and two rows with the same
   * words are one question to a reader. The earliest wins: the chapter that
   * asked first is the true one.
   */
  const seen = new Set<string>()
  const questions: OpenQuestion[] = []
  for (const row of rows) {
    const key = row.question.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    questions.push({
      entityId: row.entity_id,
      question: row.question,
      openedInChapter: row.opened_in_chapter,
    })
  }

  return questions
}

/** A node of the library, named as the reader knows it. */
export interface GraphNode {
  entityId: string
  label: string
}

/** A stone of the manifest, plus the way into the graph the library offers. */
export interface KnownPoneglyph extends PoneglyphView {
  /**
   * The place in this library the stone's known location points at, when the
   * reader has met it.
   *
   * A convenience and not an identity claim: the card says « Tombeau des Rois »
   * because chapter 202 does, and this is a link to the library's own node of
   * that name so the reader can go and read what else it holds. Null far more
   * often than not — an island the story never named has no node, and a library
   * that stops before the chapter that names one has not got there yet.
   */
  place: GraphNode | null
}

/** Everything the front door needs to say about the stones at one chapter. */
export interface PoneglyphWatch {
  /** Known stones, in the order the reader learned of them. */
  stones: KnownPoneglyph[]
  /** The library's own node for « ponéglyphe », when the reader has met it. */
  node: GraphNode | null
  /** How many road poneglyphs exist, once a chapter has said so. */
  roads: number | null
  /** How many poneglyphs exist in all, once a chapter has said so. */
  total: number | null
}

/**
 * Les ponéglyphes que le lecteur connaît, et ce qu'il en sait.
 *
 * The dating is not this function's work and that is the point of it being
 * short: `poneglyphsKnownAt` has already removed every claim the reader has not
 * read, so what is left to do here is one lookup — which of the places those
 * stones stand in does this library actually hold, under a name the reader has
 * been told.
 *
 * Two consequences worth stating. Before chapter 193 there is no query at all:
 * the work has not used the word, so the front page has no section and the
 * database is not asked. And the lookup runs inside the boundary, so a place the
 * reader has not reached cannot become a link — a card can name where a stone
 * stands and still have nowhere to send them, which is the honest shape of a
 * library that has not imported that island yet.
 */
export async function poneglyphsAtChapter(
  userId: string,
  boundaryChapter: number,
): Promise<PoneglyphWatch> {
  const known = poneglyphsKnownAt(boundaryChapter)
  const { roads, total } = poneglyphCountsAtChapter(boundaryChapter)
  if (known.length === 0) return { stones: [], node: null, roads, total }

  /*
   * Places and the stones themselves, in one read.
   *
   * `place` for the links under each card and `object`/`concept` for the
   * library's own node of the subject, which the heading points at. Both are
   * labels rather than entities: an entity carries every name it has been given
   * and the reader may only have been told one of them, so the match runs on the
   * name and the boundary decides which names exist.
   */
  const rows = await withBoundary({ userId, boundaryChapter }, async (db) =>
    db.execute<{ entity_id: string; label: string; node_type: string }>(sql`
      SELECT DISTINCT l.entity_id, l.label, e.node_type
      FROM entity_labels l
      JOIN entities e ON e.id = l.entity_id
      WHERE e.node_type IN ('place', 'object', 'concept')
    `),
  )

  const places = rows.filter((row) => row.node_type === 'place')

  const stones: KnownPoneglyph[] = known.map((stone) => {
    /*
     * The aliases are tried in order, and the order is the manifest's: the
     * first is the most specific description the reader has reached. « Tombeau
     * des Rois » before « Alubarna », because a card whose place says the tomb
     * should link to the tomb when the library has it.
     */
    let place: GraphNode | null = null
    for (const alias of stone.entities) {
      const found = places.find((row) => labelNames(row.label, alias))
      if (found) {
        place = { entityId: found.entity_id, label: found.label }
        break
      }
    }
    return { ...stone, place }
  })

  /*
   * The subject's own node, and the shortest name wins.
   *
   * A library holds « Ponéglyphe » as an object and may also hold « Ponéglyphe
   * d'Alabasta » or « Plan de domination de Crocodile » beside it; the heading
   * wants the general one, and among labels that all contain the word the
   * shortest is it.
   */
  let node: GraphNode | null = null
  for (const row of rows) {
    if (row.node_type === 'place') continue
    if (!PONEGLYPH_WORDS.some((word) => labelNames(row.label, word))) continue
    if (!node || row.label.length < node.label.length) {
      node = { entityId: row.entity_id, label: row.label }
    }
  }

  return { stones, node, roads, total }
}
