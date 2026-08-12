import { normalizeText } from '@/domains/knowledge/normalize.ts'

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
export function duplicateKeyOf(category: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const text = (value: unknown): string =>
    typeof value === 'string' ? normalizeText(value) : ''

  switch (category) {
    case 'entity': {
      const label = text(record.label)
      if (label.length === 0) return null
      // Node type included: a ship and a crew can legitimately share a name, and
      // they are two entities in the graph.
      return `entity|${text(record.node_type)}|${label}`
    }

    case 'assertion': {
      const predicate = text(record.predicate)
      const subject = text(record.subject)
      if (predicate.length === 0 || subject.length === 0) return null
      /*
       * Subject and object are local ids for entities proposed by this same run
       * ("e1"), and those ids are scoped to one model response — slice two's
       * "e1" is not slice one's. So this key catches a relation repeated within
       * a slice exactly, and can miss one repeated across slices. That is a
       * known floor, not an oversight: resolving local ids across slices would
       * mean guessing which duplicate entity each half meant, and a wrong guess
       * here would label two genuinely different relations as copies.
       */
      const object = text(record.object) || text(record.object_value)
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
  const byKey = new Map<string, Groupable[]>()

  for (const row of rows) {
    const key = duplicateKeyOf(row.category, row.payload)
    if (key === null) continue
    const group = byKey.get(key)
    if (group) group.push(row)
    else byKey.set(key, [row])
  }

  const info = new Map<string, DuplicateInfo>()

  for (const [key, group] of byKey) {
    if (group.length < 2) continue

    for (const [index, row] of group.entries()) {
      const others: DuplicateTally = { pending: 0, accepted: 0, rejected: 0, deferred: 0 }

      for (const other of group) {
        if (other.id === row.id) continue
        if (other.status === 'accepted') others.accepted++
        else if (other.status === 'rejected') others.rejected++
        else if (other.status === 'deferred') others.deferred++
        // 'superseded' counts as nothing: the item was replaced, not decided,
        // and offering it as a copy to compare against would be noise.
        else if (other.status === 'proposed') others.pending++
      }

      info.set(row.id, { key, rank: index + 1, total: group.length, others })
    }
  }

  return info
}
