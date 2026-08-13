import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import { entities, entityLabels } from '@/db/schema/knowledge.ts'
import type { EvidenceRef } from '@/domains/ai/schemas.ts'
import {
  checkTypes,
  OCCURRENCE_TYPES,
  type TypeMismatch,
} from '@/domains/knowledge/ontology.ts'
import { groupDuplicates, type DuplicateInfo } from '@/domains/review/duplicates.ts'
import { findEcho, type Echo } from '@/domains/review/echoes.ts'
import { storage } from '@/domains/storage/index.ts'

/**
 * The review queue, assembled for a human to read.
 *
 * Every item arrives with its evidence resolved: the source panel's image, the
 * exact text it was drawn from, and the panel's own description. That assembly is
 * the whole job of this module, and it is what makes review possible rather than
 * an act of faith — a proposal shown without its source is a claim asking to be
 * believed, and the answer to "is this right" is then whatever the reviewer
 * feels about the model that day.
 *
 * Ordered by priority, not chronology. Identity and revelation proposals come
 * first because their mistakes are the ones that quietly rewrite the past; a
 * queue in insertion order buries them behind forty easy relations and gets them
 * approved by momentum.
 */

export interface EvidenceView {
  kind: 'text' | 'visual'
  excerpt: string
  ref: string
  /** Signed, short-lived. Null when the ref did not resolve to a panel. */
  panelImageUrl: string | null
  /** The panel's own factual description, when one exists. */
  panelDescription: string | null
  /** The full text of the cited block, so the excerpt can be seen in context. */
  blockText: string | null
  pageIndex: number | null
}

export interface ReviewItemView {
  id: string
  category: string
  priority: number
  confidence: number
  requiresExplicitReview: boolean
  status: string
  payload: unknown
  fingerprint: string
  evidence: EvidenceView[]
  /** For resolution items: the existing entity's current display label. */
  relatedLabel: string | null
  /**
   * For entity items: a rapprochement in this run that says who this already is.
   *
   * « Zoro » proposed at chapter 3 when Roronoa Zoro is already in the graph.
   * The two cards can be forty apart in the queue, and deciding this one alone
   * is how a second Zoro gets created — so the card says where the real
   * question is.
   */
  mergeSuggestion: { reviewItemId: string; existingLabel: string | null } | null
  /**
   * Names for the identifiers this proposal mentions.
   *
   * A relation stores its two ends as identifiers, and which kind depends on
   * when the entity was published: `e3` for one proposed in the same response,
   * a UUID for one already in the graph — including one accepted five minutes
   * earlier in this very review. Shown raw, the card reads
   * « 9fdd1160-… capture 5da604bb-… », which is a question nobody can answer.
   *
   * Only the ids that resolve appear here; the card falls back to the raw one
   * rather than inventing a name for it.
   */
  names: Record<string, string>
  /**
   * For relations: why this one cannot be written, and what could be.
   *
   * A predicate carries the types it accepts, and the database refuses an edge
   * that disagrees with them (ADR 0004). It was refusing them at the last
   * possible moment: after « Publier », in a red block listing what did not
   * make it, with nothing left to do about it. « Monkey D. Luffy member_of
   * Village de Fuchsia » is the shape it takes — a true fact wearing a
   * predicate meant for crews.
   *
   * Computed here because here is where both ends are already known by name,
   * which means their node types are one join away. Null when the relation
   * agrees, when the predicate is one the ontology does not know, or when an
   * end could not be resolved — in the last two cases nothing can be said
   * honestly, and the database still fails closed behind us.
   */
  typeMismatch: TypeMismatch | null
  /**
   * Set when another item of this run proposes the same thing.
   *
   * Counted over every item of the run, not just the pending page: a copy
   * accepted in an earlier batch is exactly the one that changes the right
   * answer for the card on screen, and it is no longer in the queue.
   */
  duplicate: DuplicateInfo | null
  /**
   * Set when the graph already holds something worded almost like this.
   *
   * `duplicate` is the neighbouring signal and answers about *this run*, word
   * for word. This one looks at what is already published, and tolerates
   * rephrasing — which is what a second processing pass produces, and what
   * neither of the exact checks could ever see.
   */
  echo: Echo | null
}

