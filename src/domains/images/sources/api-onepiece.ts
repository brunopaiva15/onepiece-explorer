import { fetchJson } from '../http.ts'
import type { ImageCandidate } from '../types.ts'

/**
 * api-onepiece.com — Devil Fruits, and only Devil Fruits, and only some.
 *
 * This is the largest of the three catalogues by a distance: 786 characters,
 * 149 crews, 128 locations, 99 boats, 50 story arcs. Almost none of it is used
 * here, and the reason is worth writing down so nobody "fixes" the omission.
 *
 * Measured on 2026-08-11, endpoint by endpoint: only `/fruits` carries an image
 * field (`filename`). Characters, boats, locations and crews return names,
 * descriptions and relations — no picture anywhere. Since this module exists to
 * find pictures, everything but the fruits is dead weight, and everything but
 * the fruits is also *external knowledge*, which the product refuses on
 * principle.
 *
 * And the fruits disappoint too. 213 rows carry the field; 23 carry a value.
 * The field being present on a schema is not the same as the data being there,
 * which is the sort of thing you only find out by counting — so the count is
 * recorded here rather than an optimistic "213 fruit images".
 *
 * It stays in the catalogue because those 23 are 23 more than nothing and cost
 * one request. It is not the source to reach for if fruit coverage matters.
 */

const BASE = 'https://api.api-onepiece.com/v2'

interface Fruit {
  id: number
  name?: string | null
  roman_name?: string | null
  filename?: string | null
}

export async function fetchApiOnePiece(): Promise<ImageCandidate[]> {
  const fruits = await fetchJson<Fruit[]>(`${BASE}/fruits/en`, { timeoutMs: 20_000 })
  if (!Array.isArray(fruits)) return []

  return fruits.flatMap((fruit): ImageCandidate[] => {
    if (!fruit.filename) return []

    const names = [fruit.name, fruit.roman_name]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
    if (names.length === 0) return []

    return [
      {
        source: 'api-onepiece',
        sourceRef: String(fruit.id),
        kind: 'fruit',
        names,
        imageUrl: fruit.filename,
        pageUrl: `${BASE}/fruits/en/${fruit.id}`,
        attribution: 'api-onepiece.com',
        // The endpoint carries no chapter of first appearance. Null rather
        // than a plausible number: a wrong revelation chapter would show a
        // picture too early, which is the one failure mode that matters here.
        firstAppearanceChapter: null,
        // A Devil Fruit looks the same on both sides of the ellipse, and the
        // endpoint would not say so if it did not.
        era: 'unknown',
      },
    ]
  })
}
