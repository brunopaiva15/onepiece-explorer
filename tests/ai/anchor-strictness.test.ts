import { describe, expect, it } from 'vitest'
import { buildAnchorSources, checkEvidence } from '@/domains/ai/anchoring.ts'
import { anchorMatch } from '@/domains/knowledge/normalize.ts'

/**
 * How close a quote has to be, and why the answer depends on who read the page.
 *
 * The edit-distance budget was written for OCR: on a scan, the stored text is
 * itself a guess, and demanding character equality would reject quotes faithful
 * to the printed page. On a chapter you typed there is nothing to be noisy
 * about, and the tolerance was doing two kinds of damage.
 *
 * It let a paraphrase through — the case below is the one that reached a real
 * review queue — and it disagreed with the database, whose anchoring trigger
 * has no tolerance at all. A near-miss accepted here was accepted by a
 * reviewer and then refused at publication, inside the transaction, taking the
 * whole batch with it.
 */

const PASSAGE =
  'Zoro cannot believe what he is hearing, and Koby tells Zoro how Luffy punched ' +
  'Helmeppo because of what they overheard him say.'

/** « Koby » → « he »: four edits, on a budget of exactly four. */
const PARAPHRASE = 'he tells Zoro how Luffy punched Helmeppo because of what they overheard him say'

function sources(tolerateNoise: boolean) {
  return buildAnchorSources({
    textBlocks: [{ ref: 'b1', text: PASSAGE }],
    descriptions: [],
    allowedRefs: ['b1'],
    tolerateNoise,
  })
}

describe('a chapter you typed', () => {
  it('refuses a quote that swaps who is speaking', () => {
    const failure = checkEvidence(
      { ref: 'b1', kind: 'text', excerpt: PARAPHRASE },
      sources(false),
    )

    expect(failure?.reason).toBe('excerpt_not_in_source')
  })

  it('still accepts the passage’s own words', () => {
    expect(
      checkEvidence(
        { ref: 'b1', kind: 'text', excerpt: 'Koby tells Zoro how Luffy punched Helmeppo' },
        sources(false),
      ),
    ).toBeNull()
  })

  it('still forgives punctuation and case, which are not paraphrase', () => {
    // Normalisation stays on: a curly apostrophe reproduced straight is a
    // transcription detail, and rejecting it would teach nothing.
    expect(
      checkEvidence(
        { ref: 'b1', kind: 'text', excerpt: 'KOBY TELLS ZORO HOW LUFFY PUNCHED HELMEPPO' },
        sources(false),
      ),
    ).toBeNull()
  })
})

describe('a scanned chapter', () => {
  it('keeps its tolerance for a machine’s reading', () => {
    expect(
      checkEvidence({ ref: 'b1', kind: 'text', excerpt: PARAPHRASE }, sources(true)),
    ).toBeNull()
  })

  /*
   * The measurement behind the whole change: the budget is min(4, len/10), and
   * a short word swapped inside a long sentence costs no more than four. Pinned
   * so that raising the cap is a deliberate act rather than a tidy-up.
   */
  it('absorbs a whole word once the sentence is long enough', () => {
    const match = anchorMatch(PARAPHRASE, PASSAGE)
    expect(match.matched).toBe(true)
    if (match.matched) expect(match.exact).toBe(false)
  })
})
