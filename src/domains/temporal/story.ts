import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { displayImages, type DisplayImage } from '@/domains/images/index.ts'
import {
  nodeTypeLabel,
  predicateLabel,
} from '@/domains/knowledge/predicate-label.ts'
import { describeStoryTime } from './timeline.ts'

/**
 * The story as one thread.
 *
 * Not a page per chapter — a single ordered list of things that happen, with
 * the chapter numbers as notches along it. A chapter that added nothing is a
 * notch and no beads, which is exactly what a transition chapter feels like to
 * read, and it costs no special case to say so.
 *
 * **Each chapter is read at its own boundary.** Not at the reader's. A window
 * covering chapters 1 to 6 opens six boundaries, one per chapter, because a
 * name revealed in chapter 5 must not appear beside chapter 1. Reading the
 * window once at chapter 6 and narrowing afterwards in TypeScript would be
 * cheaper by a factor of six and would put the one guarantee this product
 * sells back into application code — the exact inversion ADR 0001 exists to
 * prevent. So the boundary stays in the database and story mode pays for it.
 *
 * What it pays is bounded: one round trip per chapter, because every kind of
 * bead is one arm of a single union, and chapters in a window have no
 * dependency on each other and so are read concurrently.
 *
 * The one thing that cannot be read at chapter N is what chapter N *refutes*:
 * a belief closed at N is invisible at N — that is what the boundary means —
 * so refutations come from a second, deliberately small read at N-1.
 */

/** How many chapters are read at once. Above this, latency stops improving. */
const CONCURRENCY = 4

/** Chapters per window. Enough that a fast scroll does not outrun the loader. */
export const STORY_WINDOW = 6

/** Excerpts outside this range read as a fragment or as a paragraph. */
const QUOTE_MIN = 40
const QUOTE_MAX = 240

/** Signed URLs are a round trip each; a thread needs a few faces, not a crowd. */
const PORTRAITS_PER_CHAPTER = 6

export type BeatKind =
  | 'chapitre'
  | 'citation'
  | 'entree'
  | 'evenement'
  | 'souvenir'
  | 'nom'
  | 'dementi'
  | 'reponse'
  | 'question'

export interface StoryBeat {
  id: string
  chapter: number
  kind: BeatKind
  /** The line itself. Already French, already resolved — the page renders it. */
  text: string
  /**
   * The second line, when there is one. Its meaning follows the kind: the
   * name held until now, an event's summary, what a belief cost to hold.
   */
  detail: string | null
  entityId: string | null
  portrait: DisplayImage | null
}

export interface StoryPage {
  beats: StoryBeat[]
  /** The next chapter to ask for, or null at the end of what is readable. */
  nextCursor: number | null
  /** The reader's own ceiling. The thread never runs past it. */
  lastChapter: number
}

/**
 * A stretch of thread, from `from` forward.
 *
 * `ceiling` is the reader's boundary and a hard stop: a window asked for
 * chapters 40 to 46 by someone who has read to 42 returns three chapters'
 * worth of beads and a null cursor.
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
    return { beats: [], nextCursor: null, lastChapter: ceiling }
  }

  /*
   * Which chapters exist, read through the ingest role.
   *
   * That chapter 42 exists, is called something and is published is a fact
   * about the library, not about the story. Filtering it by the boundary would
   * make the thread unable to tell "nothing happened here" from "you have not
   * read this yet".
   */
  const window = await withIngest(async (db) =>
    db
      .select({ number: chapters.number, title: chapters.title })
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
      .limit(count + 1),
  )

  const shown = window.slice(0, count)
  const nextCursor = window.length > count ? (window[count]?.number ?? null) : null

  const perChapter = await mapWithLimit(shown, CONCURRENCY, async (meta) => [
    {
      id: `ch-${meta.number}`,
      chapter: meta.number,
      kind: 'chapitre' as const,
      text: meta.title ?? '',
      detail: null,
      entityId: null,
      portrait: null,
    },
    ...(await readBeats(userId, meta.number)),
  ])

  return { beats: perChapter.flat(), nextCursor, lastChapter: ceiling }
}

interface Row {
  kind: Exclude<BeatKind, 'chapitre' | 'dementi'>
  entityId: string | null
  texte: string | null
  detail: string | null
  extra: unknown
}

