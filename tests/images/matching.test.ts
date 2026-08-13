import { describe, expect, it } from 'vitest'
import {
  buildIndex,
  matchEntity,
  nameKey,
  trigramSimilarity,
} from '@/domains/images/match.ts'
import { chapterOf } from '@/domains/images/sources/onepieceapi.ts'
import { KIND_FOR_NODE_TYPE } from '@/domains/images/types.ts'
import { CANDIDATES } from '../helpers/image-catalogue.ts'

/**
 * Which picture belongs to which entity.
 *
 * The failure this guards against is not "no portrait" — that is visibly
 * nothing, and the reader draws the right conclusion. It is the *wrong*
 * portrait, which reads as a successful match and which nobody re-checks once
 * they have accepted a face. So most of what is asserted below is about
 * refusing, not about finding.
 */

const index = buildIndex(CANDIDATES)

function match(nodeType: string, label: string, chapter = 1) {
  return matchEntity(
    {
      entityId: 'e',
      nodeType,
      labels: [{ label, revealedInChapter: chapter, precedence: 100 }],
    },
    index,
  )
}

describe('finding the right picture', () => {
  it('matches an identical name', () => {
    const found = match('character', 'Monkey D. Luffy')
    expect(found?.candidate.sourceRef).toBe('op-luffy')
    expect(found?.method).toBe('exact')
    expect(found?.score).toBe(1)
  })

  it('ignores punctuation the catalogues disagree about', () => {
    // "Monkey D. Luffy" and "Monkey D Luffy" are the same person and the full
    // stop is the only thing between them.
    expect(match('character', 'Monkey D Luffy')?.candidate.sourceRef).toBe('op-luffy')
    expect(match('character', 'monkey d luffy')?.candidate.sourceRef).toBe('op-luffy')
  })

  it('matches the same words in another order', () => {
    // AniList writes given-family: "Zoro Roronoa".
    const found = match('character', 'Roronoa Zoro')
    expect(found?.candidate.sourceRef).toBe('op-zoro')
    expect(found?.score).toBe(1)
  })

  it('matches a fuller label against a shorter catalogue name', () => {
    // The page prints "Vinsmoke Sanji"; the catalogue only knows "Sanji".
    const found = match('character', 'Vinsmoke Sanji')
    expect(found?.candidate.sourceRef).toBe('op-sanji')
    expect(found?.method).toBe('subset')
    expect(found?.score).toBeLessThan(1)
  })

  it('prefers the source that also knows a chapter of first appearance', () => {
    // Both catalogues have Zoro under an exact name; onepieceapi wins because
    // its rows can be sanity-checked against the story.
    expect(match('character', 'Roronoa Zoro')?.candidate.source).toBe('onepieceapi')
  })

  it('finds a fruit by either of its names', () => {
    expect(match('power', 'Gomu Gomu no Mi')?.candidate.sourceRef).toBe('1')
    expect(match('power', 'Gum-Gum Fruit')?.candidate.sourceRef).toBe('1')
  })

  it('finds ships and islands', () => {
    expect(match('object', 'Going Merry')?.candidate.kind).toBe('ship')
    expect(match('place', 'Dawn Island')?.candidate.kind).toBe('island')
  })
})

