import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { displayImages, type DisplayImage } from '@/domains/images/index.ts'
import { describeStoryTime, type StoryTimeView } from './timeline.ts'

/**
 * The story, told forward.
 *
 * Every other read in this application answers "what do I know at chapter N".
 * This one answers a different question — "what happened, in order" — and the
 * difference is the whole design.
 *
 * **Each chapter is read at its own boundary.** Not at the reader's. A window
 * covering chapters 1 to 6 opens six boundaries, one per chapter, because a
 * name revealed in chapter 5 must not appear on chapter 1's page. Reading the
 * window once at chapter 6 and narrowing afterwards in TypeScript would be
 * cheaper by a factor of six and would put the one guarantee this product sells
 * back into application code — the exact inversion ADR 0001 exists to prevent.
 * So the boundary stays in the database and story mode pays for it.
 *
 * What it pays is bounded: one round trip per chapter rather than the seven
 * `getNarrativeDelta()` needs, because everything a chapter's page shows is
 * aggregated into a single row of JSON, and because chapters in a window have
 * no dependency on each other and so are read concurrently.
 *
 * The one thing that cannot be read at chapter N is what chapter N *refutes*:
 * a belief closed at N is invisible at N — that is what the boundary means —
 * so refutations come from a second, deliberately small read at N-1.
 */

/** How many chapters are read at once. Above this, latency stops improving. */
const CONCURRENCY = 4

/**
 * Chapters per window.
 *
 * Small enough that the first screen is not held up by chapters nobody has
 * scrolled to, large enough that a fast scroll does not outrun the loader.
 */
export const STORY_WINDOW = 6

/** Excerpts outside this range read as a fragment or as a paragraph. */
const QUOTE_MIN = 40
const QUOTE_MAX = 240

/**
 * Faces per chapter.
 *
 * Each one is a signed URL, which is a round trip to the storage driver. A
 * chapter that introduces forty entities does not need forty portraits to read
 * as a chapter that introduces a crowd — it needs a few faces and a count.
 */
const PORTRAITS_PER_CHAPTER = 8

export interface StoryQuote {
  /**
   * Quoted exactly, in the language of the source. A citation is a copy
   * verified character by character, so it is the one thing on the page that
   * is not necessarily French.
   */
  excerpt: string
}

export interface StoryEvent {
  entityId: string
  label: string
  summary: string | null
  /** The chapter presents it as a memory or a recounting. */
  isFlashback: boolean
  /** Null when the pages place it nowhere. Not a zero — an absence. */
  storyTime: StoryTimeView | null
}

/** A name landing on someone who already had one. The best beat in the schema. */
export interface StoryReveal {
  entityId: string
  label: string
  kind: string
  /** What they were called until this chapter, if anything. */
  previous: string | null
}

export interface StoryCast {
  entityId: string
  label: string | null
  nodeType: string
}

export interface StoryRefutation {
  assertionId: string
  subjectLabel: string | null
  /** Null when the belief was about a value rather than another entity. */
  objectLabel: string | null
  predicate: string
  heldSince: number
}

export interface StoryMystery {
  entityId: string
  question: string
}

export interface StoryChapter {
  number: number
  title: string | null
  volume: number | null
  events: StoryEvent[]
  reveals: StoryReveal[]
  cast: StoryCast[]
  refutations: StoryRefutation[]
  mysteriesOpened: StoryMystery[]
  mysteriesResolved: StoryMystery[]
  /** Everything this chapter added, including what has no page of its own. */
  factCount: number
  quote: StoryQuote | null
  /**
   * Faces, by entity id, signed at this chapter's boundary.
   *
   * Which is what makes the gallery fill in as the reader scrolls rather than
   * all at once: a portrait was found by a name, and it appears in the chapter
   * that reveals that name — never in the chapter where the character was
   * still a silhouette. The database applies it; nothing here has to remember.
   */
  portraits: Record<string, DisplayImage>
  /**
   * Published, but with nothing to stage.
   *
   * A chapter that produced no event, no name and no new face is not a failure
   * — some chapters are transitions. It gets a line rather than a spread, which
   * is the difference between a story mode and a list of empty frames.
   */
  isSilent: boolean
}

export interface StoryPage {
  chapters: StoryChapter[]
  /** The next chapter to ask for, or null at the end of what is readable. */
  nextCursor: number | null
  /** The reader's own ceiling. Story mode never goes past it. */
  lastChapter: number
}

/**
 * A window of the story, from `from` forward.
 *
 * `ceiling` is the reader's boundary, and it is a hard stop rather than a
 * suggestion: a window asked for chapters 40 to 46 by someone who has read to
 * 42 returns three chapters and a null cursor.
 */
