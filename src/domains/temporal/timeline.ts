import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { assertions, entities, entityLabels, events, mysteries } from '@/db/schema/knowledge.ts'

/**
 * The reader's own axis: what they know, in the order they came to know it.
 *
 * *Revelation time* is when the reader learned something. *Story time* is when
 * it happened, and this module no longer tries to order by it — `chronology.ts`
 * does, reading the library whole rather than at the reader's cursor.
 *
 * The split is not tidiness. Ordering by story time from here produced a page
 * that correctly reported having nothing: `events.story_time` was written by
 * nothing at all, because no extraction field ever asked for it. The column is
 * filled now, from a dated phrase the chapter can be quoted for, and the axis
 * that reads it needs the whole library rather than a prefix of it — almost
 * every ancient scene in this work is dated by a late chapter.
 *
 * What stays here is the axis the boundary serves well, and the one `/mysteres`
 * reads. `describeStoryTime()` stays too: the story thread shows an event's
 * in-world moment beside it, which is a label on a beat and not an ordering.
 *
 * Story time is deliberately a union of shapes rather than a date. Most events
 * in this work have no date at all, only an order relative to other events.
 * Rendering "unknown" as a position on a line would fabricate precision the
 * pages do not contain.
 */

export interface TimelineEntry {
  entityId: string
  label: string
  summary: string | null
  /** The chapter that showed or told this. The revelation axis. */
  knownFromChapter: number
  /** True when the chapter presents it as a memory or a recounting. */
  isFlashback: boolean
  /** Null when the pages give no in-world time. Not a zero — an absence. */
  storyTime: StoryTimeView | null
  kind: 'event' | 'mystery'
  /** For mysteries: whether the reader has seen it resolved yet. */
  state: string | null
  resolvedInChapter: number | null
  /**
   * When the row was written. Not shown — it breaks ties, and only ties.
   *
   * Everything a chapter reveals shares one revelation number, so a chapter's
   * own events are all equal on the only axis this list sorts by. With nothing
   * further to compare, the order was whatever PostgreSQL happened to return
   * for a query with no ORDER BY: chapter 5 showed Kuina's death before the
   * duel that precedes it, and the arrangement could change on its own after a
   * VACUUM.
   *
   * Publication order is the closest thing to narrative order that survives
   * into this table. It follows the review queue, which follows extraction,
   * which walks the chapter's passages in order — a chain of approximations,
   * but a stable one, and stable is the property that was missing. The real
   * fix is an event knowing which passage it came from, which the schema does
   * not record.
   */
  recordedAt: number
}

export interface StoryTimeView {
  kind: 'exact' | 'approximate' | 'relative' | 'unknown'
  description: string
}

export interface Timeline {
  boundaryChapter: number
  /** Ordered by revelation: the order the reader actually met them. */
  byRevelation: TimelineEntry[]
}

export async function getTimeline(
  userId: string,
  boundaryChapter: number,
): Promise<Timeline> {
  const entries = await withBoundary({ userId, boundaryChapter }, async (db) => {
    const eventRows = await db
      .select({
        entityId: events.entityId,
        summary: events.summary,
        storyTime: events.storyTime,
        isFlashback: events.isFlashback,
        shownInChapter: events.shownInChapter,
        toldInChapter: events.toldInChapter,
        createdAt: events.createdAt,
      })
      .from(events)
      .innerJoin(entities, eq(entities.id, events.entityId))

    const mysteryRows = await db
      .select({
        entityId: mysteries.entityId,
        question: mysteries.question,
        openedInChapter: mysteries.openedInChapter,
        state: mysteries.state,
        resolvedInChapter: mysteries.resolvedInChapter,
        createdAt: mysteries.createdAt,
      })
      .from(mysteries)
      .innerJoin(entities, eq(entities.id, mysteries.entityId))

    const ids = [
      ...eventRows.map((row) => row.entityId),
      ...mysteryRows.map((row) => row.entityId),
    ]

    const labels =
      ids.length === 0
        ? []
        : await db
            .select({
              entityId: entityLabels.entityId,
              label: entityLabels.label,
              precedence: entityLabels.precedence,
            })
            .from(entityLabels)
            .where(inArray(entityLabels.entityId, ids))
            .orderBy(sql`${entityLabels.precedence} DESC`)

    return { eventRows, mysteryRows, labels }
  })

  const labelOf = new Map<string, string>()
  for (const row of entries.labels) {
    if (!labelOf.has(row.entityId)) labelOf.set(row.entityId, row.label)
  }

  const all: TimelineEntry[] = [
    ...entries.eventRows.map((row): TimelineEntry => ({
      entityId: row.entityId,
      label: labelOf.get(row.entityId) ?? 'événement sans nom',
      summary: row.summary,
      // Told beats shown: a chapter that *recounts* an event is where the
      // reader learned of it, even if the art shows it later.
      knownFromChapter: row.toldInChapter ?? row.shownInChapter ?? 0,
      isFlashback: row.isFlashback,
      storyTime: describeStoryTime(row.storyTime),
      kind: 'event',
      state: null,
      resolvedInChapter: null,
      recordedAt: row.createdAt.getTime(),
    })),
    ...entries.mysteryRows.map((row): TimelineEntry => ({
      entityId: row.entityId,
      label: labelOf.get(row.entityId) ?? row.question.slice(0, 80),
      summary: row.question,
      knownFromChapter: row.openedInChapter,
      isFlashback: false,
      storyTime: null,
      kind: 'mystery',
      state: row.state,
      /*
       * A resolution the reader has not reached yet must not be shown as one.
       * The row is visible because the mystery opened before the boundary; its
       * resolution chapter is a fact about a chapter they have not read.
       */
      resolvedInChapter:
        row.resolvedInChapter !== null && row.resolvedInChapter <= boundaryChapter
          ? row.resolvedInChapter
          : null,
      recordedAt: row.createdAt.getTime(),
    })),
  ]

  return {
    boundaryChapter,
    byRevelation: all.sort(
      (a, b) => a.knownFromChapter - b.knownFromChapter || a.recordedAt - b.recordedAt,
    ),
  }
}