describe('refusing the wrong picture', () => {
  it('attaches nothing to an invented placeholder', () => {
    expect(match('character', "L'homme au tablier de cuir")).toBeNull()
    expect(match('place', 'Le quai nord')).toBeNull()
  })

  it('never crosses kinds', () => {
    // "Going Merry" is a ship. Asked about a character of that name, there is
    // no answer — and a ship's picture would be a confident, silly lie.
    expect(match('character', 'Going Merry')).toBeNull()
    expect(match('place', 'Monkey D. Luffy')).toBeNull()
  })

  it('attaches nothing to a node type nothing illustrates', () => {
    // Concepts, battles, voyages and mysteries have no portraits anywhere, and
    // trying would report them as failures rather than as absences.
    expect(match('concept', 'Le One Piece')).toBeNull()
    expect(match('event', 'Monkey D. Luffy')).toBeNull()
    expect(Object.keys(KIND_FOR_NODE_TYPE)).toEqual([
      'character',
      'power',
      'object',
      'place',
    ])
  })

  it('refuses a short single word', () => {
    // Three letters is not identification. Even if something resembled it.
    expect(match('character', 'Roi')).toBeNull()
  })

  it('refuses a resemblance the story has not reached', () => {
    /*
     * The bug this file grew a rule for. « Morgan » is met in chapter 3;
     * « Morgans » is a different character the catalogue itself dates to
     * chapter 860, and the two share six of their eight trigrams. A reader at
     * chapter 20 was shown the bird.
     */
    expect(match('character', 'Morgan', 3)).toBeNull()
  })

  it('refuses it whichever catalogue offers the face', () => {
    /*
     * AniList carries Morgans too, and says nothing about chapters. Checking
     * row by row would refuse the dated copy and take the undated one — the
     * same wrong picture, from the other source.
     */
    const found = match('character', 'Morgan', 3)
    expect(found?.candidate.sourceRef).not.toBe('al-morgans')
    expect(found?.candidate.sourceRef).not.toBe('op-morgans')
  })

  it('still believes the name itself, however late the character', () => {
    // The chapter guards a resemblance, not an identity. A page that names
    // « Morgans » names Morgans, and no arithmetic on chapters says otherwise.
    expect(match('character', 'Morgans', 3)?.candidate.sourceRef).toBe('op-morgans')
  })

  it('allows the resemblance once the reader is there', () => {
    // Nothing about the spelling changed; what changed is that chapter 860 is
    // no longer eight hundred chapters away from the reader.
    expect(match('character', 'Morgan', 900)?.candidate.sourceRef).toBe('op-morgans')
  })

  it('does not fall for a decoy sharing a word', () => {
    /*
     * The catalogue holds "Faux Zoro" (Manjarou) as well as Zoro himself. A
     * bare closest-string rule picks whichever happens to score a hundredth
     * higher, silently. Whatever this returns, it must not be the impostor.
     */
    const found = match('character', 'Zoro')
    expect(found?.candidate.sourceRef).not.toBe('al-fake-zoro')
  })
})

describe('what a match carries with it', () => {
  it('records the label that found it and that label’s chapter', () => {
    const found = matchEntity(
      {
        entityId: 'e',
        nodeType: 'character',
        labels: [
          { label: "l'homme au tablier de cuir", revealedInChapter: 1, precedence: 10 },
          { label: 'Monkey D. Luffy', revealedInChapter: 37, precedence: 100 },
        ],
      },
      index,
    )

    // The picture was found by the true name, so it belongs to chapter 37 —
    // not to chapter 1, where the reader had only a description.
    expect(found?.matchedLabel).toBe('Monkey D. Luffy')
    expect(found?.revealedInChapter).toBe(37)
  })

  it('prefers the earliest label when two find the same picture', () => {
    const found = matchEntity(
      {
        entityId: 'e',
        nodeType: 'character',
        labels: [
          { label: 'Monkey D. Luffy', revealedInChapter: 37, precedence: 100 },
          { label: 'Straw Hat', revealedInChapter: 5, precedence: 40 },
        ],
      },
      index,
    )

    // An epithet the story gives early identifies the character just as well.
    // Waiting for the formal name would hide a face the reader could have had.
    expect(found?.revealedInChapter).toBe(5)
  })
})

describe('the pieces underneath', () => {
  it('folds accents, ligatures and punctuation', () => {
    expect(nameKey('Monkey D. Luffy')).toBe('monkey d luffy')
    expect(nameKey('Nefertari Vivi')).toBe(nameKey('Néfertari Vivi'))
    expect(nameKey('  Zoro  ')).toBe('zoro')
    expect(nameKey('—')).toBe('')
  })

  it('scores identical strings at one and unrelated ones low', () => {
    expect(trigramSimilarity('zoro', 'zoro')).toBe(1)
    expect(trigramSimilarity('kuina', 'kuma')).toBeLessThan(0.5)
    expect(trigramSimilarity('', 'zoro')).toBe(0)
  })

  it('reads a chapter out of a first-appearance string, or nothing', () => {
    expect(chapterOf('Chapter 436; Episode 321')).toBe(436)
    expect(chapterOf('Chapter 1; Episode 4')).toBe(1)
    // No guessing from an episode number, a volume, or prose.
    expect(chapterOf('Episode 321')).toBeNull()
    expect(chapterOf('unknown')).toBeNull()
    expect(chapterOf(null)).toBeNull()
    expect(chapterOf('')).toBeNull()
  })
})