export async function getStoryPage(
  userId: string,
  workId: string,
  options: { from: number; count: number; ceiling: number },
): Promise<StoryPage> {
  const from = Math.max(1, Math.floor(options.from))
  const count = Math.max(1, Math.min(12, Math.floor(options.count)))
  const ceiling = Math.max(0, Math.floor(options.ceiling))

  if (workId.length === 0 || ceiling < from) {
    return { chapters: [], nextCursor: null, lastChapter: ceiling }
  }

  /*
   * Which chapters exist, read through the ingest role.
   *
   * The same split every other list in this application makes: that chapter 42
   * exists, is called something and is published is a fact about the library,
   * not about the story. Filtering it by the boundary would make the page
   * unable to tell "nothing happened here" from "you have not read this yet".
   */
  const numbers = await withIngest(async (db) => {
    const rows = await db
      .select({
        number: chapters.number,
        title: chapters.title,
        volume: chapters.volume,
      })
      .from(chapters)
      .where(
        and(
          eq(chapters.userId, userId),
          eq(chapters.workId, workId),
          eq(chapters.status, 'published'),
          gte(chapters.number, from),
          lte(chapters.number, ceiling),
        ),
      )
      .orderBy(asc(chapters.number))
      .limit(count + 1)
    return rows
  })

  const window = numbers.slice(0, count)
  const nextCursor =
    numbers.length > count ? (numbers[count]?.number ?? null) : null

  const staged = await mapWithLimit(window, CONCURRENCY, async (meta) =>
    readChapter(userId, meta.number, meta.title, meta.volume),
  )

  return { chapters: staged, nextCursor, lastChapter: ceiling }
}

/** One chapter, staged at its own boundary. */
async function readChapter(
  userId: string,
  number: number,
  title: string | null,
  volume: number | null,
): Promise<StoryChapter> {
  const [present, refutations] = await Promise.all([
    readPresent(userId, number),
    readRefutations(userId, number),
  ])

  const isSilent =
    present.events.length === 0 &&
    present.reveals.length === 0 &&
    present.cast.length === 0 &&
    present.mysteriesOpened.length === 0 &&
    present.mysteriesResolved.length === 0 &&
    refutations.length === 0

  return {
    number,
    title,
    volume,
    ...present,
    refutations,
    portraits: isSilent ? {} : await readPortraits(userId, number, present),
    isSilent,
  }
}

/**
 * The faces this chapter can show, signed at this chapter.
 *
 * Newly named entities come first: a name landing is the moment a face becomes
 * showable, and it is the beat the page is built around. Whoever merely walked
 * on fills the rest.
 */
async function readPortraits(
  userId: string,
  number: number,
  present: { reveals: StoryReveal[]; cast: StoryCast[] },
): Promise<Record<string, DisplayImage>> {
  const ids: string[] = []
  for (const reveal of present.reveals) {
    if (!ids.includes(reveal.entityId)) ids.push(reveal.entityId)
  }
  for (const member of present.cast) {
    if (!ids.includes(member.entityId)) ids.push(member.entityId)
  }
  if (ids.length === 0) return {}

  const found = await displayImages(
    userId,
    number,
    ids.slice(0, PORTRAITS_PER_CHAPTER),
  )
  return Object.fromEntries(found)
}

interface PresentRow {
  events: Array<{
    entityId: string
    label: string | null
    summary: string | null
    isFlashback: boolean
    storyTime: unknown
  }> | null
  reveals: StoryReveal[] | null
  cast: StoryCast[] | null
  mysteriesOpened: StoryMystery[] | null
  mysteriesResolved: StoryMystery[] | null
  factCount: number | string | null
  quote: string | null
}

/**
 * Everything chapter `number` brought, read at chapter `number`.
 *
 * One statement, because it is one page. The sub-selects are independent and
 * the planner runs them off the boundary indexes; splitting them into six
 * queries would cost six round trips per chapter, and a story mode loads
 * chapters by the handful.
 *
 * Labels are resolved inside this transaction, which is what makes the whole
 * mode honest: at chapter 1 the man in the leather apron has no name, and the
 * subquery cannot find one, because row-level security has already removed
 * every label revealed later.
 */
async function readPresent(
  userId: string,
  number: number,
): Promise<
  Omit<
    StoryChapter,
    'number' | 'title' | 'volume' | 'refutations' | 'portraits' | 'isSilent'
  >