/**
 * Turn the stored story-time union into something displayable.
 *
 * The uncertainty is preserved in the text rather than smoothed away. "Environ
 * vingt ans plus tôt" is what the pages support; converting it to a year would
 * be inventing a fact to make a chart easier to draw.
 */
export function describeStoryTime(value: unknown): StoryTimeView | null {
  if (value === null || typeof value !== 'object') return null
  const time = value as Record<string, unknown>

  switch (time.kind) {
    case 'exact': {
      const parts = [time.year, time.month, time.day].filter(
        (part) => part !== undefined && part !== null,
      )
      return { kind: 'exact', description: parts.join('-') }
    }
    case 'approximate':
      return {
        kind: 'approximate',
        description:
          typeof time.description === 'string'
            ? time.description
            : `environ ${String(time.yearsAgo ?? '?')} ans plus tôt`,
      }
    case 'relative':
      return {
        kind: 'relative',
        description: typeof time.note === 'string' ? time.note : 'ordre relatif connu',
      }
    default:
      return { kind: 'unknown', description: 'moment inconnu' }
  }
}

/**
 * What one chapter added to the graph.
 *
 * Read at the chapter's own boundary and compared against the boundary just
 * before it, because "new" only means anything relative to a moment. Computed
 * rather than stored: a stored delta would have to be recomputed whenever an
 * earlier chapter was corrected, and would silently go stale if it were not.
 */
export interface NarrativeDelta {
  chapterNumber: number
  chapterTitle: string | null
  newEntities: Array<{ id: string; label: string; nodeType: string }>
  newFacts: Array<{
    id: string
    predicate: string
    subjectLabel: string
    objectLabel: string | null
    epistemicStatus: string
  }>
  /** Beliefs this chapter closed. The most interesting part of any delta. */
  refuted: Array<{ id: string; predicate: string; subjectLabel: string; heldSince: number }>
  newNames: Array<{ entityId: string; label: string; kind: string; previous: string | null }>
  openedMysteries: string[]
}

