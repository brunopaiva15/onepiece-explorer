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
 * Events shown before the rest is folded away.
 *
 * A chapter of the real work carries fifteen of them, and a library of a
 * thousand chapters carries eleven hundred: told one after another they are not
 * a thread, they are a transcript. Five is what a chapter is *about*; the rest
 * is still there, one click away, and the page says how many rather than
 * quietly dropping them.
 */
const EVENTS_PER_CHAPTER = 5

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
  | 'mention'
  | 'entree'
  | 'evenement'
  | 'souvenir'
  | 'nom'
  | 'dementi'
  | 'reponse'
  | 'question'

/**
 * A run of a line, with a face when the run is a name that has one.
 *
 * A sentence like « Au Partys Bar, Shanks refuse d'emmener Luffy en mer » names
 * two characters the library already knows and can already illustrate. Splitting
 * it here rather than in the page keeps one rule in one place, and makes the
 * rule testable: only labels the reader has already been given, only whole
 * words, longest first, and only when a face actually exists — a name with no
 * picture is left exactly as it was written.
 */
export interface StoryPart {
  text: string
  entityId?: string
  portrait?: DisplayImage
}

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
  /** `text`, split around the named faces. Null when it names none. */
  textParts: StoryPart[] | null
  /** The same for `detail`. */
  detailParts: StoryPart[] | null
  entityId: string | null
  portrait: DisplayImage | null
  /** Past the chapter's event budget: rendered, but folded away. */
  collapsed?: boolean
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
      textParts: null,
      detailParts: null,
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
        -- One line, quoted exactly — and only from a French chapter.
        --
        -- An excerpt keeps the language of its source, because a citation is a
        -- copy verified character by character and translating one would make
        -- it something else. That rule is right and it stays. What follows from
        -- it is that a library whose citable text is the English wiki has no
        -- French line to quote, and the thread is read in French: « The Red
        -- Hair Pirates then raise anchor » on a French page is not a quotation,
        -- it is a language the reader did not ask for. So the bead appears only
        -- when the chapter's own language is French, and otherwise not at all.
        --
        -- Shape matters too: a capital at the start, a full stop at the end.
        -- The excerpts are prose, so the longest is often a clause torn out of
        -- the middle of a paragraph, which is worse than no quote. Dialogue
        -- wins over narration when both qualify.
        (SELECT 'citation' AS kind, 0 AS rang, NULL::uuid AS "entityId",
                ev.excerpt AS texte, NULL::text AS detail,
                NULL::jsonb AS extra, 0::numeric AS ordre
           FROM evidence ev
           JOIN assertions a ON a.id = ev.assertion_id
           JOIN chapters c ON c.id = ev.chapter_id
          WHERE a.knowledge_from_chapter = ${chapter}
            AND c.language = 'fr'
            AND ev.excerpt IS NOT NULL
            AND char_length(ev.excerpt) BETWEEN ${QUOTE_MIN} AND ${QUOTE_MAX}
            AND ev.excerpt ~ '^[[:upper:]«]'
            AND ev.excerpt ~ '[.!?…»]$'
          ORDER BY (ev.kind = 'dialogue') DESC, char_length(ev.excerpt) DESC
          LIMIT 1)

        UNION ALL

        SELECT CASE WHEN e.is_flashback THEN 'souvenir' ELSE 'evenement' END,
               CASE WHEN e.is_flashback THEN 3 ELSE 2 END,
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
        --
        -- First, before the events. The events *name* these people — « Shanks
        -- refuse d'emmener Luffy » — and a sentence that names someone the
        -- reader has not been introduced to, with a face beside the name, is
        -- an introduction happening after the fact.
        --
        -- « entre en scène » or « est mentionné », decided by what the
        -- extraction stated. Koby telling Luffy about a pirate hunter named
        -- Zoro is not Zoro walking on: he is spoken of at chapter 2 and seen at
        -- chapter 3, and the graph used to call both the same thing.
        --
        -- The stated flag is what keeps an existing library intact. Occurrences
        -- written before the field say « mention » about everyone, because they
        -- were derived from the medium of the evidence and a written chapter
        -- has no drawings — reading those would demote every character ever
        -- imported. With no stated row, the answer is the old one: walking on.
        SELECT CASE WHEN EXISTS (
                      SELECT 1 FROM occurrences o
                       WHERE o.entity_id = en.id AND o.stated
                         AND o.chapter_number = ${chapter}
                         AND o.kind = 'mention')
                    AND NOT EXISTS (
                      SELECT 1 FROM occurrences o
                       WHERE o.entity_id = en.id AND o.stated
                         AND o.chapter_number = ${chapter}
                         AND o.kind = 'appearance')
               THEN 'mention' ELSE 'entree' END,
               1, en.id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = en.id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               en.node_type, NULL::jsonb,
               ${ENTRY_ORDER}
          FROM entities en
         WHERE en.first_seen_chapter = ${chapter}
           AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.entity_id = en.id)
           AND NOT EXISTS (SELECT 1 FROM mysteries m2 WHERE m2.entity_id = en.id)

        UNION ALL

        -- Seen at last, having only been spoken of until now.
        --
        -- The other half of the same distinction: Zoro was named at chapter 2
        -- and this is the chapter he walks on. Keyed on the first stated
        -- appearance rather than on first_seen_chapter, which holds the
        -- chapter the reader first *heard of* him — the right anchor for the
        -- boundary, and the wrong one for this.
        SELECT 'entree', 1, en.id,
               (SELECT l.label FROM entity_labels l
                 WHERE l.entity_id = en.id
                 ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
                 LIMIT 1),
               en.node_type, NULL::jsonb,
               ${ENTRY_ORDER}
          FROM entities en
         WHERE en.first_seen_chapter < ${chapter}
           AND EXISTS (SELECT 1 FROM occurrences o
                        WHERE o.entity_id = en.id AND o.stated
                          AND o.chapter_number = ${chapter}
                          AND o.kind = 'appearance')
           AND NOT EXISTS (SELECT 1 FROM occurrences o
                            WHERE o.entity_id = en.id AND o.stated
                              AND o.chapter_number < ${chapter}
                              AND o.kind = 'appearance')
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

  /*
   * Past the fifth event, folded rather than dropped.
   *
   * The chapter keeps every one of them — the count in the summary is the
   * chapter's real count, and one click opens the rest. Trimming the list here
   * would make a chapter of fifteen events look like a chapter of five.
   */
  let seenEvents = 0
  for (const beat of beats) {
    if (beat.kind !== 'evenement' && beat.kind !== 'souvenir') continue
    seenEvents += 1
    if (seenEvents > EVENTS_PER_CHAPTER) beat.collapsed = true
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
  const base = {
    id,
    chapter,
    entityId: row.entityId,
    portrait: null,
    textParts: null,
    detailParts: null,
  }
  const text = row.texte ?? ''

  switch (row.kind) {
    case 'mention':
    case 'entree':
      return {
        ...base,
        kind: row.kind,
        text: text === '' ? 'entité sans nom révélé' : text,
        detail: row.detail ? nodeTypeLabel(row.detail) : null,
      }
    case 'evenement':
    case 'souvenir': {
      const when = describeStoryTime(row.extra)
      /*
       * One line, never two.
       *
       * An event is named by its own summary — the pipeline has no better title
       * for « Shanks sauve Luffy et perd son bras gauche » than that sentence.
       * So the label and the summary are the same thing said twice, and the
       * label is the copy that got cut: it is capped at two hundred characters
       * against the summary's four hundred, which is how a bead came to show a
       * sentence broken mid-word above the whole one.
       *
       * Comparing them was the wrong fix, because they do not have to be equal
       * to be redundant. An event simply has no subtitle: the sentence is the
       * beat. The summary wins when there is one, being the complete form; the
       * label serves when there is not.
       *
       * The in-world moment is not a subtitle either — it goes on the small
       * label above, beside « souvenir », where the page shows what kind of
       * beat this is rather than what it says.
       */
      const summary = (row.detail ?? '').trim()
      const line = summary !== '' ? summary : text.trim()

      return {
        ...base,
        kind: row.kind,
        text: line === '' ? 'événement sans nom' : line,
        detail: when && when.kind !== 'unknown' ? when.description : null,
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
    textParts: null,
    detailParts: null,
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
  const named = [
    ...new Set(
      beats
        .filter((beat) => beat.kind === 'entree' || beat.kind === 'nom')
        .map((beat) => beat.entityId)
        .filter((id): id is string => id !== null),
    ),
  ]

  const mentions = await readMentions(userId, chapter, beats)
  const ids = [...new Set([...named, ...mentions.map((m) => m.entityId)])]
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

  const faceOf = (entityId: string): DisplayImage | null => {
    for (const member of components.get(entityId) ?? [entityId]) {
      const portrait = found.get(member)
      if (portrait) return portrait
    }
    return null
  }

  // Only names that really have a face become mentions. Marking up a name that
  // resolves to nothing would change how the sentence reads and show nothing.
  const illustrated = mentions.filter((mention) => faceOf(mention.entityId) !== null)

  return beats.map((beat) => {
    const portrait = beat.entityId ? faceOf(beat.entityId) : null
    if (!NARRATED.has(beat.kind)) {
      return portrait ? { ...beat, portrait } : beat
    }
    return {
      ...beat,
      portrait,
      textParts: splitOnNames(beat.text, illustrated, faceOf),
      detailParts: beat.detail
        ? splitOnNames(beat.detail, illustrated, faceOf)
        : null,
    }
  })
}

/** Beads whose line is a sentence about the world rather than a name. */
const NARRATED = new Set<BeatKind>([
  'evenement',
  'souvenir',
  'question',
  'reponse',
  'dementi',
])

/**
 * The order people and things walk on in.
 *
 * Creation order is the order the extraction happened to emit them, which is
 * how « Gomu Gomu no Pistol entre en scène » came to stand above the character
 * whose power it is. A chapter introduces a cast, then where they are, then
 * what they carry — nobody meets a fruit's ability before its owner.
 *
 * Types, then creation order inside a type. Multiplied wide enough that the
 * epoch below it cannot reach the next rank.
 */
const ENTRY_ORDER = sql`
  CASE en.node_type
    WHEN 'character' THEN 0
    WHEN 'group'     THEN 1
    WHEN 'species'   THEN 2
    WHEN 'place'     THEN 3
    WHEN 'object'    THEN 4
    WHEN 'power'     THEN 5
    ELSE 6
  END * 1e10 + extract(epoch FROM en.created_at)`

/** Below this, a label is a word before it is a name. */
const MENTION_MIN_LENGTH = 4

interface Mention {
  label: string
  entityId: string
}

/**
 * The last word of a name, when the name has several.
 *
 * The chapter calls him Luffy. The graph calls him « Monkey D. Luffy », because
 * that is the name the chapter gave. An exact-label match therefore finds
 * nothing in the one sentence that most needs a face — and the same for Zoro,
 * for Roger, for every character whose full name is used once and whose short
 * one is used everywhere after.
 *
 * The last word rather than any word: French and Japanese naming both put the
 * distinctive part last here, and taking any token would match « du » and
 * « de ». Four characters minimum, and it must still start with a capital, so
 * « Bar » out of « Partys Bar » is too short and « bandits » never matches
 * « Bandits ».
 *
 * A short form claimed by two different entities is dropped entirely rather
 * than guessed at — see readMentions().
 */
function shortForm(label: string): string | null {
  const last = label.trim().split(/\s+/).at(-1) ?? ''
  if (last === label.trim()) return null
  if (last.length < MENTION_MIN_LENGTH) return null
  if (last[0] !== last[0]?.toUpperCase()) return null
  return last
}

/**
 * Which known names occur in this chapter's sentences.
 *
 * Asked the other way round on purpose: not "which entities does the reader
 * know" — at chapter 800 that is thousands of rows — but "which of their
 * labels appear in these particular lines", which PostgreSQL answers with one
 * `position()` per label and returns only the handful that matched.
 *
 * Row-level security does the rest, and it is what makes this safe: a label
 * revealed later is not in the table as far as this transaction is concerned,
 * so a sentence that happens to contain a name the reader has not been given
 * yet simply does not match it. The case-sensitive comparison is deliberate
 * too — « Bandits » is a group, « bandits » is a word.
 */
async function readMentions(
  userId: string,
  chapter: number,
  beats: StoryBeat[],
): Promise<Mention[]> {
  const blob = beats
    .filter((beat) => NARRATED.has(beat.kind))
    .flatMap((beat) => [beat.text, beat.detail ?? ''])
    .join('\n')

  if (blob.trim() === '') return []

  const rows = await withBoundary({ userId, boundaryChapter: chapter }, async (db) =>
    db.execute(sql`
      SELECT l.entity_id AS "entityId", l.label
        FROM entity_labels l
        JOIN entities en ON en.id = l.entity_id
       WHERE char_length(l.label) >= ${MENTION_MIN_LENGTH}
         AND (position(l.label IN ${blob}) > 0
              -- The last word of the label. Doubled backslash: this is a
              -- template literal, and « \s » in one is just « s ».
              OR position(regexp_replace(l.label, '^.*\\s', '') IN ${blob}) > 0)
    `),
  )

  const seen = new Set<string>()
  const full: Mention[] = []
  /** Short form → the entities claiming it. More than one means ambiguous. */
  const short = new Map<string, Set<string>>()

  for (const row of rows as unknown as Mention[]) {
    const key = `${row.entityId}|${row.label}`
    if (!seen.has(key)) {
      seen.add(key)
      full.push(row)
    }
    const brief = shortForm(row.label)
    if (brief === null) continue
    const claimants = short.get(brief) ?? new Set<string>()
    claimants.add(row.entityId)
    short.set(brief, claimants)
  }

  const out = [...full]
  for (const [label, claimants] of short) {
    /*
     * Two characters whose names end the same way — « Monkey D. Luffy » and
     * « Monkey D. Garp » would not collide, but « Portgas D. Ace » and « Ace »
     * as an alias of someone else would. When the short form does not identify
     * one entity, no face is better than a coin flip.
     */
    if (claimants.size !== 1) continue
    const entityId = [...claimants][0]!
    if (full.some((mention) => mention.label === label)) continue
    out.push({ label, entityId })
  }

  // Longest first, so « Monkey D. Luffy » wins over « Luffy » at the same spot.
  return out.sort((a, b) => b.label.length - a.label.length)
}

/**
 * Cut a line around the names that carry a face.
 *
 * Whole words only: without the lookarounds, « Luffy » matches inside
 * « Luffytaro » and the sentence grows a face in the middle of a word. Returns
 * null when the line names nobody, so the page keeps rendering plain text
 * rather than a one-element list.
 */
function splitOnNames(
  line: string,
  mentions: Mention[],
  faceOf: (entityId: string) => DisplayImage | null,
): StoryPart[] | null {
  if (mentions.length === 0 || line === '') return null

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${mentions.map((m) => escapeRegExp(m.label)).join('|')})(?![\\p{L}\\p{N}])`,
    'gu',
  )

  const parts: StoryPart[] = []
  let cursor = 0
  for (const match of line.matchAll(pattern)) {
    const found = mentions.find((mention) => mention.label === match[1])
    const portrait = found ? faceOf(found.entityId) : null
    if (!found || !portrait) continue

    if (match.index > cursor) parts.push({ text: line.slice(cursor, match.index) })
    parts.push({ text: match[1]!, entityId: found.entityId, portrait })
    cursor = match.index + match[1]!.length
  }

  if (parts.length === 0) return null
  if (cursor < line.length) parts.push({ text: line.slice(cursor) })
  return parts
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
