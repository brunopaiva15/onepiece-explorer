import 'server-only'
import { eq, inArray, sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { entities, entityLabels, events } from '@/db/schema/knowledge.ts'
import { describeStoryTime, type StoryTimeView } from './timeline.ts'

/**
 * The story axis: everything you have imported, in the order it happened.
 *
 * Two things make this page different from every other one, and both were asked
 * for.
 *
 * **It is not stopped at your cursor.** Not because the boundary is bypassed —
 * it is not, and there is no second path into these tables — but because it is
 * read at the *library's* ceiling instead of the reader's position. The
 * policy does exactly what it always does; it is simply asked a different
 * question: not « what did I know at chapter 40 » but « what does everything I
 * have imported say about when things happened ». Nothing outside the library
 * can appear here, because nothing outside the library is in these tables.
 *
 * **And it is built from three signals, not one.** The first version of this
 * page ordered by `events.story_time` alone and correctly reported having
 * nothing: no field asked the model for a date, so the column was null in every
 * library that has ever existed. It is written now — see
 * `candidateStoryTimeSchema` — but only for chapters processed since, and only
 * where the chapter says so in words it can quote. So the axis rests on what is
 * actually recorded:
 *
 *   1. a dated distance, when a chapter gave one — « vingt-deux ans plus tôt »;
 *   2. `is_flashback`, which has been recorded all along and says *earlier than
 *      now* without saying how much earlier;
 *   3. the chapter that tells it, which orders everything else.
 *
 * Signal 2 is the one that makes the page useful today. A memory whose distance
 * nobody wrote down still belongs before the present, and saying « earlier, by
 * an amount the chapter does not give » is a true statement about a flashback —
 * far truer than dropping it into a bin called « position inconnue », which is
 * what it used to get.
 */

export type Placement =
  /** The chapter gave a distance. The only rows with a real coordinate. */
  | { kind: 'dated'; yearsAgo: number; description: string }
  /** Told as a memory, with no distance given. Before the present, unmeasured. */
  | { kind: 'earlier'; description: string | null }
  /** The story's own present: neither flashback nor dated. */
  | { kind: 'present' }

export interface ChronologyEvent {
  entityId: string
  label: string
  summary: string | null
  /** The chapter that shows or tells it — the revelation axis, kept apart. */
  chapter: number
  isFlashback: boolean
  placement: Placement
  storyTime: StoryTimeView | null
  /** Publication order inside a chapter. Breaks ties, never crosses chapters. */
  recordedAt: number
}

export interface Chronology {
  /** The ceiling this was read at: the whole library, not the reader. */
  ceiling: number
  /** Distances the chapters actually gave, furthest first. */
  dated: ChronologyEvent[]
  /** Memories with no distance, in the order the chapters recount them. */
  earlier: ChronologyEvent[]
  /** The present of the story, in chapter order. */
  present: ChronologyEvent[]
}

export async function getChronology(
  userId: string,
  ceiling: number,
): Promise<Chronology> {
  const rows = await withBoundary({ userId, boundaryChapter: ceiling }, async (db) => {
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

    const ids = eventRows.map((row) => row.entityId)
    const labels =
      ids.length === 0
        ? []
        : await db
            .select({
              entityId: entityLabels.entityId,
              label: entityLabels.label,
            })
            .from(entityLabels)
            .where(inArray(entityLabels.entityId, ids))
            .orderBy(sql`${entityLabels.precedence} DESC`)

    return { eventRows, labels }
  })

  const labelOf = new Map<string, string>()
  for (const row of rows.labels) {
    if (!labelOf.has(row.entityId)) labelOf.set(row.entityId, row.label)
  }

  const all = rows.eventRows.map((row): ChronologyEvent => {
    const storyTime = describeStoryTime(row.storyTime)
    return {
      entityId: row.entityId,
      label: labelOf.get(row.entityId) ?? 'événement sans nom',
      summary: row.summary,
      // Told beats shown, as everywhere else: a chapter that *recounts* an event
      // is where the reader met it, whatever the art does later.
      chapter: row.toldInChapter ?? row.shownInChapter ?? 0,
      isFlashback: row.isFlashback,
      placement: place(row.storyTime, storyTime, row.isFlashback),
      storyTime,
      recordedAt: row.createdAt.getTime(),
    }
  })

  /*
   * Inside a group, publication order breaks the tie and never crosses a
   * chapter — the same rule the revelation axis uses, and for the same reason:
   * everything a chapter reveals shares one number, so without a tie-break the
   * order is whatever PostgreSQL felt like returning.
   */
  const byChapter = (a: ChronologyEvent, b: ChronologyEvent) =>
    a.chapter - b.chapter || a.recordedAt - b.recordedAt

  return {
    ceiling,
    dated: all
      .filter((event) => event.placement.kind === 'dated')
      .sort((a, b) => {
        const left = a.placement as Extract<Placement, { kind: 'dated' }>
        const right = b.placement as Extract<Placement, { kind: 'dated' }>
        return right.yearsAgo - left.yearsAgo || byChapter(a, b)
      }),
    earlier: all.filter((event) => event.placement.kind === 'earlier').sort(byChapter),
    present: all.filter((event) => event.placement.kind === 'present').sort(byChapter),
  }
}

/**
 * Which of the three the row belongs to.
 *
 * The order of the tests is the whole of it. A distance wins when there is one;
 * failing that, being told as a memory is still a position — *before now* — and
 * that is the branch the old page had no name for. Only what is neither lands
 * in the present, which is the correct default: a scene nobody marked as a
 * memory and nobody dated is a scene happening as you read it.
 */
function place(
  raw: unknown,
  view: StoryTimeView | null,
  isFlashback: boolean,
): Placement {
  const time = raw as { kind?: string; yearsAgo?: unknown } | null

  if (
    time !== null &&
    typeof time === 'object' &&
    time.kind === 'approximate' &&
    typeof time.yearsAgo === 'number' &&
    Number.isFinite(time.yearsAgo)
  ) {
    return {
      kind: 'dated',
      yearsAgo: time.yearsAgo,
      description: view?.description ?? `environ ${time.yearsAgo} ans plus tôt`,
    }
  }

  if (isFlashback || (view !== null && view.kind === 'relative')) {
    return {
      kind: 'earlier',
      description: view !== null && view.kind !== 'unknown' ? view.description : null,
    }
  }

  return { kind: 'present' }
}
