import { describe, expect, it } from 'vitest'
import { PREDICATE_BY_KEY, checkTypes } from '@/domains/knowledge/ontology.ts'
import { buildEntityProfile, roleLabel } from '@/domains/knowledge/profile.ts'

/**
 * What one may know, and whom one may use.
 *
 * Two sentences the ontology refused, both of them true. « Robin connaît les
 * Poneglyphes » — the whole of that character — had no edge, because `knows`
 * joined two people and nothing else. « Arlong utilise Nami » had none either:
 * `uses` took an object or a power, and a person used as a means is neither.
 *
 * Widening the first one is not a matter of adding a type to a list. `knows`
 * was symmetric, and a symmetric predicate whose ends accept different types is
 * a contradiction: read the other way round it says the stone knows Robin, and
 * the sheet would have printed exactly that. So it is directed now — which it
 * should always have been, since knowing of Barbe Blanche has never made
 * Barbe Blanche know you — and the far end reads « connu de ». `meets` keeps
 * its symmetry, a meeting happening to both by construction.
 */

const fact = (
  predicate: string,
  direction: 'outgoing' | 'incoming',
  otherType: string,
  otherLabel = 'Autre',
) => ({
  assertionId: `a-${predicate}-${direction}-${otherType}`,
  predicate,
  direction,
  otherId: `other-${otherType}`,
  otherLabel,
  otherType,
  literalValue: null,
  epistemicStatus: 'explicit',
  knowledgeFromChapter: 1,
  knowledgeUntilChapter: null,
  locked: false,
  evidence: [],
})

describe('« connaît », which points at things too', () => {
  it('accepts what a person can know, and still refuses a knowing stone', () => {
    for (const objectType of ['character', 'group', 'object', 'place', 'concept']) {
      expect(checkTypes('knows', 'character', objectType)).toBeNull()
      expect(checkTypes('knows', 'group', objectType)).toBeNull()
    }
    // The far end may be a thing; the near end may not. A Poneglyph knows
    // nobody, and that asymmetry is the reason the predicate is directed.
    expect(checkTypes('knows', 'object', 'character')?.subjectAccepted).toBe(false)
  })

  it('is directed, so the thing’s sheet says « connu de » rather than « connaît »', () => {
    const predicate = PREDICATE_BY_KEY.get('knows')
    expect(predicate?.directed).toBe(true)
    expect(predicate?.symmetric).toBe(false)
    expect(roleLabel('knows', 'incoming')).toBe('connu de')

    const stone = buildEntityProfile('object', [
      fact('knows', 'incoming', 'character', 'Robin'),
    ])
    expect(stone[0]!.key).toBe('connu-de')
    expect(stone[0]!.title).toBe('Qui le connaît')
    expect(stone[0]!.entries[0]!.roles[0]!.label).toBe('connu de')
  })

  it('separates what someone knows from whom they know', () => {
    const [rencontres, savoirs] = buildEntityProfile('character', [
      fact('knows', 'outgoing', 'character', 'Nami'),
      fact('knows', 'outgoing', 'object', 'Poneglyph'),
    ])

    expect(rencontres!.key).toBe('rencontres')
    expect(rencontres!.entries[0]!.otherLabel).toBe('Nami')
    expect(savoirs!.key).toBe('savoirs')
    expect(savoirs!.entries[0]!.otherLabel).toBe('Poneglyph')
  })

  it('reads mutual knowledge as the two facts it now is', () => {
    // Symmetry used to fold both rows onto one rôle, which said « connaît »
    // whichever end had been written. Two people who know each other are two
    // assertions, on one line, each keeping its direction.
    const [section] = buildEntityProfile('character', [
      fact('knows', 'outgoing', 'character', 'Shanks'),
      { ...fact('knows', 'incoming', 'character', 'Shanks'), assertionId: 'a-in' },
    ])

    expect(section!.entries).toHaveLength(1)
    expect(section!.entries[0]!.roles.map((role) => role.label)).toEqual([
      'connaît',
      'connu de',
    ])
  })

  it('lets a crew know, meet and speak as one of its members does', () => {
    // The ontology already let a group fight, ally, protect and capture. Only
    // the three verbs of acquaintance stopped at the individual.
    expect(checkTypes('meets', 'group', 'character')).toBeNull()
    expect(checkTypes('speaks_to', 'group', 'character')).toBeNull()

    const [section] = buildEntityProfile('group', [
      fact('meets', 'incoming', 'character', 'Luffy'),
    ])
    // Still symmetric, so the crew's sheet shows the meeting once, whichever
    // end the extraction happened to write first.
    expect(section!.key).toBe('rencontres')
    expect(section!.entries[0]!.roles[0]!.label).toBe('a rencontré')
  })
})

describe('« utilise », when the means is a person', () => {
  it('accepts someone, without calling them a possession', () => {
    expect(checkTypes('uses', 'character', 'character')).toBeNull()
    expect(checkTypes('uses', 'group', 'character')).toBeNull()

    const [emprise] = buildEntityProfile('character', [
      fact('uses', 'outgoing', 'character', 'Nami'),
    ])
    expect(emprise!.title).toBe('Emprise')
    expect(emprise!.entries[0]!.roles[0]!.label).toBe('se sert de')
  })

  it('reads from the used person’s side too', () => {
    const [emprise] = buildEntityProfile('character', [
      fact('uses', 'incoming', 'character', 'Arlong'),
    ])
    expect(emprise!.key).toBe('emprise')
    expect(emprise!.entries[0]!.roles[0]!.label).toBe('utilisé par')
  })

  it('leaves objects and powers where they were', () => {
    const [avoir] = buildEntityProfile('character', [
      fact('uses', 'outgoing', 'power', 'Gomu Gomu no Pistol'),
    ])
    expect(avoir!.title).toBe('Possessions et pouvoirs')
  })
})

describe('the two holes the sheets already showed', () => {
  it('lets a technique have the origin its fiche asked for', () => {
    // « Origine » on a power's sheet declared `creates:in` long before the
    // ontology allowed anyone to write it: a slot with nothing that could ever
    // land in it.
    expect(checkTypes('creates', 'character', 'power')).toBeNull()

    const [origine] = buildEntityProfile('power', [
      fact('creates', 'incoming', 'character', 'Zoro'),
    ])
    expect(origine!.key).toBe('origine')
    expect(origine!.entries[0]!.roles[0]!.label).toBe('créé par')
  })

  it('lets a crew be hunted, not only its captain', () => {
    expect(checkTypes('seeks', 'group', 'group')).toBeNull()

    const [section] = buildEntityProfile('group', [
      fact('seeks', 'incoming', 'group', 'La Marine'),
    ])
    expect(section!.title).toBe('Recherché par')
    expect(section!.entries[0]!.roles[0]!.label).toBe('recherché par')
  })
})
