import 'server-only'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { assertions, entities, entityLabels, events, mysteries } from '@/db/schema/knowledge.ts'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

/**
 * Two timelines, kept apart.
 *
 * *Revelation time* is when the reader learned something. *Story time* is when
 * it happened. A flashback shown in chapter 40 about events fifty years earlier
 * sits at 40 on one axis and far to the left on the other, and collapsing them
 * is exactly the mistake that makes a timeline lie: it would either claim the
 * reader knew about those events all along, or that they happened in chapter 40.
 *
 * Story time is deliberately a union of shapes rather than a date. Most events
 * in this work have no date at all, only an order relative to other events.
 * Rendering "unknown" as a position on a line would fabricate precision the
 * pages do not contain, so events with no known time are grouped and labelled as
 * such rather than placed.
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
}

export interface StoryTimeView {
  kind: 'exact' | 'approximate' | 'relative' | 'unknown'
  description: string
}

export interface Timeline {
  boundaryChapter: number
  /** Ordered by revelation: the order the reader actually met them. */
  byRevelation: TimelineEntry[]
  /** Events with a known in-world position, ordered by it. */
  byStoryTime: TimelineEntry[]
  /** Events the pages place nowhere. Counted, not positioned. */
  undated: TimelineEntry[]
}

export async function getTimeline(
  userId: string,
  boundaryChapter: number,
  locale: Locale = DEFAULT_LOCALE,
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
              lang: entityLabels.lang,
              precedence: entityLabels.precedence,
            })
            .from(entityLabels)
            .where(inArray(entityLabels.entityId, ids))
            .orderBy(sql`${entityLabels.precedence} DESC`)

    return { eventRows, mysteryRows, labels }
  })

  // The reader's language first, canonical French as the fallback.
  const inLocale = new Map<string, string>()
  const inAny = new Map<string, string>()
  for (const row of entries.labels) {
    if (row.lang === locale && !inLocale.has(row.entityId)) {
      inLocale.set(row.entityId, row.label)
    }
    if (!inAny.has(row.entityId)) inAny.set(row.entityId, row.label)
  }
  const labelOf = new Map<string, string>()
  for (const [id, label] of inAny) labelOf.set(id, inLocale.get(id) ?? label)

  const all: TimelineEntry[] = [
    ...entries.eventRows.map((row): TimelineEntry => ({
      entityId: row.entityId,
      label: labelOf.get(row.entityId) ?? getDictFor(locale).common.unnamedEvent,
      summary: row.summary,
      // Told beats shown: a chapter that *recounts* an event is where the
      // reader learned of it, even if the art shows it later.
      knownFromChapter: row.toldInChapter ?? row.shownInChapter ?? 0,
      isFlashback: row.isFlashback,
      storyTime: describeStoryTime(row.storyTime, locale),
      kind: 'event',
      state: null,
      resolvedInChapter: null,
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
    })),
  ]

  const dated = all.filter((entry) => entry.storyTime !== null && entry.storyTime.kind !== 'unknown')

  return {
    boundaryChapter,
    byRevelation: [...all].sort((a, b) => a.knownFromChapter - b.knownFromChapter),
    byStoryTime: dated.sort((a, b) => storyOrder(a) - storyOrder(b)),
    undated: all.filter((entry) => !dated.includes(entry)),
  }
}

/**
 * Turn the stored story-time union into something displayable.
 *
 * The uncertainty is preserved in the text rather than smoothed away. "Environ
 * vingt ans plus tôt" is what the pages support; converting it to a year would
 * be inventing a fact to make a chart easier to draw.
 */
function describeStoryTime(
  value: unknown,
  locale: Locale = DEFAULT_LOCALE,
): StoryTimeView | null {
  if (value === null || typeof value !== 'object') return null
  const time = value as Record<string, unknown>
  const t = getDictFor(locale).timeline

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
        // A stored description was authored with the graph — canonical
        // French — and is shown as stored; only the composed fallback
        // follows the reader.
        description:
          typeof time.description === 'string'
            ? time.description
            : t.yearsEarlier(String(time.yearsAgo ?? '?')),
      }
    case 'relative':
      return {
        kind: 'relative',
        description:
          typeof time.note === 'string' ? time.note : t.relativeOrderKnown,
      }
    default:
      return { kind: 'unknown', description: t.unknownMoment }
  }
}

