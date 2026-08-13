import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary } from '@/db/boundary.ts'
import { normalizeText } from '../knowledge/normalize.ts'
import { resultKindFor, type SearchHit } from './types.ts'

/**
 * Trigram search over entity names.
 *
 * Full-text handles words; this handles the words being wrong. Manga names get
 * transliterated inconsistently, OCR turns `rn` into `m`, and a reader typing
 * from memory two hundred chapters later is guessing at a spelling they saw
 * once. `websearch_to_tsquery` finds none of that — a stem only matches when
 * the letters do.
 *
 * Deliberately the same access path entity resolution uses (`resolve.ts`
 * `blockByTrigram`): the same index, the same `similarity()` on the same
 * normalised column. Two different notions of "close enough" in one product
 * would mean the search that finds a character and the blocking that proposed
 * merging them could disagree about whether two names are alike.
 */

/** Below this, a trigram match is noise rather than a typo. */
const FLOOR = 0.3

interface Row extends Record<string, unknown> {
  entity_id: string
  label: string
  revealed_in_chapter: number
  similarity: number
  node_type: string | null
}

export async function fuzzySearch(
  userId: string,
  boundaryChapter: number,
  query: string,
  limit = 15,
): Promise<SearchHit[]> {
  const normalised = normalizeText(query)
  // Trigram similarity on one or two characters is meaningless — every short
  // string is similar to every other — and would flood the results.
  if (normalised.length < 3) return []

  return withBoundary({ userId, boundaryChapter }, async (db) => {
    // The node type comes along for the same reason it does in `lexical.ts`: an
    // event and a mystery carry a label like everything else, and announcing
    // one as « entité » presents a sentence as somebody's name. LEFT, so the
    // join can only add a word and never remove a result.
    const rows = await db.execute<Row>(sql`
      SELECT
        l.entity_id,
        l.label,
        l.revealed_in_chapter,
        en.node_type,
        similarity(l.normalized_label, ${normalised}) AS similarity
      FROM entity_labels l
      LEFT JOIN entities en ON en.id = l.entity_id
      WHERE similarity(l.normalized_label, ${normalised}) >= ${FLOOR}
      ORDER BY similarity DESC, l.precedence DESC
      LIMIT ${limit}
    `)

    const seen = new Set<string>()
    const hits: SearchHit[] = []

    for (const row of rows) {
      // One hit per entity: an entity with an alias and an epithet both close to
      // the query would otherwise occupy three rows of a short results list.
      if (seen.has(row.entity_id)) continue
      seen.add(row.entity_id)

      const score = Number(row.similarity)
      hits.push({
        kind: resultKindFor(row.node_type),
        id: row.entity_id,
        entityId: row.entity_id,
        title: row.label,
        snippet: row.label,
        chapterNumber: Number(row.revealed_in_chapter),
        score,
        mode: 'fuzzy',
        reason:
          score > 0.7
            ? `Nom très proche de ce que vous avez tapé.`
            : `Nom approchant — orthographe ou transcription différente.`,
      })
    }

    return hits
  })
}
