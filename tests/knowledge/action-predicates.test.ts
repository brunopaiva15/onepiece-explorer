import { describe, expect, it } from 'vitest'
import {
  PREDICATE_BY_KEY,
  REVIEW_REQUIRED_PREDICATES,
  checkTypes,
} from '@/domains/knowledge/ontology.ts'
import { buildEntityProfile, roleLabel } from '@/domains/knowledge/profile.ts'

/**
 * What someone does to someone else.
 *
 * The ontology could say that two characters fought and that one of them died
 * in a scene. It could not say that the first one killed the second — and that
 * is the sentence the wiki's chapter notes write in so many words: « Arlong
 * kills Bell-mère ». A model reading it had `fights`, which is symmetric and
 * names no winner, or `dies_at`, which places the death and names nobody.
 *
 * Four verbs answer it, and the distance between them is the point: `kills`,
 * `injures`, `knocks_out` — what the blow left behind — and `gives`, whose
 * third term is carried by `receives` because a relation joins two things.
 */

const fact = (predicate: string, direction: 'outgoing' | 'incoming', otherType: string) => ({
  assertionId: `a-${predicate}-${direction}`,
  predicate,
  direction,
  otherId: 'other',
  otherLabel: 'Bell-mère',
  otherType,
  literalValue: null,
  epistemicStatus: 'stated',
  knowledgeFromChapter: 78,
  knowledgeUntilChapter: null,
  locked: false,
  evidence: [],
})

describe('killing, and the two lesser answers', () => {
  it('names the killer, which « meurt à » never could', () => {
    const kills = PREDICATE_BY_KEY.get('kills')
    expect(kills?.labelFr).toBe('tue')
    expect(kills?.directed).toBe(true)
    expect(kills?.symmetric).toBe(false)
    // Arlong kills Bell-mère: an actor at each end, a direction that means
    // something, and the pair of them is not the pair the other way round.
    expect(checkTypes('kills', 'character', 'character')).toBeNull()
    expect(checkTypes('kills', 'group', 'group')).toBeNull()
  })

  it('can never be swept up by a bulk acceptance', () => {
    // The same rule as `dies_at`, for the same reason: a death accepted on
    // confidence alone, or accepted one chapter too early, corrupts every past
    // view of the story. `injures` and `knocks_out` carry no such weight —
    // nobody is permanently anything afterwards.
    expect(REVIEW_REQUIRED_PREDICATES.has('kills')).toBe(true)
    expect(REVIEW_REQUIRED_PREDICATES.has('injures')).toBe(false)
    expect(REVIEW_REQUIRED_PREDICATES.has('knocks_out')).toBe(false)
  })

  it('reads as the end of the story on the victim’s sheet', () => {
    const [section] = buildEntityProfile('character', [fact('kills', 'incoming', 'character')])
    expect(section!.key).toBe('mort')
    expect(section!.entries[0]!.roles[0]!.label).toBe('tué par')
  })

  it('reads as one adversary among others on the killer’s sheet', () => {
    const [section] = buildEntityProfile('character', [fact('kills', 'outgoing', 'character')])
    expect(section!.key).toBe('adversaires')
    expect(roleLabel('injures', 'incoming')).toBe('blessé par')
    expect(roleLabel('knocks_out', 'incoming')).toBe('assommé par')
  })
})

describe('a gift, which has one term too many', () => {
  it('is written from both sides, over the same object', () => {
    // « Shanks donne le chapeau de paille » and « Luffy reçoit le chapeau de
    // paille ». Neither is the other read backwards — the subjects differ — so
    // neither declares the other as its inverse.
    expect(PREDICATE_BY_KEY.get('gives')?.objectTypes).toEqual(['object'])
    expect(PREDICATE_BY_KEY.get('receives')?.objectTypes).toEqual(['object'])
    expect(PREDICATE_BY_KEY.get('gives')?.inverseKey).toBeUndefined()
    expect(PREDICATE_BY_KEY.get('receives')?.inverseKey).toBeUndefined()
  })

  it('meets on the object’s sheet, which is where the question is asked', () => {
    const [section] = buildEntityProfile('object', [
      fact('gives', 'incoming', 'character'),
      fact('receives', 'incoming', 'character'),
    ])
    expect(section!.key).toBe('detenteurs')
    expect(section!.entries[0]!.roles.map((role) => role.label)).toEqual([
      'donné par',
      'reçu par',
    ])
  })

  it('refuses a person in the slot the object belongs in', () => {
    // « Bell-mère donne Nami » is a sentence the ontology has to stop: what is
    // given is a thing, and the person it goes to is the other half of the
    // pair, not the object of this one.
    const mismatch = checkTypes('gives', 'character', 'character')
    expect(mismatch?.objectAccepted).toBe(false)
  })
})
