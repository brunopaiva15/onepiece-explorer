import { fetchJson, pause } from '../http.ts'
import type { ImageCandidate } from '../types.ts'

/**
 * onepieceapi.com — the only source that illustrates all four kinds.
 *
 * Measured on 2026-08-11: 369 characters, 94 Devil Fruits, 16 ships, 31 islands,
 * every single one of them with a picture. Free, no key, no published rate
 * limit.
 *
 * The reason it is the primary source is not the pictures, though — it is this
 * field:
 *
 *     "extra_data": { "first_appearance": "Chapter 31; Episode 13" }
 *
 * Present on 306 of the 369 characters and on every ship and island. It is what
 * lets an external catalogue coexist with a product built on revelation time.
 * A source that hands you all of One Piece with no notion of *when* each thing
 * became known is a source you can only use by flattening the story, which is
 * the one thing this application refuses to do.
 */

const BASE = 'https://www.onepieceapi.com/api'
const PAGE_SIZE = 100
const MAX_PAGES = 40

interface Named {
  en?: string | null
  jp?: string | null
  romaji?: string | null
}

interface Row {
  id: string
  name: Named | string
  image_url?: string | null
  extra_data?: { first_appearance?: string | null; epithet?: string | null } | null
}

export async function fetchOnePieceApi(): Promise<ImageCandidate[]> {
  const [characters, fruits, ships, islands] = await Promise.all([
    page('characters'),
    page('devil-fruits'),
    page('ships'),
    page('islands'),
  ])

  return [
    ...characters.map((row) => toCandidate(row, 'character', 'characters')),
    ...fruits.map((row) => toCandidate(row, 'fruit', 'devil-fruits')),
    ...ships.map((row) => toCandidate(row, 'ship', 'ships')),
    ...islands.map((row) => toCandidate(row, 'island', 'islands')),
  ].filter((candidate): candidate is ImageCandidate => candidate !== null)
}

/**
 * Walk the pages until one repeats or comes up short.
 *
 * `limit` is capped at 100 server-side whatever you ask for, and there is no
 * total in the response — so the stop condition is empirical. Tracking ids
 * rather than trusting page counts means a server that ignores `page` yields
 * one page instead of looping forever.
 */
async function page(resource: string): Promise<Row[]> {
  const rows: Row[] = []
  const seen = new Set<string>()

  for (let n = 1; n <= MAX_PAGES; n += 1) {
    const batch = await fetchJson<Row[]>(
      `${BASE}/${resource}?page=${n}&limit=${PAGE_SIZE}`,
    )
    if (!Array.isArray(batch) || batch.length === 0) break

    const fresh = batch.filter((row) => row.id && !seen.has(row.id))
    if (fresh.length === 0) break

    for (const row of fresh) {
      seen.add(row.id)
      rows.push(row)
    }

    if (batch.length < PAGE_SIZE) break
    await pause(200)
  }

  return rows
}

function toCandidate(
  row: Row,
  kind: ImageCandidate['kind'],
  resource: string,
): ImageCandidate | null {
  if (!row.image_url) return null

  const names = namesOf(row.name)
  const epithet = row.extra_data?.epithet?.replace(/^"|"$/g, '').trim()
  if (epithet) names.push(epithet)

  if (names.length === 0) return null

  return {
    source: 'onepieceapi',
    sourceRef: row.id,
    kind,
    names,
    imageUrl: row.image_url,
    pageUrl: `${BASE}/${resource}`,
    attribution: 'onepieceapi.com',
    firstAppearanceChapter: chapterOf(row.extra_data?.first_appearance),
  }
}

function namesOf(name: Named | string): string[] {
  if (typeof name === 'string') return name.trim() ? [name.trim()] : []
  return [name.en, name.romaji, name.jp]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
}

/** "Chapter 436; Episode 321" → 436. Anything else → null, never a guess. */
export function chapterOf(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /chapter\s+(\d+)/i.exec(value)
  if (!match?.[1]) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}
