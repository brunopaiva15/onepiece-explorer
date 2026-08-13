import 'server-only'
import { and, desc, eq, inArray, isNotNull, like, ne, or } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import {
  assertions,
  auditLog,
  entities,
  entityLabels,
  events,
  mysteries,
  nodeTypes,
  predicates,
} from '@/db/schema/knowledge.ts'

/**
 * Change what an entity *is*.
 *
 * The Bara Bara no Mi is a fruit — a thing Baggy ate, that can be stolen, that
 * sits in a chest — and the graph filed it under « Pouvoir », beside the Bara
 * Bara no Hou, which is the technique it grants. Both came from the same
 * chapter and only one of them is a power. Until now the node type was decided
 * once, at extraction, and there was no way to say otherwise: not on the fiche,
 * not in the review queue after publication, nowhere. The only recourse was to
 * delete the chapter and import it again, which throws away every correction
 * made since.
 *
 * A retype is one UPDATE on `entities.node_type`, and everything difficult
 * about it is what that column is load-bearing for:
 *
 *   The ontology types both ends of every relation. `uses` accepts an object or
 *   a power; `owns` accepts an object and refuses a power. A trigger enforces
 *   that on INSERT (ADR 0004) and cannot enforce it here, because nothing is
 *   being inserted — so a retype can leave behind facts the database would
 *   never have accepted, and did not notice becoming impossible. They are found
 *   first and shown, and the change does not happen until the reader has seen
 *   them: see `RetypeConflict`.
 *
 *   Some node types carry a row elsewhere. An event has a summary in `events`,
 *   a mystery a question in `mysteries` — prose that is that node's whole
 *   content and that no other type has anywhere to put. This function writes
 *   one column and one column only, so it refuses any change that would leave
 *   such a row stranded, rather than deleting prose nobody asked it to delete.
 *
 *   Identity is not a property of one row. « Cette chose est un objet » is true
 *   of the thing, not of the node the reader happens to have opened, so every
 *   member of the identity component is retyped together. Deliberately without a
 *   boundary: which rows are the same thing is a question about the library, and
 *   applying it only to the halves visible at chapter 20 would leave the other
 *   halves disagreeing about what the thing is — a disagreement no reader could
 *   see or fix.
 *
 * What is deliberately left alone: the labels, the first-appearance chapter, the
 * evidence, and the portrait. A picture found for « Bara Bara no Mi » was found
 * by that name and is still of that fruit; the type says which catalogues would
 * be searched *next* time, not whether what was already found was right.
 */

export interface RetypeInput {
  /** Any member of the component. The fiche passes the one it is showing. */
  entityId: string
  nodeType: string
  /**
   * Apply even though facts stand in the way, rejecting them.
   *
   * Never a default. The first call reports the conflicts and writes nothing;
   * the reader answers with this once they have read the list.
   */
  confirm?: boolean
}

/**
 * A fact the new type makes impossible.
 *
 * « Baggy possède le Bara Bara no Mi » is fine for an object and refused for a
 * power, and the reverse case exists too. Each one names the predicate, which
 * end this entity is, and what that end accepts — enough for the reader to
 * decide whether the fact or the type is the thing that is wrong.
 */
export interface RetypeConflict {
  assertionId: string
  predicate: string
  /** Which end of the relation this entity is. */
  role: 'subject' | 'object'
  /**
   * The other end, named as the graph names it — or the literal value it
   * carries, for a relation whose object is a string rather than a node.
   */
  otherLabel: string | null
  /** The node types that end does accept. */
  accepts: string[]
}

export interface RetypeResult {
  entityId: string
  /** Every member of the identity component, all retyped together. */
  entityIds: string[]
  previousNodeType: string
  nodeType: string
  /** False when conflicts were found and the change was not confirmed. */
  applied: boolean
  conflicts: RetypeConflict[]
  /** Assertions rejected to make room for the new type. */
  rejected: number
}

/**
 * Nodes that stand for a document rather than for something in the story.
 *
 * A chapter is a chapter. These are created by ingestion, are what evidence is
 * anchored to, and nothing about them is a classification a reader could hold
 * an opinion about — so they are out of this function in both directions.
 */
const DOCUMENTARY = new Set(['chapter', 'page', 'panel'])