/** One chapter's beads, in the order they are told. */
async function readBeats(userId: string, chapter: number): Promise<StoryBeat[]> {
  const [rows, refuted] = await Promise.all([
    withBoundary({ userId, boundaryChapter: chapter }, async (db) =>
      db.execute(sql`
        (SELECT 'citation' AS kind, 0 AS rang, NULL::uuid AS "entityId",
                ev.excerpt AS texte, NULL::text AS detail,
                NULL::jsonb AS extra, 0 AS ordre
           FROM evidence ev
           JOIN assertions a ON a.id = ev.assertion_id
          WHERE a.knowledge_from_chapter = ${chapter}
            AND ev.excerpt IS NOT NULL
            AND char_length(ev.excerpt) BETWEEN ${QUOTE_MIN} AND ${QUOTE_MAX}
          ORDER BY char_length(ev.excerpt) DESC
          LIMIT 1)

        UNION ALL

        SELECT 'entree', 1, en.id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = en.id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               en.node_type, NULL::jsonb, 0
          FROM entities en
         WHERE en.first_seen_chapter = ${chapter}

        UNION ALL

        SELECT CASE WHEN e.is_flashback THEN 'souvenir' ELSE 'evenement' END,
               CASE WHEN e.is_flashback THEN 3 ELSE 2 END,
               e.entity_id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = e.entity_id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               e.summary, e.story_time, 0
          FROM events e
          JOIN entities en ON en.id = e.entity_id
         WHERE coalesce(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}

        UNION ALL

        -- A name landing on someone who already had one: the best beat the
        -- schema holds, and the reason a bead carries a second line at all.
        SELECT 'nom', 4, l.entity_id, l.label,
               (SELECT p.label FROM entity_labels p
                 WHERE p.entity_id = l.entity_id
                   AND p.revealed_in_chapter < ${chapter}
                 ORDER BY p.precedence DESC, p.revealed_in_chapter DESC
                 LIMIT 1),
               NULL::jsonb, l.precedence
          FROM entity_labels l
          JOIN entities en ON en.id = l.entity_id
         WHERE l.revealed_in_chapter = ${chapter}

        UNION ALL

        SELECT 'reponse', 6, m.entity_id, m.question, NULL, NULL::jsonb, 0
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
         WHERE m.resolved_in_chapter = ${chapter}

        UNION ALL

        SELECT 'question', 7, m.entity_id, m.question, NULL, NULL::jsonb, 0
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
         WHERE m.opened_in_chapter = ${chapter}

        ORDER BY rang, ordre DESC, texte
      `),
    ),
    readRefutations(userId, chapter),
  ])

  const beats: StoryBeat[] = (rows as unknown as Row[]).map((row, index) =>
    compose(row, chapter, index),
  )

  // Rank 5: what falls, after what happened and before what it leaves open.
  const opened = beats.findIndex((beat) => beat.kind === 'reponse' || beat.kind === 'question')
  const at = opened === -1 ? beats.length : opened
  beats.splice(at, 0, ...refuted)

  return withPortraits(userId, chapter, beats)
}

/** A row of the union, turned into the line the page shows. */
function compose(row: Row, chapter: number, index: number): StoryBeat {
  const id = `${chapter}-${row.kind}-${row.entityId ?? index}`
  const base = { id, chapter, entityId: row.entityId, portrait: null }
  const text = row.texte ?? ''

  switch (row.kind) {
    case 'entree':
      return {
        ...base,
        kind: 'entree',
        text: text === '' ? 'entité sans nom révélé' : text,
        detail: row.detail ? nodeTypeLabel(row.detail) : null,
      }
    case 'evenement':
    case 'souvenir': {
      const when = describeStoryTime(row.extra)
      return {
        ...base,
        kind: row.kind,
        text: text === '' ? 'événement sans nom' : text,
        // The summary carries the telling; the in-world moment is appended
        // only when the pages actually give one.
        detail:
          when && when.kind !== 'unknown'
            ? [row.detail, when.description].filter(Boolean).join(' — ')
            : row.detail,
      }
    }
    case 'nom':
      return {
        ...base,
        kind: 'nom',
        text,
        detail: row.detail === text ? null : row.detail,
      }
    default:
      return { ...base, kind: row.kind, text, detail: row.detail }
  }
}

/**
 * What this chapter closes, read one chapter earlier.
 *
 * A belief refuted at N is not visible at N — the policy hides it the moment
 * the reader reaches the chapter that kills it. Read here at N-1, where they
 * still held it, which is also the only place it can be described truthfully:
 * « cru depuis le chapitre 12 ».
 */
async function readRefutations(
  userId: string,
  chapter: number,
): Promise<StoryBeat[]> {
  if (chapter <= 1) return []

  const rows = await withBoundary(
    { userId, boundaryChapter: chapter - 1 },
    async (db) =>
      db.execute(sql`
        SELECT a.id AS "assertionId", a.predicate,
               a.knowledge_from_chapter AS "heldSince",
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = a.subject_entity_id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1) AS sujet,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = a.object_entity_id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1) AS objet
          FROM assertions a
         WHERE a.knowledge_until_chapter = ${chapter}
         ORDER BY a.knowledge_from_chapter
      `),
  )

  return (
    rows as unknown as Array<{
      assertionId: string
      predicate: string
      heldSince: number
      sujet: string | null
      objet: string | null
    }>
  ).map((row) => ({
    id: `${chapter}-dementi-${row.assertionId}`,
    chapter,
    kind: 'dementi' as const,
    text: [row.sujet ?? 'entité sans nom', predicateLabel(row.predicate), row.objet]
      .filter(Boolean)
      .join(' '),
    detail: `cru depuis le chapitre ${Number(row.heldSince)}`,
    entityId: null,
    portrait: null,
  }))
}

/**
 * Faces, signed at this chapter.
 *
 * Only on the two beats where a face is the point — someone walking on, and a
 * name landing. A portrait was found *by* a name, so it appears in the chapter
 * that reveals that name and never in the one where the character was still a
 * silhouette. The database applies that; nothing here has to remember.
 */
async function withPortraits(
  userId: string,
  chapter: number,
  beats: StoryBeat[],
): Promise<StoryBeat[]> {
  const ids = [
    ...new Set(
      beats
        .filter((beat) => beat.kind === 'entree' || beat.kind === 'nom')
        .map((beat) => beat.entityId)
        .filter((id): id is string => id !== null),
    ),
  ].slice(0, PORTRAITS_PER_CHAPTER)

  if (ids.length === 0) return beats

  const found = await displayImages(userId, chapter, ids)
  return beats.map((beat) =>
    beat.entityId && found.has(beat.entityId)
      ? { ...beat, portrait: found.get(beat.entityId) ?? null }
      : beat,
  )
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
