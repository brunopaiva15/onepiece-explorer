import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { tokens } from '@/domains/resolution/scoring.ts'

/**
 * When one run proposes the same thing twice.
 *
 * A chapter is extracted in slices of twenty panels, and only entities already
 * *accepted* are handed to the model as known — nothing is accepted mid-run. So
 * a character appearing in two slices is proposed twice, by design (see
 * `steps/extract.ts`). The pipeline is right to do it; what was missing is that
 * the reviewer had no way to see it. Two identical cards, forty proposals apart,
 * look like two findings.
 *
 * Accepting both is not a cosmetic mistake. Publication inserts one entity row
 * per accepted proposal with no deduplication, and `runResolve` only ever
 * compares proposals against entities *already in the graph* — never against the
 * other proposals of the same run. So the second copy becomes a second node that
 * nothing will ever join back, splitting a character's relations across two
 * halves of a person.
 *
 * This module answers one question — "is this the same proposal as another one
 * in this run, and what did I decide about it?" — and answers nothing else. It
 * groups, it counts, it never decides: two copies are shown side by side with
 * their statuses, and the reviewer picks. Which is the same rule the resolution
 * scorer follows for identity, for the same reason.
 */

/** The statuses a review item can be in, as far as grouping cares. */
export interface DuplicateTally {
  /** Still awaiting a decision. */
  pending: number
  /** Already published as accepted — the dangerous one. */
  accepted: number
  rejected: number
  deferred: number
}

export interface DuplicateInfo {
  /** Shared by every item proposing the same thing. */
  key: string
  /** Where this item sits among its copies, in queue order. 1-based. */
  rank: number
  /** How many copies exist in this run, this one included. */
  total: number
  /** The *other* copies, by status. */
  others: DuplicateTally
}

interface Groupable {
  id: string
  category: string
  payload: unknown
  status: string
}

/**
 * What makes two proposals "the same thing".
 *
 * Deliberately exact rather than fuzzy: the key is a normalised equality, not a
 * similarity score. Two proposals that merely resemble each other are not
 * duplicates — the extraction prompt asks the model to emit *two distinct
 * entities* when the source does not establish that two appearances are the same
 * person, and flagging those as copies would train the reviewer to dismiss the
 * signal on exactly the cases where it matters. Similarity has an owner already,
 * and it is `domains/resolution/scoring.ts`.
 *
 * Returns null when the payload carries nothing identifying, which is not an
 * error: an item with no key is simply never part of a group.
 */