/** What an entity carrying a row in `events` may become. */
const EVENT_LIKE = new Set(['event', 'battle', 'voyage'])

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function retypeEntity(
  userId: string,
  input: RetypeInput,
): Promise<RetypeResult> {
  if (!UUID_RE.test(input.entityId)) throw new Error('Cette entité est introuvable.')

  return withIngest(async (db) => {
    /*
     * The row, read by id *and* by owner.
     *
     * The id arrives from a browser through a POST endpoint and proves nothing.
     * `withIngest` runs as the ingestion role, which is exempt from row-level
     * security, so every clause that scopes this to one library is written out
     * here rather than assumed.
     */
    const [row] = await db
      .select({ id: entities.id, nodeType: entities.nodeType })
      .from(entities)
      .where(and(eq(entities.id, input.entityId), eq(entities.userId, userId)))
      .limit(1)

    if (!row) throw new Error('Cette entité est introuvable.')

    /*
     * The target type, checked against the table rather than against the
     * shipped list.
     *
     * The ontology lives in data precisely so a user-created type works like a
     * built-in one (ADR 0004), and a foreign key would refuse an unknown one
     * anyway — as a driver exception reaching the reader as « Refusée par la
     * base ». This is the same refusal, said in French and before anything else
     * runs.
     */
    const [target] = await db
      .select({ key: nodeTypes.key })
      .from(nodeTypes)
      .where(eq(nodeTypes.key, input.nodeType))
      .limit(1)

    if (!target) throw new Error(`Type de nœud inconnu : ${input.nodeType}.`)
    if (target.key === row.nodeType) throw new Error('C’est déjà son type.')

    if (DOCUMENTARY.has(row.nodeType) || DOCUMENTARY.has(target.key)) {
      throw new Error(
        'Un chapitre, une page et une case sont les documents eux-mêmes : leur ' +
          'type ne se change pas.',
      )
    }

    const memberIds = await componentOf(db, userId, row.id)

    /*
     * The prose this node would leave behind.
     *
     * An event is named by its own summary and a mystery by its question. Those
     * rows hang off the entity id, so a retype does not delete them — it makes
     * them unreachable, and the timeline goes on reading a summary for a node
     * that is no longer an event. Refused rather than cascaded: deleting a
     * sentence the reader never asked to delete is worse than not doing the
     * change.
     */
    const [timed] = await db
      .select({ entityId: events.entityId })
      .from(events)
      .where(and(inArray(events.entityId, memberIds), eq(events.userId, userId)))
      .limit(1)

    if (timed && !EVENT_LIKE.has(target.key)) {
      throw new Error(
        'Ce nœud porte un résumé d’événement : il ne peut devenir qu’un ' +
          'événement, un combat ou un voyage.',
      )
    }

    const [asked] = await db
      .select({ entityId: mysteries.entityId })
      .from(mysteries)
      .where(and(inArray(mysteries.entityId, memberIds), eq(mysteries.userId, userId)))
      .limit(1)

    if (asked && target.key !== 'mystery') {
      throw new Error(
        'Ce nœud porte une question de mystère : la question n’aurait plus où ' +
          'être posée.',
      )
    }

    // And the reverse: a mystery is a question, and this function has none to
    // write. Nothing else may become one.
    if (!asked && target.key === 'mystery') {
      throw new Error(
        'Un mystère est une question ouverte, et rien ici ne peut l’écrire à ' +
          'votre place.',
      )
    }

    const conflicts = await conflictsFor(db, userId, memberIds, target.key)

    /*
     * Nothing is written until the conflicts have been seen.
     *
     * Not a failure — a first half. The reader asked a question the graph can
     * only answer by listing what the change would cost, and the answer is that
     * list. The second call carries `confirm`.
     */
    if (conflicts.length > 0 && input.confirm !== true) {
      return {
        entityId: row.id,
        entityIds: memberIds,
        previousNodeType: row.nodeType,
        nodeType: target.key,
        applied: false,
        conflicts,
        rejected: 0,
      }
    }

    await db
      .update(entities)
      .set({ nodeType: target.key })
      .where(and(inArray(entities.id, memberIds), eq(entities.userId, userId)))

    /*
     * The impossible facts, rejected rather than deleted.
     *
     * `review_status` is one of the two columns the append-only trigger lets an
     * assertion change after insertion (ADR 0002), and a rejected assertion is
     * invisible to every read while its row, its evidence and its provenance
     * stay exactly where they are. The audit entry below names the ids, so a
     * retype decided too fast is undone by hand rather than by archaeology.
     */
    const rejectedIds = [...new Set(conflicts.map((conflict) => conflict.assertionId))]
    if (rejectedIds.length > 0) {
      await db
        .update(assertions)
        .set({ reviewStatus: 'rejected' })
        .where(and(inArray(assertions.id, rejectedIds), eq(assertions.userId, userId)))
    }

    await db.insert(auditLog).values({
      userId,
      action: 'entity_retyped',
      subjectKind: 'entity',
      subjectId: row.id,
      detail: {
        from: row.nodeType,
        to: target.key,
        entityIds: memberIds,
        rejectedAssertionIds: rejectedIds,
      },
    })

    return {
      entityId: row.id,
      entityIds: memberIds,
      previousNodeType: row.nodeType,
      nodeType: target.key,
      applied: true,
      conflicts,
      rejected: rejectedIds.length,
    }
  })
}

