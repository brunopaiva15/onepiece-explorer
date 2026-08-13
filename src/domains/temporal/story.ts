import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { displayImages, type DisplayImage } from '@/domains/images/index.ts'
import {
  nodeTypeLabel,
  predicateLabel,
} from '@/domains/knowledge/predicate-label.ts'
import { identityComponents } from './projection.ts'
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

/**
 * Faces signed per chapter.
 *
 * Signing is a round trip per file against the storage provider, and a window
 * covers six chapters, so this cannot be unbounded. It counts entities that
 * *have* a picture rather than candidates — capping the candidate list first
 * spent the whole budget on events and groups that no catalogue illustrates,
 * and returned a chapter with no faces at all. A chapter introducing more than
 * sixteen illustrated entities will still lose the tail, silently; that is the
 * one thing here that is a trade rather than a fix.
 */
const PORTRAITS_PER_CHAPTER = 16

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
        -- One line, quoted exactly, and only if it reads as a line: a capital
        -- at the start, a full stop at the end. The excerpts are prose from the
        -- source, so the longest one is very often a clause torn out of the
        -- middle of a paragraph — « declaring he will get a crew that is… » is
        -- worse than no quote at all. Dialogue wins over narration when both
        -- qualify, because that is what a quoted line is for.
        (SELECT 'citation' AS kind, 0 AS rang, NULL::uuid AS "entityId",
                ev.excerpt AS texte, NULL::text AS detail,
                NULL::jsonb AS extra, 0::numeric AS ordre
           FROM evidence ev
           JOIN assertions a ON a.id = ev.assertion_id
          WHERE a.knowledge_from_chapter = ${chapter}
            AND ev.excerpt IS NOT NULL
            AND char_length(ev.excerpt) BETWEEN ${QUOTE_MIN} AND ${QUOTE_MAX}
            AND ev.excerpt ~ '^[[:upper:]«]'
            AND ev.excerpt ~ '[.!?…»]$'
          ORDER BY (ev.kind = 'dialogue') DESC, char_length(ev.excerpt) DESC
          LIMIT 1)

        UNION ALL

        SELECT CASE WHEN e.is_flashback THEN 'souvenir' ELSE 'evenement' END,
               CASE WHEN e.is_flashback THEN 2 ELSE 1 END,
               e.entity_id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = e.entity_id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               e.summary, e.story_time,
               extract(epoch FROM e.created_at)
          FROM events e
          JOIN entities en ON en.id = e.entity_id
         WHERE coalesce(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}

        UNION ALL

        -- A name landing on someone who *already had one*. Without the EXISTS
        -- this fires for every label in the chapter, which on chapter 1 is
        -- every entity in the story — and a first name is not a reveal, it is
        -- an introduction, which the next arm already makes.
        SELECT 'nom', 3, l.entity_id, l.label,
               (SELECT p.label FROM entity_labels p
                 WHERE p.entity_id = l.entity_id
                   AND p.revealed_in_chapter < ${chapter}
                 ORDER BY p.precedence DESC, p.revealed_in_chapter DESC
                 LIMIT 1),
               NULL::jsonb, -l.precedence
          FROM entity_labels l
          JOIN entities en ON en.id = l.entity_id
         WHERE l.revealed_in_chapter = ${chapter}
           AND EXISTS (SELECT 1 FROM entity_labels p
                        WHERE p.entity_id = l.entity_id
                          AND p.revealed_in_chapter < ${chapter})

        UNION ALL

        -- Walking on is for whoever has no beat of their own. An event and a
        -- mystery are entities too, and without this they arrived twice: once
        -- as themselves, once as « entre en scène · Événement ».
        SELECT 'entree', 4, en.id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = en.id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               en.node_type, NULL::jsonb,
               extract(epoch FROM en.created_at)
          FROM entities en
         WHERE en.first_seen_chapter = ${chapter}
           AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.entity_id = en.id)
           AND NOT EXISTS (SELECT 1 FROM mysteries m2 WHERE m2.entity_id = en.id)

        UNION ALL

        SELECT 'reponse', 6, m.entity_id, m.question, NULL, NULL::jsonb,
               extract(epoch FROM m.created_at)
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
         WHERE m.resolved_in_chapter = ${chapter}

        UNION ALL

        SELECT 'question', 7, m.entity_id, m.question, NULL, NULL::jsonb,
               extract(epoch FROM m.created_at)
          FROM mysteries m
          JOIN entities en ON en.id = m.entity_id
         WHERE m.opened_in_chapter = ${chapter}

        -- Narrative order, never alphabetical: sorting the beads by their text
        -- turns a chapter into an index of itself.
        ORDER BY rang, ordre
      `),
    ),
    readRefutations(userId, chapter),
  ])

  /*
   * Deduplicated on what the reader actually sees.
   *
   * Entity resolution does not always merge two rows that carry the same
   * name, and a thread is the one place where that shows: the same line,
   * twice, one bead apart. Two rows may well be two entities; two identical
   * beads are never two beats.
   */
  const seen = new Set<string>()
  const beats: StoryBeat[] = []
  for (const [index, row] of (rows as unknown as Row[]).entries()) {
    const beat = compose(row, chapter, index)
    // A name landing with nothing to replace is an introduction, and `entree`
    // has already made it.
    if (beat.kind === 'nom' && beat.detail === null) continue
    const key = `${beat.kind}|${beat.text}`
    if (seen.has(key)) continue
    seen.add(key)
    beats.push(beat)
  }

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
      /*
       * An event is usually named by its own summary — the pipeline has no
       * better title for « Shanks sauve Luffy et perd son bras gauche » than
       * that sentence. Printing both lines gave every event bead the same
       * sentence twice.
       */
      const summary =
        row.detail !== null && row.detail.trim() === text.trim() ? null : row.detail
      return {
        ...base,
        kind: row.kind,
        text: text === '' ? 'événement sans nom' : text,
        // The in-world moment is appended only when the pages give one.
        detail:
          when && when.kind !== 'unknown'
            ? [summary, when.description].filter(Boolean).join(' — ')
            : summary,
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
  ]
  if (ids.length === 0) return beats

  /*
   * Every member of each identity component, not just the bead's own entity.
   *
   * After a merge the picture hangs off whichever half the enrichment matched,
   * which is not necessarily the half the thread is naming. The entity sheet
   * has always resolved the component before asking for a face; a thread that
   * did not showed nothing for exactly the characters whose two silhouettes
   * the reader had just seen joined.
   */
  const components = await identityComponents(userId, chapter, ids)
  const candidates = [...new Set(ids.flatMap((id) => components.get(id) ?? [id]))]

  const found = await displayImages(
    userId,
    chapter,
    candidates,
    PORTRAITS_PER_CHAPTER,
  )
  if (found.size === 0) return beats

  return beats.map((beat) => {
    if (!beat.entityId) return beat
    for (const member of components.get(beat.entityId) ?? [beat.entityId]) {
      const portrait = found.get(member)
      if (portrait) return { ...beat, portrait }
    }
    return beat
  })
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