export function duplicateKeyOf(
  category: string,
  payload: unknown,
  /**
   * What a local id refers to, when the run says so unambiguously.
   *
   * Entities proposed by this run are referenced by ids scoped to one model
   * response — slice two's "e1" is not slice one's — so a relation repeated
   * across slices carries different ids for the same pair of characters and
   * looks like a different relation. Resolving those ids to the entity they
   * name is what makes the two comparable at all.
   */
  identityOf: (localId: string) => string | null = () => null,
): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const text = (value: unknown): string =>
    typeof value === 'string' ? normalizeText(value) : ''

  /** An entity reference, named by what it is rather than by its slice's id. */
  const named = (value: unknown): string => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (raw.length === 0) return ''
    return identityOf(raw) ?? normalizeText(raw)
  }

  switch (category) {
    case 'entity': {
      // Node type either way: a ship and a crew can legitimately share a name,
      // and they are two entities in the graph.
      const nodeType = text(record.node_type)

      /*
       * The source wording first, the French label only as a fallback.
       *
       * Keying on the label alone missed the copy that costs the most. Naming
       * is the one field the model authors rather than quotes, and it authors
       * it differently from one slice to the next: « Red Hair Pirates » came
       * back as « Équipage des cheveux rouges » in one and « Équipage du Roux »
       * in another — two labels honestly derived from the same words, which is
       * precisely the failure migration 0016 exists for. Compared by label,
       * those are two proposals; compared by what they quote, they are one.
       *
       * `source_term` is copied from the text, not written, so it holds still
       * while the translation moves. It is null when the label already matches
       * the source — a French source, or a name that is the same in both — and
       * the label is then exactly as stable, so the fallback loses nothing.
       *
       * What this still misses: two copies where one carries a source term and
       * the other does not, with different labels. Nothing links those without
       * comparing meanings, which is entity resolution's job and not this
       * module's.
       */
      const source = text(record.source_term)
      if (source.length > 0) return `entity|${nodeType}|source:${source}`

      const label = text(record.label)
      if (label.length === 0) return null
      return `entity|${nodeType}|${label}`
    }

    case 'assertion': {
      const predicate = text(record.predicate)
      const subject = named(record.subject)
      if (predicate.length === 0 || subject.length === 0) return null
      /*
       * Named by their entity where the run allows it, by their raw id where it
       * does not. An id two slices used for two different characters resolves
       * to nothing and stays itself — which groups nothing, and that is the
       * right failure: calling two unrelated relations copies of each other
       * would be worse than missing a pair.
       */
      const object = named(record.object) || text(record.object_value)
      return `assertion|${subject}|${predicate}|${object}`
    }

    case 'event': {
      const summary = text(record.summary)
      return summary.length === 0 ? null : `event|${summary}`
    }

    case 'mystery': {
      const question = text(record.question)
      return question.length === 0 ? null : `mystery|${question}`
    }

    case 'resolution': {
      // The same question asked twice: "is this appearance the entity you
      // already have?" — once per copy of the candidate proposal.
      const candidate = text(record.candidateLabel)
      const existing = typeof record.existingEntityId === 'string' ? record.existingEntityId : ''
      if (candidate.length === 0 || existing.length === 0) return null
      return `resolution|${candidate}|${existing}`
    }

    case 'conflict': {
      const against =
        typeof record.conflictsWithAssertionId === 'string'
          ? record.conflictsWithAssertionId
          : ''
      if (against.length === 0) return null
      const proposal =
        record.proposal !== null && typeof record.proposal === 'object'
          ? (record.proposal as Record<string, unknown>)
          : {}
      return `conflict|${against}|${text(proposal.subject)}|${text(proposal.predicate)}`
    }

    default:
      return null
  }
}

/**
 * What each local id refers to, when the run leaves no doubt.
 *
 * Built from the run's own entity proposals: `e1` is whatever entity proposal
 * declared `local_id: "e1"`. Two slices numbering different characters "e1" is
 * exactly the case that must not be resolved, so an id claimed by two different
 * entities resolves to nothing and every relation using it stays keyed on the
 * raw id — grouping nothing rather than grouping the wrong things.
 */
function entityIdentities(rows: Groupable[]): Map<string, string | null> {
  const claims = new Map<string, string | null>()

  for (const row of rows) {
    if (row.category !== 'entity') continue
    if (row.payload === null || typeof row.payload !== 'object') continue
    const record = row.payload as Record<string, unknown>
    const localId = typeof record.local_id === 'string' ? record.local_id.trim() : ''
    if (localId.length === 0) continue

    const identity = duplicateKeyOf('entity', record)
    if (identity === null) continue

    if (!claims.has(localId)) {
      claims.set(localId, identity)
      continue
    }
    // Claimed twice by two different entities: ambiguous, and poisoned for good.
    if (claims.get(localId) !== identity) claims.set(localId, null)
  }

  return claims
}

/**
 * How much two event summaries have to share to be the same beat.
 *
 * Events are the one category with no stable identity to compare. An entity has
 * the wording it quotes, a relation has its predicate and its two ends; an event
 * is a sentence the model composed, and it composes it differently each time —
 * « Le Seigneur de la Côte dévore Higuma et son bateau » in one slice, « Le
 * Seigneur de la Côte avale Higuma » in the next. Exact equality never fires on
 * those, which left the category with no duplicate detection at all.
 *
 * So events, and only events, are compared by content words. The overlap
 * coefficient rather than Jaccard, because one summary is often the other plus a
 * clause, and a length difference should not hide a match. Two shared words
 * minimum, so a pair of terse summaries cannot match on a single name.
 *
 * The threshold is honest about being a threshold, and its blast radius is
 * bounded: a wrong grouping here shows a banner and a link to the other card.
 * Nothing merges, nothing is decided, and the reviewer is the one who answers.
 */
