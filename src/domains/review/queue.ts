import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import { entityLabels } from '@/db/schema/knowledge.ts'
import type { EvidenceRef } from '@/domains/ai/schemas.ts'
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
}

export interface ReviewQueue {
  runId: string
  chapterId: string
  chapterNumber: number
  chapterTitle: string | null
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

    return { head, rows, counts, explicit: explicit?.count ?? 0 }
  })

  if (!data) return null

  const { evidenceByRef, labelById } = await resolveEvidence(
    userId,
    data.head.chapterId,
    data.rows,
  )

  const byStatus = new Map(data.counts.map((row) => [row.status, Number(row.count)]))

  return {
    runId,
    chapterId: data.head.chapterId,
    chapterNumber: data.head.chapterNumber,
    chapterTitle: data.head.chapterTitle,
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