> {
  const rows = await withBoundary({ userId, boundaryChapter: number }, async (db) =>
    db.execute(sql`
      SELECT
        (SELECT coalesce(json_agg(t), '[]'::json) FROM (
          SELECT
            e.entity_id AS "entityId",
            e.summary,
            e.is_flashback AS "isFlashback",
            e.story_time AS "storyTime",
            (SELECT l.label FROM entity_labels l
              WHERE l.entity_id = e.entity_id
              ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
              LIMIT 1) AS label
          FROM events e
          JOIN entities en ON en.id = e.entity_id
          WHERE coalesce(e.told_in_chapter, e.shown_in_chapter, 0) = ${number}
          ORDER BY e.is_flashback, e.created_at
        ) t) AS events,

        (SELECT coalesce(json_agg(t), '[]'::json) FROM (
          SELECT
            l.entity_id AS "entityId",
            l.label,
            l.kind,
            (SELECT p.label FROM entity_labels p
              WHERE p.entity_id = l.entity_id
                AND p.revealed_in_chapter < ${number}
              ORDER BY p.precedence DESC, p.revealed_in_chapter DESC
              LIMIT 1) AS previous
          FROM entity_labels l
          JOIN entities en ON en.id = l.entity_id
          WHERE l.revealed_in_chapter = ${number}
          ORDER BY l.precedence DESC, l.label
        ) t) AS reveals,

        (SELECT coalesce(json_agg(t), '[]'::json) FROM (
          SELECT
            en.id AS "entityId",
            en.node_type AS "nodeType",
            (SELECT l.label FROM entity_labels l
              WHERE l.entity_id = en.id
              ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
              LIMIT 1) AS label
          FROM entities en
          WHERE en.first_seen_chapter = ${number}
          ORDER BY en.node_type, en.created_at
        ) t) AS cast,

        (SELECT coalesce(json_agg(t), '[]'::json) FROM (
          SELECT m.entity_id AS "entityId", m.question
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
          WHERE m.opened_in_chapter = ${number}
          ORDER BY m.created_at
        ) t) AS "mysteriesOpened",

        (SELECT coalesce(json_agg(t), '[]'::json) FROM (
          SELECT m.entity_id AS "entityId", m.question
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
          WHERE m.resolved_in_chapter = ${number}
          ORDER BY m.created_at
        ) t) AS "mysteriesResolved",

        (SELECT count(*) FROM assertions a
          WHERE a.knowledge_from_chapter = ${number}) AS "factCount",

        -- One line from the chapter, quoted exactly: the longest excerpt that
        -- still reads as a line rather than a paragraph. It comes from the
        -- evidence table, so it is text the pipeline already verified occurs
        -- in the source. A story mode composing its own prose is the one thing
        -- this repository has refused since its first line.
        (SELECT ev.excerpt FROM evidence ev
          JOIN assertions a ON a.id = ev.assertion_id
          WHERE a.knowledge_from_chapter = ${number}
            AND ev.excerpt IS NOT NULL
            AND char_length(ev.excerpt) BETWEEN ${QUOTE_MIN} AND ${QUOTE_MAX}
          ORDER BY char_length(ev.excerpt) DESC
          LIMIT 1) AS quote
    `),
  )

  const row = (rows as unknown as PresentRow[])[0]

  return {
    events: (row?.events ?? []).map((event) => ({
      entityId: event.entityId,
      label: event.label ?? 'événement sans nom',
      summary: event.summary,
      isFlashback: event.isFlashback,
      storyTime: describeStoryTime(event.storyTime),
    })),
    reveals: row?.reveals ?? [],
    cast: row?.cast ?? [],
    mysteriesOpened: row?.mysteriesOpened ?? [],
    mysteriesResolved: row?.mysteriesResolved ?? [],
    factCount: Number(row?.factCount ?? 0),
    quote: row?.quote ? { excerpt: row.quote } : null,
  }
}

/**
 * What this chapter closes, read one chapter earlier.
 *
 * A belief refuted at N is not visible at N — the policy hides it the moment
 * the reader reaches the chapter that kills it. Read here at N-1, where the
 * reader still held it, which is also the only place it can be described
 * truthfully: « vous l'avez cru depuis le chapitre 12 ».
 */
async function readRefutations(
  userId: string,
  number: number,
): Promise<StoryRefutation[]> {
  if (number <= 1) return []

  const rows = await withBoundary(
    { userId, boundaryChapter: number - 1 },
    async (db) =>
      db.execute(sql`
        SELECT
          a.id AS "assertionId",
          a.predicate,
          a.knowledge_from_chapter AS "heldSince",
          (SELECT l.label FROM entity_labels l
            WHERE l.entity_id = a.subject_entity_id
            ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
            LIMIT 1) AS "subjectLabel",
          (SELECT l.label FROM entity_labels l
            WHERE l.entity_id = a.object_entity_id
            ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
            LIMIT 1) AS "objectLabel"
        FROM assertions a
        WHERE a.knowledge_until_chapter = ${number}
        ORDER BY a.knowledge_from_chapter
      `),
  )

  return (rows as unknown as StoryRefutation[]).map((row) => ({
    assertionId: row.assertionId,
    predicate: row.predicate,
    heldSince: Number(row.heldSince),
    subjectLabel: row.subjectLabel,
    objectLabel: row.objectLabel,
  }))
}

/**
 * Map with a ceiling on concurrency.
 *
 * `Promise.all` over a window would open one transaction per chapter at once,
 * and the application pool holds ten connections for the whole process. A page
 * that saturates it does not fail visibly — it makes every other request on the
 * instance wait, which is the kind of slowness nobody traces back to a feature.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index]!)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return out
}