/**
 * A Devil Fruit the graph filed under « Pouvoir ».
 *
 * Named by the only thing that identifies one without reading the chapter
 * again: a name ending in « no Mi ». Deliberately a suffix and nothing cleverer
 * — matching « no mi » anywhere would catch a sentence, and guessing from the
 * relations would be inventing an opinion about entities the reader can read
 * for themselves.
 */
export interface FiledFruit {
  entityId: string
  label: string
}

export interface FruitReclassification {
  retyped: FiledFruit[]
  /**
   * Left exactly as they were.
   *
   * A bulk pass never rejects a fact. Where the ontology says the change would
   * cost something, the decision belongs on the fiche, in front of the list of
   * what it costs — which is why these carry a count and a link rather than a
   * result.
   */
  blocked: Array<FiledFruit & { conflicts: number }>
  failed: Array<FiledFruit & { reason: string }>
}

/**
 * Every fruit still filed as a power.
 *
 * The ontology used to say a Devil Fruit *was* a power — the description handed
 * to the extraction step said so in as many words — so a library imported
 * before that was corrected has every fruit in the wrong place, beside the
 * techniques they grant. Correcting them one fiche at a time is right for one
 * fruit and absurd for eighty.
 */
export async function devilFruitsFiledAsPowers(
  userId: string,
): Promise<FiledFruit[]> {
  return withIngest(async (db) => {
    const rows = await db
      .select({
        entityId: entities.id,
        label: entityLabels.label,
        precedence: entityLabels.precedence,
      })
      .from(entities)
      .innerJoin(entityLabels, eq(entityLabels.entityId, entities.id))
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.nodeType, 'power'),
          eq(entityLabels.userId, userId),
          like(entityLabels.normalizedLabel, '% no mi'),
        ),
      )
      .orderBy(desc(entityLabels.precedence))

    // The name the entity is called by, one row per entity: a fruit that also
    // carries the English wording as a search-only name is one fruit.
    const best = new Map<string, string>()
    for (const row of rows) {
      if (!best.has(row.entityId)) best.set(row.entityId, row.label)
    }

    return [...best].map(([entityId, label]) => ({ entityId, label }))
  })
}

/**
 * File them all where they belong, and say what was left behind.
 *
 * One transaction per fruit rather than one for the lot, on purpose: a fruit
 * whose facts stand in the way must not take the other seventy-nine down with
 * it. Members of the same identity component are skipped after the first, which
 * retyped them all anyway.
 */
export async function retypeDevilFruitsAsObjects(
  userId: string,
): Promise<FruitReclassification> {
  const candidates = await devilFruitsFiledAsPowers(userId)
  const out: FruitReclassification = { retyped: [], blocked: [], failed: [] }
  const done = new Set<string>()

  for (const fruit of candidates) {
    if (done.has(fruit.entityId)) continue
    try {
      const result = await retypeEntity(userId, {
        entityId: fruit.entityId,
        nodeType: 'object',
      })
      for (const id of result.entityIds) done.add(id)

      if (result.applied) out.retyped.push(fruit)
      else out.blocked.push({ ...fruit, conflicts: result.conflicts.length })
    } catch (error) {
      out.failed.push({
        ...fruit,
        reason: error instanceof Error ? error.message : 'Changement impossible.',
      })
    }
  }

  return out
}

/**
 * Which facts the new type would make impossible.
 *
 * Read from the `predicates` table rather than from the shipped ontology
 * module, and for the same reason the type itself is: the table is what the
 * trigger consults on INSERT, so this check and the database's own can never
 * disagree — including about a predicate a user added after we shipped.
 *
 * Rejected assertions are skipped; a proposed one is not, because the trigger
 * validated it when it was inserted and will not look again when it is
 * accepted.
 */