export interface ReviewQueue {
  runId: string
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
  /**
   * Whether the chapter has been opened to the reader.
   *
   * The queue is where a review ends, so it is where the answer belongs: a
   * chapter with nothing left proposed and no publication is a chapter whose
   * facts exist and are hidden, and that is worth a button rather than a
   * mystery.
   */
  chapterPublished: boolean
  items: ReviewItemView[]
  counts: {
    pending: number
    accepted: number
    rejected: number
    deferred: number
    requiringExplicitReview: number
  }
}

export async function getReviewQueue(
  userId: string,
  runId: string,
  options: { limit?: number; includeDecided?: boolean } = {},
): Promise<ReviewQueue | null> {
  const limit = options.limit ?? 100

  const data = await withIngest(async (db) => {
    const [head] = await db
      .select({
        chapterId: reviewItems.chapterId,
        chapterNumber: chapters.number,
        chapterTitle: chapters.title,
        chapterStatus: chapters.status,
      })
      .from(reviewItems)
      .innerJoin(chapters, eq(chapters.id, reviewItems.chapterId))
      .where(and(eq(reviewItems.runId, runId), eq(reviewItems.userId, userId)))
      .limit(1)

    if (!head) return null

    const rows = await db
      .select({
        id: reviewItems.id,
        category: reviewItems.category,
        priority: reviewItems.priority,
        confidence: reviewItems.confidence,
        requiresExplicitReview: reviewItems.requiresExplicitReview,
        status: reviewItems.status,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          ...(options.includeDecided ? [] : [eq(reviewItems.status, 'proposed')]),
        ),
      )
      .orderBy(desc(reviewItems.priority), asc(reviewItems.confidence))
      .limit(limit)

    /*
     * Every item of the run, decided ones included, for duplicate grouping.
     *
     * Separate from the display query on purpose. That one is paginated and
     * filtered to what is still pending, which is right for what it shows and
     * wrong for this: the copy that matters most is the one already accepted and
     * therefore absent from the queue. Same ordering, so the rank shown to the
     * reviewer ("2e des 3") follows the order they are walking.
     */
    const forGrouping = await db
      .select({
        id: reviewItems.id,
        category: reviewItems.category,
        payload: reviewItems.payload,
        status: reviewItems.status,
        fingerprint: reviewItems.proposalFingerprint,
      })
      .from(reviewItems)
      .where(and(eq(reviewItems.runId, runId), eq(reviewItems.userId, userId)))
      .orderBy(desc(reviewItems.priority), asc(reviewItems.confidence))

    const counts = await db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int AS count
      FROM review_items
      WHERE run_id = ${runId} AND user_id = ${userId}
      GROUP BY status
    `)

    const [explicit] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          eq(reviewItems.status, 'proposed'),
          eq(reviewItems.requiresExplicitReview, true),
        ),
      )

    return { head, rows, forGrouping, counts, explicit: explicit?.count ?? 0 }
  })

  if (!data) return null

  const { evidenceByRef, labelById } = await resolveEvidence(
    userId,
    data.head.chapterId,
    data.rows,
  )

  const byStatus = new Map(data.counts.map((row) => [row.status, Number(row.count)]))
  const duplicates = groupDuplicates(data.forGrouping)
  const echoes = await publishedEchoes(userId, data.head.chapterId, data.rows)
  // Over the whole run, not the page: a relation shown here routinely names an
  // entity whose own card was published in an earlier batch.
  const names = await resolveNames(data.rows, data.forGrouping)
  const merges = await pendingMerges(data.forGrouping)
  const nodeTypes = await resolveNodeTypes(data.rows, data.forGrouping)

  return {
    runId,
    chapterId: data.head.chapterId,
    chapterNumber: data.head.chapterNumber,
    chapterTitle: data.head.chapterTitle,
    chapterPublished: data.head.chapterStatus === 'published',
    items: data.rows.map((row) => ({
      id: row.id,
      category: row.category,
      priority: row.priority,
      confidence: row.confidence,
      requiresExplicitReview: row.requiresExplicitReview,
      status: row.status,
      payload: row.payload,
      fingerprint: row.fingerprint,
      evidence: evidenceRefsOf(row.payload).map(
        (ref): EvidenceView => ({
          kind: ref.kind,
          excerpt: ref.excerpt,
          ref: ref.ref,
          ...(evidenceByRef.get(ref.ref) ?? {
            panelImageUrl: null,
            panelDescription: null,
            blockText: null,
            pageIndex: null,
          }),
        }),
      ),
      relatedLabel: relatedEntityId(row.payload)
        ? (labelById.get(relatedEntityId(row.payload)!) ?? null)
        : null,
      duplicate: duplicates.get(row.id) ?? null,
      echo: echoes.get(row.id) ?? null,
      mergeSuggestion:
        row.category === 'entity' ? (merges.get(row.fingerprint) ?? null) : null,
      typeMismatch:
        row.category === 'assertion' ? mismatchOf(row.payload, nodeTypes) : null,
      names: Object.fromEntries(
        referencedIds(row.payload)
          .map((id) => [id, names.get(id)] as const)
          .filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
      ),
    })),
    counts: {
      pending: byStatus.get('proposed') ?? 0,
      accepted: byStatus.get('accepted') ?? 0,
      rejected: byStatus.get('rejected') ?? 0,
      deferred: byStatus.get('deferred') ?? 0,
      requiringExplicitReview: data.explicit,
    },
  }
}

/**
 * Resolve every ref the queue cites, in two queries rather than per item.
 *
 * A review page shows fifty items with two or three citations each; resolving
 * them one at a time is a hundred and fifty round trips and a page that takes
 * seconds to open. The refs are rebuilt from the chapter's panels and blocks in
 * the same order the pipeline generated them, which is deterministic — that
 * determinism is what makes the mapping reconstructible after the run's
 * in-memory table is long gone.
 */
async function resolveEvidence(
  userId: string,
  chapterId: string,
  rows: Array<{ payload: unknown }>,
): Promise<{
  evidenceByRef: Map<
    string,
    {
      panelImageUrl: string | null
      panelDescription: string | null
      blockText: string | null
      pageIndex: number | null
    }
  >
  labelById: Map<string, string>
}> {
  const refs = new Set(rows.flatMap((row) => evidenceRefsOf(row.payload).map((r) => r.ref)))
  const entityIds = rows
    .map((row) => relatedEntityId(row.payload))
    .filter((id): id is string => id !== null)

  const { panelRows, blockRows, labels } = await withIngest(async (db) => {
    const pageRows = await db
      .select({
        id: pages.id,
        index: pages.index,
        displayKey: pages.storageKeyDisplay,
      })
      .from(pages)
      .where(and(eq(pages.chapterId, chapterId), eq(pages.userId, userId)))
      .orderBy(asc(pages.index))

    const panelList = await db
      .select({
        id: panels.id,
        pageId: panels.pageId,
        index: panels.index,
        description: panels.description,
      })
      .from(panels)
      .where(and(eq(panels.chapterId, chapterId), eq(panels.userId, userId)))
      .orderBy(asc(panels.index))

    const blockList = await db
      .select({ id: textBlocks.id, text: textBlocks.text, pageId: textBlocks.pageId })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))
      .orderBy(asc(textBlocks.readingOrder))

    const labelRows =
      entityIds.length === 0
        ? []
        : await db
            .select({
              entityId: entityLabels.entityId,
              label: entityLabels.label,
              precedence: entityLabels.precedence,
            })
            .from(entityLabels)
            .where(inArray(entityLabels.entityId, entityIds))
            .orderBy(desc(entityLabels.precedence))

    return {
      panelRows: panelList.map((panel) => ({
        ...panel,
        pageIndex: pageRows.find((page) => page.id === panel.pageId)?.index ?? 0,
        displayKey:
          pageRows.find((page) => page.id === panel.pageId)?.displayKey ?? null,
      })),
      blockRows: blockList,
      labels: labelRows,
    }
  })

  const store = storage()
  const evidenceByRef = new Map<
    string,
    {
      panelImageUrl: string | null
      panelDescription: string | null
      blockText: string | null
      pageIndex: number | null
    }
  >()

  // Panel refs, rebuilt the way the pipeline built them: p<page+1>c<index+1>.
  for (const panel of panelRows) {
    const ref = `p${panel.pageIndex + 1}c${panel.index + 1}`
    if (!refs.has(ref)) continue
    evidenceByRef.set(ref, {
      panelImageUrl: panel.displayKey ? await store.signedUrl(panel.displayKey) : null,
      panelDescription: panel.description,
      blockText: null,
      pageIndex: panel.pageIndex,
    })
  }

  // Block refs, b<index+1> over the same reading order.
  for (const [index, block] of blockRows.entries()) {
    const ref = `b${index + 1}`
    if (!refs.has(ref)) continue
    evidenceByRef.set(ref, {
      panelImageUrl: null,
      panelDescription: null,
      blockText: block.text,
      pageIndex: null,
    })
  }

  const labelById = new Map<string, string>()
  for (const label of labels) {
    if (!labelById.has(label.entityId)) labelById.set(label.entityId, label.label)
  }

  return { evidenceByRef, labelById }
}

/**
 * The rapprochements still open, by the proposal each one is about.
 *
 * A resolution names its candidate by fingerprint, which is what lets an entity
 * card point at the question that actually decides it. Only the undecided ones:
 * a rapprochement already answered is not something to send the reviewer to.
 */
/**
 * What the graph already holds that reads like one of these proposals.
 *
 * Only events and mysteries, and only the pending ones. For those two
 * categories the entity's label *is* its text, so a resemblance between labels
 * is a resemblance between the things themselves — which is not true of a
 * character, where two people can share a name and the question of whether they
 * are one person belongs to entity resolution.
 *
 * One query per proposal, which is affordable because it is bounded twice: to
 * the page being reviewed, and inside `findEcho` by a trigram index scan.
 */
async function publishedEchoes(
  userId: string,
  chapterId: string,
  rows: Array<{ id: string; category: string; status: string; payload: unknown }>,
): Promise<Map<string, Echo>> {
  const pending = rows.filter(
    (row) =>
      row.status === 'proposed' && (row.category === 'event' || row.category === 'mystery'),
  )
  if (pending.length === 0) return new Map()

  return withIngest(async (db) => {
    const [chapter] = await db
      .select({ workId: chapters.workId, number: chapters.number })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) return new Map<string, Echo>()

    const found = new Map<string, Echo>()
    for (const row of pending) {
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const text = row.category === 'event' ? payload.summary : payload.question
      if (typeof text !== 'string' || text.length === 0) continue

      const echo = await findEcho(db, {
        workId: chapter.workId,
        userId,
        // All three occurrence types for an event: the resemblance the reviewer
        // is shown must not depend on which flavour the earlier copy was
        // published under.
        nodeTypes: row.category === 'event' ? OCCURRENCE_TYPES : ['mystery'],
        text,
        chapterNumber: chapter.number,
      })
      if (echo) found.set(row.id, echo)
    }
    return found
  })
}

async function pendingMerges(
  proposals: Array<{
    id: string
    category: string
    payload: unknown
    status: string
    fingerprint: string
  }>,
): Promise<Map<string, { reviewItemId: string; existingLabel: string | null }>> {
  const open = proposals.filter(
    (row) => row.category === 'resolution' && row.status === 'proposed',
  )
  if (open.length === 0) return new Map()

  const targets = new Map<string, { reviewItemId: string; entityId: string }>()
  for (const row of open) {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const fingerprint = payload.candidateFingerprint
    const entityId = payload.existingEntityId
    if (typeof fingerprint !== 'string' || typeof entityId !== 'string') continue
    // The first one shown wins: two rapprochements about one proposal is a
    // question the reviewer answers by opening them, not one to summarise here.
    if (!targets.has(fingerprint)) targets.set(fingerprint, { reviewItemId: row.id, entityId })
  }
  if (targets.size === 0) return new Map()

  const labels = await withIngest((db) =>
    db
      .select({ entityId: entityLabels.entityId, label: entityLabels.label })
      .from(entityLabels)
      .where(inArray(entityLabels.entityId, [...targets.values()].map((t) => t.entityId)))
      .orderBy(desc(entityLabels.precedence)),
  )

  const labelById = new Map<string, string>()
  for (const row of labels) if (!labelById.has(row.entityId)) labelById.set(row.entityId, row.label)

  return new Map(
    [...targets].map(([fingerprint, target]) => [
      fingerprint,
      {
        reviewItemId: target.reviewItemId,
        existingLabel: labelById.get(target.entityId) ?? null,
      },
    ]),
  )
}

/** What a stored entity id looks like, as opposed to a per-response local id. */
const STORED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Put a name on every identifier the queue is about to display.
 *
 * Two populations, because a proposal names entities from two different places.
 * A UUID is an entity already in the graph and its name is read from the
 * database. A short id like `e3` belongs to the response it came from, and is
 * answered by that run's own entity proposals — including the ones still
 * waiting on a decision, which is the point: a relation and its subject are
 * proposed together and reviewed together.
 *
 * A local id claimed by two different entities resolves to nothing. Slices
 * number their entities independently, so `e1` in one is not `e1` in the next,
 * and putting the first slice's name on the second slice's relation is worse
 * than showing the raw id — one is unreadable, the other is wrong.
 */
async function resolveNames(
  rows: Array<{ payload: unknown }>,
  proposals: Array<{ category: string; payload: unknown }>,
): Promise<Map<string, string>> {
  const wanted = new Set(rows.flatMap((row) => referencedIds(row.payload)))
  if (wanted.size === 0) return new Map()

  const names = new Map<string, string>()

  const claimed = new Map<string, string | null>()
  for (const proposal of proposals) {
    if (proposal.category !== 'entity') continue
    if (proposal.payload === null || typeof proposal.payload !== 'object') continue
    const record = proposal.payload as Record<string, unknown>
    const localId = typeof record.local_id === 'string' ? record.local_id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (localId.length === 0 || label.length === 0) continue

    if (!claimed.has(localId)) claimed.set(localId, label)
    else if (claimed.get(localId) !== label) claimed.set(localId, null)
  }
  for (const [localId, label] of claimed) {
    if (label !== null && wanted.has(localId)) names.set(localId, label)
  }

  const storedIds = [...wanted].filter((id) => STORED_ID.test(id))
  if (storedIds.length > 0) {
    const labels = await withIngest((db) =>
      db
        .select({
          entityId: entityLabels.entityId,
          label: entityLabels.label,
        })
        .from(entityLabels)
        .where(inArray(entityLabels.entityId, storedIds))
        .orderBy(desc(entityLabels.precedence)),
    )
    for (const row of labels) if (!names.has(row.entityId)) names.set(row.entityId, row.label)
  }

  return names
}

/**
 * The node type behind every identifier a relation names.
 *
 * The same two populations resolveNames() deals with, for the same reason: an
 * end is a UUID when its entity is already in the graph and a local id like
 * `e3` when it is proposed in this very run. Both have a node type, in
 * different places — the `entities` row for one, the sibling entity proposal's
 * payload for the other.
 *
 * A local id claimed by two proposals of different types resolves to nothing,
 * exactly as it does for names. Slices number their entities independently, and
 * declaring a relation ill-typed on the strength of the wrong slice's entity
 * would be worse than saying nothing: it would put a red block on a card that
 * is fine.
 */
export async function resolveNodeTypes(
  rows: Array<{ payload: unknown }>,
  proposals: Array<{ category: string; payload: unknown }>,
): Promise<Map<string, string>> {
  const wanted = new Set(rows.flatMap((row) => referencedIds(row.payload)))
  if (wanted.size === 0) return new Map()

  const types = new Map<string, string>()

  const claimed = new Map<string, string | null>()
  for (const proposal of proposals) {
    if (proposal.category !== 'entity') continue
    if (proposal.payload === null || typeof proposal.payload !== 'object') continue
    const record = proposal.payload as Record<string, unknown>
    const localId = typeof record.local_id === 'string' ? record.local_id.trim() : ''
    const nodeType = typeof record.node_type === 'string' ? record.node_type.trim() : ''
    if (localId.length === 0 || nodeType.length === 0) continue

    if (!claimed.has(localId)) claimed.set(localId, nodeType)
    else if (claimed.get(localId) !== nodeType) claimed.set(localId, null)
  }
  for (const [localId, nodeType] of claimed) {
    if (nodeType !== null && wanted.has(localId)) types.set(localId, nodeType)
  }

  const storedIds = [...wanted].filter((id) => STORED_ID.test(id))
  if (storedIds.length > 0) {
    const rowsFound = await withIngest((db) =>
      db
        .select({ id: entities.id, nodeType: entities.nodeType })
        .from(entities)
        .where(inArray(entities.id, storedIds)),
    )
    for (const row of rowsFound) types.set(row.id, row.nodeType)
  }

  return types
}

/** The relation's two ends, checked against what its predicate accepts. */
export function mismatchOf(
  payload: unknown,
  nodeTypes: Map<string, string>,
): TypeMismatch | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>

  const predicate = typeof record.predicate === 'string' ? record.predicate : ''
  const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
  if (predicate === '' || subject === '') return null

  // An object that is a literal rather than an entity — « travels_to "la base
  // de la Marine" » — has no node type, and the database checks none either.
  const object = typeof record.object === 'string' ? record.object.trim() : ''
  const objectType = object === '' ? null : (nodeTypes.get(object) ?? null)
  if (object !== '' && objectType === null) return null

  return checkTypes(predicate, nodeTypes.get(subject) ?? null, objectType)
}

/**
 * The entities a proposal names, as opposed to the ones it proposes.
 *
 * A relation names two; an event names its participants. An entity proposal
 * names none — its own `local_id` is what the others point at.
 */
export function referencedIds(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>

  const ids = [record.subject, record.object, ...(Array.isArray(record.participants)
    ? record.participants
    : [])]

  return ids
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())
}

/**
 * Pull the evidence refs out of whatever shape a payload has.
 *
 * Categories carry evidence in different places — a conflict item nests the
 * proposal it is about — and a missing citation must not throw here: an item that
 * cannot show its source is displayed as such, which is information, rather than
 * breaking the page it appears on.
 */
function evidenceRefsOf(payload: unknown): EvidenceRef[] {
  if (payload === null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>

  if (Array.isArray(record.evidence)) return record.evidence as EvidenceRef[]

  if (record.proposal !== null && typeof record.proposal === 'object') {
    const nested = (record.proposal as Record<string, unknown>).evidence
    if (Array.isArray(nested)) return nested as EvidenceRef[]
  }

  return []
}

/** The existing entity a resolution proposal is about, if this is one. */
function relatedEntityId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>).existingEntityId
  return typeof value === 'string' ? value : null
}
