import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'
import type { SearchHit } from './types.ts'

/**
 * Full-text search over everything in the corpus that is prose.
 *
 * Five places text lives — entity labels, transcribed blocks, event summaries,
 * mystery questions, panel descriptions — each with its own generated tsvector
 * and GIN index from migration 0010. One query per source rather than a union
 * view, because each needs a different join to reach the entity it belongs to
 * and a union would have to carry the widest shape for all of them.
 *
 * Every query runs inside `withBoundary`, so the filtering is the database's and
 * not this file's. Nothing here mentions a chapter number in a WHERE clause,
 * which is the point: a search feature is exactly the sort of thing that
 * accumulates hand-written filters and then forgets one.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery`: it understands quoted
 * phrases and `-exclusion`, which are the two things people type without being
 * told they can.
 */

interface Row extends Record<string, unknown> {
  id: string
  entity_id: string | null
  title: string
  snippet: string
  chapter_number: number
  rank: number
}

export async function lexicalSearch(
  userId: string,
  boundaryChapter: number,
  query: string,
  limit = 30,
  locale: Locale = DEFAULT_LOCALE,
): Promise<SearchHit[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const t = getDictFor(locale).search

  return withBoundary({ userId, boundaryChapter }, async (db) => {
    /*
     * The query is stemmed in the reader's language; each stored vector was
     * stemmed in its row's own language (migration 0019). An English query
     * meets English-stemmed labels and text blocks head on, and still matches
     * French rows wherever the words survive stemming — proper nouns mostly,
     * which is most of what gets searched. The fuzzy and graph modes cover the
     * cross-language remainder.
     */
    const config = locale === 'en' ? 'en_unaccent' : 'fr_unaccent'
    const tsquery = sql`websearch_to_tsquery(${config}::regconfig, ${trimmed})`

    const labels = await db.execute<Row>(sql`
      SELECT
        l.entity_id                     AS id,
        l.entity_id                     AS entity_id,
        l.label                         AS title,
        l.label                         AS snippet,
        l.revealed_in_chapter           AS chapter_number,
        ts_rank_cd(l.search_vector, ${tsquery}) AS rank
      FROM entity_labels l
      WHERE l.search_vector @@ ${tsquery}
      ORDER BY rank DESC, l.precedence DESC
      LIMIT ${limit}
    `)

    /*
     * ts_headline marks the match inside its surrounding sentence. Without it a
     * transcribed block is shown from its first character, which for a long
     * caption means the reader sees the words before the ones they searched for
     * and has to hunt.
     */
    const blocks = await db.execute<Row>(sql`
      SELECT
        tb.id                           AS id,
        NULL                            AS entity_id,
        coalesce(left(tb.text, 60), '') AS title,
        ts_headline(${config}::regconfig, tb.text, ${tsquery},
                    'MaxWords=28, MinWords=8, StartSel=«, StopSel=»') AS snippet,
        tb.chapter_number               AS chapter_number,
        ts_rank_cd(tb.search_vector, ${tsquery}) AS rank
      FROM text_blocks tb
      WHERE tb.search_vector @@ ${tsquery}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    const eventRows = await db.execute<Row>(sql`
      SELECT
        e.entity_id                     AS id,
        e.entity_id                     AS entity_id,
        coalesce(left(e.summary, 80), '') AS title,
        ts_headline(${config}::regconfig, coalesce(e.summary, ''), ${tsquery},
                    'MaxWords=28, MinWords=8, StartSel=«, StopSel=»') AS snippet,
        coalesce(e.told_in_chapter, e.shown_in_chapter, 0) AS chapter_number,
        ts_rank_cd(e.search_vector, ${tsquery}) AS rank
      FROM events e
      WHERE e.search_vector @@ ${tsquery}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    const mysteryRows = await db.execute<Row>(sql`
      SELECT
        m.entity_id                     AS id,
        m.entity_id                     AS entity_id,
        left(m.question, 80)            AS title,
        m.question                      AS snippet,
        m.opened_in_chapter             AS chapter_number,
        ts_rank_cd(m.search_vector, ${tsquery}) AS rank
      FROM mysteries m
      WHERE m.search_vector @@ ${tsquery}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    const panelRows = await db.execute<Row>(sql`
      SELECT
        p.id                            AS id,
        NULL                            AS entity_id,
        (p.index + 1)::text             AS title,
        ts_headline(${config}::regconfig, coalesce(p.description, ''), ${tsquery},
                    'MaxWords=28, MinWords=8, StartSel=«, StopSel=»') AS snippet,
        p.chapter_number                AS chapter_number,
        ts_rank_cd(p.search_vector, ${tsquery}) AS rank
      FROM panels p
      WHERE p.search_vector @@ ${tsquery}
      ORDER BY rank DESC
      LIMIT ${limit}
    `)

    for (const row of panelRows) {
      row.title = t.panelTitle(Number(row.title))
    }

    return [
      ...toHits(labels, 'entity', t.reasonNameMatch),
      ...toHits(blocks, 'text_block', t.reasonTextMatch),
      ...toHits(eventRows, 'event', t.reasonEventMatch),
      ...toHits(mysteryRows, 'mystery', t.reasonMysteryMatch),
      ...toHits(panelRows, 'panel', t.reasonPanelMatch),
    ].sort((a, b) => b.score - a.score)
  })
}

function toHits(
  rows: Row[],
  kind: SearchHit['kind'],
  reason: string,
): SearchHit[] {
  return rows.map((row) => ({
    kind,
    id: String(row.id),
    entityId: row.entity_id === null ? null : String(row.entity_id),
    title: String(row.title),
    snippet: String(row.snippet),
    chapterNumber: Number(row.chapter_number),
    score: Number(row.rank),
    mode: 'lexical' as const,
    reason,
  }))
}