async function conflictsFor(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  memberIds: string[],
  nodeType: string,
): Promise<RetypeConflict[]> {
  const rows = await db
    .select({
      id: assertions.id,
      predicate: assertions.predicate,
      subjectId: assertions.subjectEntityId,
      objectId: assertions.objectEntityId,
      objectValue: assertions.objectValue,
      subjectTypes: predicates.subjectTypes,
      objectTypes: predicates.objectTypes,
    })
    .from(assertions)
    .innerJoin(predicates, eq(predicates.key, assertions.predicate))
    .where(
      and(
        eq(assertions.userId, userId),
        ne(assertions.reviewStatus, 'rejected'),
        or(
          inArray(assertions.subjectEntityId, memberIds),
          inArray(assertions.objectEntityId, memberIds),
        ),
      ),
    )

  const members = new Set(memberIds)
  const found: Array<RetypeConflict & { otherId: string | null }> = []

  for (const fact of rows) {
    if (members.has(fact.subjectId) && !fact.subjectTypes.includes(nodeType)) {
      found.push({
        assertionId: fact.id,
        predicate: fact.predicate,
        role: 'subject',
        otherId: fact.objectId,
        // A relation may point at a string rather than at a node — « se rend à
        // "la base de la Marine" ». There is no label to look up, and quoting
        // the value is the only way to say which fact this is.
        otherLabel: fact.objectId === null ? literalOf(fact.objectValue) : null,
        accepts: fact.subjectTypes,
      })
    }
    // Both ends at once when a relation loops back onto the component: two
    // separate reasons the same row cannot stand, and the reader is owed both.
    if (
      fact.objectId !== null &&
      members.has(fact.objectId) &&
      !fact.objectTypes.includes(nodeType)
    ) {
      found.push({
        assertionId: fact.id,
        predicate: fact.predicate,
        role: 'object',
        otherId: fact.subjectId,
        otherLabel: null,
        accepts: fact.objectTypes,
      })
    }
  }

  /*
   * The other end, named.
   *
   * « le prédicat owns n'accepte pas un objet de type power » is what the
   * database would have said and is unreadable as a reason to keep or drop a
   * fact. « Baggy possède ceci » is the same information with the thing in it.
   * Unbounded on purpose: this is a list of what stands in the way of a write,
   * not a view of the story — and the alternative, a name withheld because the
   * fact sits past the slider, would ask the reader to confirm the destruction
   * of something the interface refused to name.
   */
  const otherIds = [
    ...new Set(found.map((c) => c.otherId).filter((id): id is string => id !== null)),
  ]

  const labels =
    otherIds.length === 0
      ? []
      : await db
          .select({
            entityId: entityLabels.entityId,
            label: entityLabels.label,
            precedence: entityLabels.precedence,
          })
          .from(entityLabels)
          .where(
            and(
              inArray(entityLabels.entityId, otherIds),
              eq(entityLabels.userId, userId),
            ),
          )

  const best = new Map<string, { label: string; precedence: number }>()
  for (const label of labels) {
    const held = best.get(label.entityId)
    if (!held || label.precedence > held.precedence) {
      best.set(label.entityId, { label: label.label, precedence: label.precedence })
    }
  }

  return found.map(({ otherId, ...conflict }) => ({
    ...conflict,
    otherLabel:
      otherId === null ? conflict.otherLabel : (best.get(otherId)?.label ?? null),
  }))
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

/**
 * Every row that is the same thing as this one, whatever the reader has read.
 *
 * The projection computes this at a boundary, because *seeing* two nodes as one
 * is knowledge that arrives with a chapter. Writing is the other case: a type is
 * a property of the thing, and retyping only the halves visible from where the
 * slider happens to sit would leave the library holding two answers to « what is
 * this » with no page on which the disagreement is visible.
 */
async function componentOf(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  userId: string,
  entityId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      subjectId: assertions.subjectEntityId,
      objectId: assertions.objectEntityId,
    })
    .from(assertions)
    .where(
      and(
        eq(assertions.userId, userId),
        eq(assertions.predicate, 'same_as'),
        eq(assertions.reviewStatus, 'accepted'),
        isNotNull(assertions.objectEntityId),
      ),
    )

  const neighbours = new Map<string, string[]>()
  const link = (from: string, to: string): void => {
    const list = neighbours.get(from) ?? []
    list.push(to)
    neighbours.set(from, list)
  }
  for (const row of rows) {
    if (row.objectId === null) continue
    link(row.subjectId, row.objectId)
    link(row.objectId, row.subjectId)
  }

  const seen = new Set([entityId])
  const queue = [entityId]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const next of neighbours.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }

  return [...seen].sort()
}
