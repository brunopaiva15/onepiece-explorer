import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_BUDGET,
  clampExtraction,
  extractionSchema,
  type Extraction,
} from '@/domains/ai/schemas.ts'
import { buildAnchorSources, checkEvidence } from '@/domains/ai/anchoring.ts'

/**
 * The budgets that decide how long a chapter takes.
 *
 * An excerpt is copied rather than composed, so every character of it is an
 * output token: a slice proposing ninety items with six-hundred-character
 * quotes writes more than the chapter it read. Shortening the quote is the
 * cheapest minute in the pipeline — but only if it is done by clamping.
 *
 * Two properties, and the second is the one that would silently ruin the
 * product. Clamping must keep the excerpt anchorable, which means truncating
 * without an ellipsis: `cut()` elsewhere in that file appends one, and an
 * excerpt ending in "…" occurs in no passage, so every item carrying it would
 * be quarantined as unanchored — a fabrication-shaped failure produced by a
 * formatting choice.
 */

const PASSAGE =
  'Shanks had his left arm bitten off while pulling Luffy to safety, but he ' +
  'remains calm and consoles Luffy as the boy cries over his sacrifice; ' +
  'Shanks says that it was a small price to pay, and the crew looks on in ' +
  'silence as the sea settles behind them once more.'

function extraction(excerpt: string, evidenceCount = 1): Extraction {
  return {
    entities: [
      {
        local_id: 'e1',
        node_type: 'character',
        label: 'Shanks',
        label_kind: 'true_name',
        source_term: null,
        naming_confident: true,
        evidence: Array.from({ length: evidenceCount }, () => ({
          ref: 'b1',
          kind: 'text' as const,
          excerpt,
        })),
        confidence: 0.9,
      },
    ],
    assertions: [],
    events: [],
    mysteries: [],
  }
}

describe('keeping an extraction inside its budgets', () => {
  it('shortens an over-long quote without breaking its anchor', () => {
    const clamped = clampExtraction(extraction(PASSAGE))
    const excerpt = clamped.entities[0]!.evidence[0]!.excerpt

    expect(PASSAGE.length).toBeGreaterThan(EXTRACTION_BUDGET.excerpt)
    expect(excerpt.length).toBe(EXTRACTION_BUDGET.excerpt)
    // No ellipsis, and still a substring: this is the whole point.
    expect(excerpt.endsWith('…')).toBe(false)
    expect(PASSAGE.includes(excerpt)).toBe(true)

    // And the anchoring guard agrees, which is the check that actually runs.
    const sources = buildAnchorSources({
      textBlocks: [{ ref: 'b1', text: PASSAGE }],
      descriptions: [],
      allowedRefs: ['b1'],
      tolerateNoise: true,
    })
    expect(checkEvidence(clamped.entities[0]!.evidence[0]!, sources)).toBeNull()
  })

  it('drops citations beyond the second', () => {
    const clamped = clampExtraction(extraction('Shanks says that it was a small price to pay', 5))
    expect(clamped.entities[0]!.evidence).toHaveLength(EXTRACTION_BUDGET.evidencePerItem)
  })

  it('leaves an answer already inside the budget untouched', () => {
    const short = 'Shanks had his left arm bitten off'
    const clamped = clampExtraction(extraction(short))
    expect(clamped.entities[0]!.evidence[0]!.excerpt).toBe(short)
  })

  it('accepts a model that overshoots rather than losing the slice', () => {
    /*
     * The schema stays permissive on purpose. The Messages API does not enforce
     * string length from a JSON Schema, so a snug `.max()` would not constrain
     * the model — it would throw on its answer, and one long quote would cost
     * the whole slice, billed. That failure already happened once with panel
     * descriptions; this asserts the lesson stuck.
     */
    const overshoot = extraction(PASSAGE, 4)
    expect(() => extractionSchema.parse(overshoot)).not.toThrow()
  })
})
