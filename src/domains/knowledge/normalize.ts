/**
 * Text normalisation for evidence anchoring and entity-resolution blocking.
 *
 * This is the authoritative implementation: it produces the `normalized_text`
 * column that anchoring matches against.
 *
 * app.normalize_text() in SQL is a *backstop*, not a twin. It uses PostgreSQL's
 * unaccent(), which reads a rules file that folds more than Unicode
 * decomposition does (ß→ss, …→..., «→<<, full-width→ASCII) and whose contents
 * can differ between installations. Since 0008 the trigger applies that
 * function to both the excerpt and the stored text, so any extra folding
 * cancels out and the two need not agree character for character — see
 * drizzle/0008_anchor_symmetric_normalisation.sql.
 *
 * `tests/db/normalize-parity.test.ts` asserts the property that matters:
 * anything this module accepts, the database also accepts.
 */

/**
 * Ligatures and letters Unicode NFD decomposition leaves alone. These are
 * folded here because OCR and translation conventions vary — "Oeuvre" and
 * "Œuvre" must match the same block.
 */
const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/œ/g, 'oe'],
  [/Œ/g, 'OE'],
  [/æ/g, 'ae'],
  [/Æ/g, 'AE'],
  [/ß/g, 'ss'],
  [/ø/g, 'o'],
  [/Ø/g, 'O'],
  [/ð/g, 'd'],
  [/Ð/g, 'D'],
  [/þ/g, 'th'],
  [/Þ/g, 'TH'],
  [/đ/g, 'd'],
  [/Đ/g, 'D'],
  [/ł/g, 'l'],
  [/Ł/g, 'L'],
  [/ı/g, 'i'],
]

/**
 * Typographic punctuation folded to ASCII.
 *
 * Scanlations are wildly inconsistent about quotes, apostrophes and dashes —
 * the same line appears as "L'homme", "L’homme" and "L‘homme" across
 * releases. Folding them means a quote still anchors when the release
 * changes.
 */
const PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, '-'],
  [/…/g, '...'],
  [/ | | | /g, ' '],
]

/** Combining diacritical marks left behind by NFD decomposition. */
const COMBINING_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃰]/g

/** Strip diacritics, fold ligatures. */
export function unaccent(input: string): string {
  let out = input
  for (const [pattern, replacement] of LIGATURES) {
    out = out.replace(pattern, replacement)
  }
  return out.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC')
}

/**
 * The canonical form: compatibility-normalised, unaccented, punctuation folded
 * to ASCII, lowercased, whitespace collapsed, trimmed.
 *
 * NFKC first, so full-width and other compatibility forms collapse to their
 * ASCII equivalents before anything else runs.
 *
 * Punctuation is folded but not removed. Dropping it entirely would make short
 * excerpts match far too loosely — "Roger." and "Roger?" are different quotes,
 * and an excerpt that matches the wrong sentence is worse than one that fails
 * to match at all.
 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return ''
  let out = input.normalize('NFKC')
  for (const [pattern, replacement] of PUNCTUATION) {
    out = out.replace(pattern, replacement)
  }
  return unaccent(out).toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Is `excerpt` genuinely present in `blockText`?
 *
 * This is the anchoring check that keeps the model honest (ADR 0003): a claim
 * whose quote does not appear in the page it cites is not supported by the
 * imported material, however true it may be of One Piece.
 */
export function isAnchoredIn(excerpt: string, blockText: string): boolean {
  const needle = normalizeText(excerpt)
  if (needle.length === 0) return false
  return normalizeText(blockText).includes(needle)
}

/**
 * Levenshtein distance, bounded: stops as soon as it exceeds `max`.
 *
 * Used only to decide whether a near-miss is OCR noise. A near-match is
 * accepted but downgraded to `inferred_strong`, never recorded as `explicit`,
 * so the weaker provenance stays visible in the interface.
 */
export function boundedEditDistance(
  a: string,
  b: string,
  max: number,
): number | null {
  if (Math.abs(a.length - b.length) > max) return null
  if (a === b) return 0

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  let current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      current[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return null
    const swap = previous
    previous = current
    current = swap
  }

  const distance = previous[b.length] ?? Number.POSITIVE_INFINITY
  return distance <= max ? distance : null
}

/**
 * Tolerant anchoring, for OCR output that is close but not exact.
 *
 * Returns how the excerpt matched so the caller can set the epistemic status
 * accordingly — an approximate match must never be recorded as an explicit fact.
 */
export function anchorMatch(
  excerpt: string,
  blockText: string,
): { matched: false } | { matched: true; exact: boolean } {
  const needle = normalizeText(excerpt)
  const haystack = normalizeText(blockText)
  if (needle.length === 0) return { matched: false }
  if (haystack.includes(needle)) return { matched: true, exact: true }

  // Allow roughly one error per ten characters, capped — enough for OCR
  // confusions (rn/m, l/I, 0/O), not enough to match a different sentence.
  const budget = Math.min(4, Math.floor(needle.length / 10))
  if (budget === 0) return { matched: false }

  for (let start = 0; start + needle.length - budget <= haystack.length; start++) {
    for (let width = needle.length - budget; width <= needle.length + budget; width++) {
      const window = haystack.slice(start, start + width)
      if (window.length === 0) continue
      if (boundedEditDistance(needle, window, budget) !== null) {
        return { matched: true, exact: false }
      }
    }
  }
  return { matched: false }
}