/** Sort key for the story axis. Approximate entries sort by their own text. */
function storyOrder(entry: TimelineEntry): number {
  const time = entry.storyTime
  if (!time) return Number.MAX_SAFE_INTEGER
  if (time.kind === 'exact') {
    const year = Number(time.description.split('-')[0])
    return Number.isFinite(year) ? year : Number.MAX_SAFE_INTEGER
  }
  // Everything non-exact keeps revelation order among itself: it is the only
  // ordering the pages actually justify.
  return Number.MAX_SAFE_INTEGER - 1_000_000 + entry.knownFromChapter
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
  locale: Locale = DEFAULT_LOCALE,
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

  return withBoundary({ userId, boundaryChapter: chapterNumber }, async (db) => {
    const newEntities = await db
      .select({
        id: entities.id,
        nodeType: entities.nodeType,
        label: sql<string | null>`(
          SELECT l.label FROM entity_labels l
          WHERE l.entity_id = ${entities.id}
          ORDER BY (l.lang = ${locale})::int DESC,
                   l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
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
          WHERE l.entity_id = ${assertions.subjectEntityId}
          ORDER BY (l.lang = ${locale})::int DESC,
                   l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
        )`,
        objectLabel: sql<string | null>`(
          SELECT l.label FROM entity_labels l
          WHERE l.entity_id = ${assertions.objectEntityId}
          ORDER BY (l.lang = ${locale})::int DESC,
                   l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
        )`,
      })
      .from(assertions)
      .where(eq(assertions.knowledgeFromChapter, chapterNumber))

    /*
     * Beliefs this chapter closed.
     *
     * Read at the chapter *before*, because a belief refuted at N is invisible
     * at N — that is the whole point of the window. Reading it here would
     * return nothing and the delta would silently never mention a refutation.
     */
    const refuted = await withBoundary(
      { userId, boundaryChapter: Math.max(0, chapterNumber - 1) },
      async (previous) =>
        previous
          .select({
            id: assertions.id,
            predicate: assertions.predicate,
            heldSince: assertions.knowledgeFromChapter,
            subjectLabel: sql<string | null>`(
              SELECT l.label FROM entity_labels l
              WHERE l.entity_id = ${assertions.subjectEntityId}
              ORDER BY (l.lang = ${locale})::int DESC,
                       l.precedence DESC, l.revealed_in_chapter DESC LIMIT 1
            )`,
          })
          .from(assertions)
          .where(eq(assertions.knowledgeUntilChapter, chapterNumber)),
    )

    const names = await db
      .select({
        entityId: entityLabels.entityId,
        label: entityLabels.label,
        kind: entityLabels.kind,
      })
      .from(entityLabels)
      .where(
        and(
          eq(entityLabels.revealedInChapter, chapterNumber),
          // One row per name event: the English twin revealed alongside its
          // French original is the same revelation, not a second one.
          eq(entityLabels.lang, 'fr'),
        ),
      )

    // What each newly named entity was called before, so the delta can say
    // "the man in the striped scarf turns out to be Kaelo Renn".
    const previousNames =
      names.length === 0
        ? []
        : await withBoundary(
            { userId, boundaryChapter: Math.max(0, chapterNumber - 1) },
            async (previous) =>
              previous
                .select({
                  entityId: entityLabels.entityId,
                  label: entityLabels.label,
                })
                .from(entityLabels)
                .where(
                  and(
                    inArray(
                      entityLabels.entityId,
                      names.map((name) => name.entityId),
                    ),
                    eq(entityLabels.lang, 'fr'),
                  ),
                )
                .orderBy(sql`${entityLabels.precedence} DESC`),
          )

    const previousByEntity = new Map<string, string>()
    for (const row of previousNames) {
      if (!previousByEntity.has(row.entityId)) previousByEntity.set(row.entityId, row.label)
    }

    const opened = await db
      .select({ question: mysteries.question })
      .from(mysteries)
      .where(lte(mysteries.openedInChapter, chapterNumber))

    return {
      chapterNumber,
      chapterTitle: meta.title,
      newEntities: newEntities.map((row) => ({
        id: row.id,
        label: row.label ?? getDictFor(locale).common.unnamedEntity,
        nodeType: row.nodeType,
      })),
      newFacts: facts.map((row) => ({
        id: row.id,
        predicate: row.predicate,
        subjectLabel: row.subjectLabel ?? 'entité sans nom',
        objectLabel: row.objectLabel,
        epistemicStatus: row.epistemicStatus,
      })),
      refuted: refuted.map((row) => ({
        id: row.id,
        predicate: row.predicate,
        subjectLabel: row.subjectLabel ?? 'entité sans nom',
        heldSince: row.heldSince,
      })),
      newNames: names.map((row) => ({
        entityId: row.entityId,
        label: row.label,
        kind: row.kind,
        previous: previousByEntity.get(row.entityId) ?? null,
      })),
      openedMysteries: opened.map((row) => row.question),
    }
  })
}
