import { describe, expect, it } from 'vitest'
import {
  LIKELY_SAME,
  scoreResolution,
  tokens,
  WORTH_CHECKING,
  type ResolutionSignals,
} from '@/domains/resolution/scoring.ts'

/**
 * Blocking test 7: two similar characters must stay distinct.
 *
 * This is the scoring half — the arithmetic that decides what gets proposed. The
 * database half (that a merge is a dated assertion, and that the chapter-20 view
 * still shows two nodes) is in boundary-guards.test.ts.
 *
 * The cost matrix here is asymmetric and everything follows from it. A missed
 * merge leaves two nodes the user joins in one click. A wrong merge silently
 * rewrites what the reader knew at every chapter in between, and the graph looks
 * perfectly correct afterwards — there is nothing to notice.
 */

function signals(overrides: Partial<ResolutionSignals> = {}): ResolutionSignals {
  return {
    candidate: {
      label: 'homme au foulard rayé',
      isPlaceholder: true,
      nodeType: 'character',
    },
    existing: {
      id: 'e1',
      label: 'homme au foulard rayé',
      isPlaceholder: true,
      nodeType: 'character',
      firstSeenChapter: 1,
    },
    candidateChapter: 2,
    candidateDescriptors: [],
    existingDescriptors: [],
    candidateNeighbours: [],
    existingNeighbours: [],
    ...overrides,
  }
}

describe('no single signal can carry a merge', () => {
  it('does not reach the threshold on identical placeholders alone', () => {
    /*
     * The most dangerous match in the system. Two appearances both described as
     * "the man in the striped scarf" is two descriptions of a stripe — and a
     * scarf is exactly the kind of detail a story gives to two people on
     * purpose, then resolves three hundred chapters later.
     */
    const score = scoreResolution(signals())

    expect(score.total).toBeLessThan(LIKELY_SAME)
    expect(score.suggestion).not.toBe('likely_same')
    // And the reason says why, in words the user reads rather than a number.
    expect(score.signals.find((s) => s.key === 'name')?.reason).toMatch(
      /descriptions visuelles, pas des noms/,
    )
  })

  it('does not reach the threshold on an exact name alone', () => {
    // Even a real name shared by two entities is 0.4 of the weight. A story can
    // reuse a name, and the remaining signals are what distinguish the cases.
    const score = scoreResolution(
      signals({
        candidate: { label: 'Kaelo Renn', isPlaceholder: false, nodeType: 'character' },
        existing: {
          id: 'e1',
          label: 'Kaelo Renn',
          isPlaceholder: false,
          nodeType: 'character',
          firstSeenChapter: 1,
        },
        candidateChapter: 40,
      }),
    )
    expect(score.total).toBeLessThan(LIKELY_SAME)
  })

  it('does not reach the threshold on visual similarity alone', () => {
    const score = scoreResolution(
      signals({
        candidate: { label: 'silhouette encapuchonnée', isPlaceholder: true, nodeType: 'character' },
        existing: {
          id: 'e1',
          label: 'femme au manteau rouge',
          isPlaceholder: true,
          nodeType: 'character',
          firstSeenChapter: 1,
        },
        candidateDescriptors: ['manteau rouge', 'capuche'],
        existingDescriptors: ['manteau rouge', 'capuche'],
      }),
    )
    expect(score.total).toBeLessThan(LIKELY_SAME)
  })

  it('only reaches the threshold when several independent signals agree', () => {
    const score = scoreResolution(
      signals({
        candidate: { label: 'Kaelo Renn', isPlaceholder: false, nodeType: 'character' },
        existing: {
          id: 'e1',
          label: 'Kaelo Renn',
          isPlaceholder: false,
          nodeType: 'character',
          firstSeenChapter: 2,
        },
        candidateChapter: 3,
        candidateDescriptors: ['foulard rayé', 'sabre au côté'],
        existingDescriptors: ['foulard rayé', 'sabre au côté'],
        candidateNeighbours: ['n1', 'n2'],
        existingNeighbours: ['n1', 'n2'],
      }),
    )
    expect(score.total).toBeGreaterThanOrEqual(LIKELY_SAME)
    expect(score.suggestion).toBe('likely_same')
  })
})

describe('two deliberately similar characters', () => {
  it('stays below "worth checking" when only the clothing matches', () => {
    /*
     * The fixture corpus trap, in scoring form: two figures sharing one
     * garment, appearing in different company, chapters apart. A similarity
     * search finds them; the weights must not.
     */
    const score = scoreResolution(
      signals({
        candidate: { label: 'homme au foulard rayé', isPlaceholder: true, nodeType: 'character' },
        existing: {
          id: 'e1',
          label: 'homme au foulard sombre',
          isPlaceholder: true,
          nodeType: 'character',
          firstSeenChapter: 1,
        },
        candidateChapter: 30,
        candidateDescriptors: ['foulard'],
        existingDescriptors: ['foulard'],
        candidateNeighbours: ['a1'],
        existingNeighbours: ['b1'],
      }),
    )

    expect(score.total).toBeLessThan(WORTH_CHECKING)
    expect(score.suggestion).toBe('likely_different')
  })

  it('reports every signal, including the ones that found nothing', () => {
    // A score with only its supporting reasons shown is an argument, not
    // evidence. The user needs to see what did not match.
    const score = scoreResolution(signals())
    expect(score.signals.map((s) => s.key)).toEqual([
      'name',
      'visual',
      'cooccurrence',
      'chapter',
    ])
    expect(score.signals.every((s) => s.reason.length > 0)).toBe(true)

    const visual = score.signals.find((s) => s.key === 'visual')
    expect(visual?.score).toBe(0)
    expect(visual?.reason).toMatch(/Aucune signature visuelle/)
  })
})

describe('signal weighting', () => {
  it('weights sum to one, so the total is a fraction and not a scale', () => {
    const score = scoreResolution(signals())
    const sum = score.signals.reduce((total, signal) => total + signal.weight, 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  it('treats chapter distance as a tie-breaker, not evidence', () => {
    const near = scoreResolution(signals({ candidateChapter: 1 }))
    const far = scoreResolution(signals({ candidateChapter: 300 }))
    // It moves the needle, but by less than a tenth — the weight it is given.
    expect(near.total).toBeGreaterThan(far.total)
    expect(near.total - far.total).toBeLessThanOrEqual(0.1)
  })

  it('scores unrelated designations at zero rather than near zero', () => {
    const score = scoreResolution(
      signals({
        candidate: { label: 'Aldren', isPlaceholder: false, nodeType: 'character' },
        existing: {
          id: 'e1',
          label: 'Maren',
          isPlaceholder: false,
          nodeType: 'character',
          firstSeenChapter: 1,
        },
      }),
    )
    expect(score.signals.find((s) => s.key === 'name')?.score).toBe(0)
  })
})

describe('tokenisation', () => {
  it('drops French function words, which otherwise dominate descriptions', () => {
    // "l'homme au foulard" and "la femme au manteau" share two of four raw
    // tokens and describe nobody in common.
    expect(tokens('le homme au foulard rayé')).toEqual(['homme', 'foulard', 'raye'])
  })

  it('folds accents so a transcription variant still matches', () => {
    expect(tokens('foulard rayé')).toEqual(tokens('foulard raye'))
  })
})
