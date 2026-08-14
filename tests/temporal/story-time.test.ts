import { describe, expect, it } from 'vitest'
import { buildAnchorSources, filterExtraction, type OntologyView } from '@/domains/ai/anchoring.ts'
import type { Extraction } from '@/domains/ai/schemas.ts'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'

/**
 * A date is a fact, so it is proved like one.
 *
 * `events.story_time` existed from the first migration and nothing ever wrote
 * it: no extraction field asked when a scene happens, so the column was null in
 * every library, and the chronology said « aucun événement n'a de position
 * connue » — accurately, at every chapter, forever.
 *
 * Filling it is the easy half. The half that matters is that a model asked
 * « when does this happen » already knows the answer for One Piece and will
 * give it whether or not the chapter said anything, which is the single failure
 * ADR 0003 exists to prevent. So a dating carries the chapter's own sentence,
 * and that sentence has to be findable in the blocks the scene already cites.
 *
 * The rest of this file is about what happens when it is not: the scene lives,
 * the date dies, and the refusal is visible rather than silent.
 */

const ONTOLOGY: OntologyView = {
  nodeTypes: new Set(NODE_TYPES.map((t) => t.key)),
  predicates: new Set(PREDICATES.map((p) => p.key)),
}

const CHAPTER = {
  b1: "Dix ans plus tôt, l'homme au foulard rayé avait quitté le village sans se retourner.",
  b2: 'Le vieux pêcheur repose sa chope et regarde la mer.',
}

function sources() {
  return buildAnchorSources({
    textBlocks: [
      { ref: 'b1', text: CHAPTER.b1 },
      { ref: 'b2', text: CHAPTER.b2 },
    ],
    descriptions: [],
    allowedRefs: ['b1', 'b2'],
    // A chapter you typed, not a scan: an excerpt is in your text or it is not.
    tolerateNoise: false,
  })
}

/** One scene, cited on b1, dated however the caller wants. */
function extraction(storyTime: unknown): Extraction {
  return {
    entities: [],
    assertions: [],
    events: [
      {
        local_id: 'e1',
        summary: "L'homme au foulard rayé quitte le village.",
        participants: [],
        is_flashback: true,
        story_time: storyTime as never,
        evidence: [{ ref: 'b1', kind: 'text', excerpt: 'avait quitté le village' }],
        confidence: 0.9,
      },
    ],
    mysteries: [],
  } as Extraction
}

const QUOTED = {
  kind: 'approximate' as const,
  years_ago: 10,
  description: 'dix ans plus tôt',
  quote: 'Dix ans plus tôt',
}

describe('a dating the chapter can be quoted for', () => {
  it('survives', () => {
    const result = filterExtraction(extraction(QUOTED), sources(), ONTOLOGY, new Set())

    expect(result.accepted.events).toHaveLength(1)
    expect(result.accepted.events[0]!.story_time).toEqual(QUOTED)
    expect(result.quarantined).toHaveLength(0)
  })

  it('may cite any block the scene itself cites, and no others', () => {
    // The quote here is real text from the chapter — but from b2, which this
    // scene does not cite. A chapter is full of sentences, and a date hunted
    // down anywhere in it could date any scene at all; the chapter has to have
    // dated *this* one.
    const elsewhere = {
      ...QUOTED,
      quote: 'Le vieux pêcheur repose sa chope',
    }
    const result = filterExtraction(extraction(elsewhere), sources(), ONTOLOGY, new Set())

    expect(result.accepted.events[0]!.story_time).toBeNull()
  })
})

describe('a dating the chapter does not support', () => {
  it('is refused even when it is the right answer', () => {
    // This is the whole point. The model knows One Piece; « vingt-deux ans plus
    // tôt » is very often correct and is not in this chapter. A right answer
    // reached the forbidden way is the failure, not a lucky escape.
    const remembered = {
      kind: 'approximate' as const,
      years_ago: 22,
      description: 'vingt-deux ans plus tôt',
      quote: 'vingt-deux ans plus tôt',
    }
    const result = filterExtraction(extraction(remembered), sources(), ONTOLOGY, new Set())

    expect(result.accepted.events[0]!.story_time).toBeNull()
  })

  it('costs the date and never the scene', () => {
    const result = filterExtraction(
      extraction({ ...QUOTED, quote: 'une phrase que ce chapitre ne contient pas' }),
      sources(),
      ONTOLOGY,
      new Set(),
    )

    expect(result.accepted.events).toHaveLength(1)
    expect(result.accepted.events[0]!.summary).toContain('quitte le village')
    expect(result.accepted.events[0]!.story_time).toBeNull()
  })

  it('is refused out loud, not dropped on the floor', () => {
    // Quarantine is the diagnostic, and a date silently deleted is a date
    // nobody ever finds out was proposed.
    const result = filterExtraction(
      extraction({ ...QUOTED, quote: 'rien de tel dans le texte' }),
      sources(),
      ONTOLOGY,
      new Set(),
    )

    expect(result.quarantined).toHaveLength(1)
    expect(result.quarantined[0]!.reason).toBe('excerpt_not_in_source')
    expect(result.quarantined[0]!.detail).toContain('sans date')
  })

  it('does not reject a paraphrase as though it were a quote', () => {
    // « Dix ans auparavant » says the same thing and is not what the chapter
    // wrote. Same rule as every other excerpt: une citation reformulée n'est
    // pas une citation.
    const result = filterExtraction(
      extraction({ ...QUOTED, quote: 'Dix ans auparavant' }),
      sources(),
      ONTOLOGY,
      new Set(),
    )

    expect(result.accepted.events[0]!.story_time).toBeNull()
  })
})

describe('a scene with no dating at all', () => {
  it('is the ordinary case and passes through untouched', () => {
    for (const nothing of [null, undefined]) {
      const result = filterExtraction(extraction(nothing), sources(), ONTOLOGY, new Set())
      expect(result.accepted.events).toHaveLength(1)
      expect(result.accepted.events[0]!.story_time).toBeNull()
      expect(result.quarantined).toHaveLength(0)
    }
  })
})