export async function getNarrativeDelta(
  userId: string,
  chapterNumber: number,
): Promise<NarrativeDelta | null> {
  // Chapter metadata is ownership-scoped, not boundary-scoped: knowing you
  // imported chapter 40 is not knowing what happens in it.
  const meta = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ title: chapters.title })
      .from(chapters)
      .where(
        and(eq(chapters.userId, userId), eq(chapters.number, chapterNumber)),
      )
      .limit(1)
    return chapter ?? null
  })

  if (!meta) return null

  /*
   * Two boundaries, one after the other — and never one inside the other.
   *
   * This chapter's own reads happen here; what it *refutes* is invisible at its
   * own boundary and is read below, at the chapter before. Both are needed and
   * the order between them is free, but nesting the second inside the first is
   * not: a transaction holds its connection for as long as it runs, so a nested
   * read asks the pool for a second connection while the code holding the first
   * waits for it. With a pool sized for a serverless instance that is not a
   * slow page, it is an instance frozen with its connections checked out —
   * exactly the failure withIngest() documents, on the other pool.
   */
  const current = await withBoundary({ userId, boundaryChapter: chapterNumber }, async (db) => {
    const newEntities = await db
      .select({
        id: entities.id,
        nodeType: entities.nodeType,
        // `entities.id` written out, never interpolated: a `${entities.id}`
        // renders unqualified here and binds to `entity_labels`' own `id`,
        // which matches nothing and reads as an unnamed entity. See
        // entity-sheet.ts for the full account.
        label: sql<string | null>`(
          SELECT l.label FROM entity_labels l
          WHERE l.entity_id = entities.id
          ORDER BY l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
        )`,
      })
      .from(entities)
      .where(eq(entities.firstSeenChapter, chapterNumber))

    const facts = await db
      .select({
        id: assertions.id,
        predicate: assertions.predicate,
        epistemicStatus: assertions.epistemicStatus,
        subjectLabel: sql<string | null>`(
          SELECT l.label FROM entity_labels l
          WHERE l.entity_id = assertions.subject_entity_id
          ORDER BY l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
        )`,
        objectLabel: sql<string | null>`(
          SELECT l.label FROM entity_labels l
          WHERE l.entity_id = assertions.object_entity_id
          ORDER BY l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
        )`,
      })
      .from(assertions)
      .where(eq(assertions.knowledgeFromChapter, chapterNumber))

    const names = await db
      .select({
        entityId: entityLabels.entityId,
        label: entityLabels.label,
        kind: entityLabels.kind,
      })
      .from(entityLabels)
      .where(eq(entityLabels.revealedInChapter, chapterNumber))

    /*
     * Mysteries this chapter *opened*.
     *
     * This read every mystery opened at or before the chapter, in a structure
     * whose every other field answers "what changed here". On the delta page
     * the difference is a section that grows quietly with the library; told
     * forward, chapter by chapter, it would restate the entire stack of open
     * questions under every chapter heading.
     */
    const opened = await db
      .select({ question: mysteries.question })
      .from(mysteries)
      .where(eq(mysteries.openedInChapter, chapterNumber))

    return { newEntities, facts, names, opened }
  })

  /*
   * The chapter before, in its own transaction.
   *
   * Two things live there and only there: the beliefs this chapter closes —
   * invisible at their own chapter, because that is what refuting one means —
   * and what each newly named entity was called until now, so the delta can say
   * "the man in the striped scarf turns out to be Kaelo Renn".
   */
  const before = await withBoundary(
    { userId, boundaryChapter: Math.max(0, chapterNumber - 1) },
    async (db) => {
      const refuted = await db
        .select({
          id: assertions.id,
          predicate: assertions.predicate,
          heldSince: assertions.knowledgeFromChapter,
          subjectLabel: sql<string | null>`(
            SELECT l.label FROM entity_labels l
            WHERE l.entity_id = assertions.subject_entity_id
            ORDER BY l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
          )`,
        })
        .from(assertions)
        .where(eq(assertions.knowledgeUntilChapter, chapterNumber))

      const previousNames =
        current.names.length === 0
          ? []
          : await db
              .select({
                entityId: entityLabels.entityId,
                label: entityLabels.label,
              })
              .from(entityLabels)
              .where(
                inArray(
                  entityLabels.entityId,
                  current.names.map((name) => name.entityId),
                ),
              )
              .orderBy(sql`${entityLabels.precedence} DESC`)

      return { refuted, previousNames }
    },
  )

  const previousByEntity = new Map<string, string>()
  for (const row of before.previousNames) {
    if (!previousByEntity.has(row.entityId)) previousByEntity.set(row.entityId, row.label)
  }

  return {
    chapterNumber,
    chapterTitle: meta.title,
    newEntities: current.newEntities.map((row) => ({
      id: row.id,
      label: row.label ?? 'entité sans nom révélé',
      nodeType: row.nodeType,
    })),
    newFacts: current.facts.map((row) => ({
      id: row.id,
      predicate: row.predicate,
      subjectLabel: row.subjectLabel ?? 'entité sans nom',
      objectLabel: row.objectLabel,
      epistemicStatus: row.epistemicStatus,
    })),
    refuted: before.refuted.map((row) => ({
      id: row.id,
      predicate: row.predicate,
      subjectLabel: row.subjectLabel ?? 'entité sans nom',
      heldSince: row.heldSince,
    })),
    newNames: current.names.map((row) => ({
      entityId: row.entityId,
      label: row.label,
      kind: row.kind,
      previous: previousByEntity.get(row.entityId) ?? null,
    })),
    openedMysteries: current.opened.map((row) => row.question),
  }
}