const EVENT_OVERLAP = 0.7
const EVENT_MIN_SHARED = 2

/**
 * Content words of a summary, with sentence punctuation out of the way.
 *
 * `normalizeText` folds punctuation rather than dropping it, which is right for
 * an excerpt compared character by character and wrong here: these are whole
 * sentences, and « Luffy. » at the end of one is the same word as « Luffy » in
 * the middle of the other. Left in, a full stop was enough to hide a match.
 */
function beatWords(summary: string): Set<string> {
  return new Set(tokens(summary.replace(/[^\p{L}\p{N}]+/gu, ' ')))
}

function sameBeat(a: string, b: string): boolean {
  const left = beatWords(a)
  const right = beatWords(b)
  if (left.size === 0 || right.size === 0) return false

  const shared = [...left].filter((token) => right.has(token)).length
  if (shared < EVENT_MIN_SHARED) return false
  return shared / Math.min(left.size, right.size) >= EVENT_OVERLAP
}

/** The summary an event proposal carries, for comparison. */
function summaryOf(row: Groupable): string {
  if (row.payload === null || typeof row.payload !== 'object') return ''
  const summary = (row.payload as Record<string, unknown>).summary
  return typeof summary === 'string' ? summary : ''
}

/**
 * Group a run's items by what they propose.
 *
 * Every item of the run goes in, decided ones included — that is the point. A
 * copy accepted and published an hour ago is invisible in a queue that only
 * lists what is still pending, and it is precisely the copy whose existence
 * changes the right answer for the one on screen.
 *
 * Order is the caller's: `rank` follows the order rows are passed in, so the
 * numbering shown to the reviewer matches the queue they are walking.
 */
export function groupDuplicates(rows: Groupable[]): Map<string, DuplicateInfo> {
  const identities = entityIdentities(rows)
  const identityOf = (localId: string): string | null => identities.get(localId) ?? null

  const byKey = new Map<string, Groupable[]>()

  for (const row of rows) {
    const key = duplicateKeyOf(row.category, row.payload, identityOf)
    if (key === null) continue
    const group = byKey.get(key)
    if (group) group.push(row)
    else byKey.set(key, [row])
  }

  /*
   * Events, folded together by resemblance after the exact pass.
   *
   * Quadratic over one run's events — a few dozen — and only over events, so
   * the cost is nothing and the rule stays confined to the category that needs
   * it. Groups are merged rather than individual rows, so a beat worded three
   * ways still ends up as one group of three.
   */
  const eventKeys = [...byKey.keys()].filter((key) => key.startsWith('event|'))
  for (const [index, key] of eventKeys.entries()) {
    const group = byKey.get(key)
    if (group === undefined) continue

    for (const other of eventKeys.slice(index + 1)) {
      const candidate = byKey.get(other)
      if (candidate === undefined) continue
      if (!sameBeat(summaryOf(group[0]!), summaryOf(candidate[0]!))) continue

      group.push(...candidate)
      byKey.delete(other)
    }
  }

  const info = new Map<string, DuplicateInfo>()

  for (const [key, group] of byKey) {
    if (group.length < 2) continue

    // Merged event groups arrive in the order they were folded in, which is not
    // the order the reviewer walks. Sorting restores it, so "copie 2 sur 3"
    // means the second one they will meet.
    const ordered = group
      .map((row) => ({ row, position: rows.indexOf(row) }))
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.row)

    for (const [index, row] of ordered.entries()) {
      const others: DuplicateTally = { pending: 0, accepted: 0, rejected: 0, deferred: 0 }

      for (const other of ordered) {
        if (other.id === row.id) continue
        if (other.status === 'accepted') others.accepted++
        else if (other.status === 'rejected') others.rejected++
        else if (other.status === 'deferred') others.deferred++
        // 'superseded' counts as nothing: the item was replaced, not decided,
        // and offering it as a copy to compare against would be noise.
        else if (other.status === 'proposed') others.pending++
      }

      info.set(row.id, { key, rank: index + 1, total: ordered.length, others })
    }
  }

  return info
}
