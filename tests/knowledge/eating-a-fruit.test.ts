import { describe, expect, it } from 'vitest'
import {
  PREDICATE_BY_KEY,
  REVIEW_REQUIRED_PREDICATES,
  checkTypes,
} from '@/domains/knowledge/ontology.ts'
import { buildEntityProfile, roleLabel } from '@/domains/knowledge/profile.ts'

/**
 * « Chopper ate the Hito Hito no Mi ».
 *
 * The most ordinary sentence in this work, and the ontology had nowhere to put
 * it. The model wrote what was left to it — `grants_power` from the fruit to the
 * character — and the review board answered « relation impossible en l'état » :
 * « confère le pouvoir » takes a power as its object, and Tony Tony Chopper is
 * not one. The reviewer's only remaining move was to reject a fact the chapter
 * states in as many words.
 *
 * `eats` is the missing verb, and it keeps the three nodes apart rather than
 * collapsing them: the character eats the fruit, the fruit grants the capacity,
 * the character uses the capacity. Nothing about `grants_power` moves — a fruit
 * confers a power, it never confers a person.
 */

const fact = (predicate: string, direction: 'outgoing' | 'incoming', otherType: string) => ({
  assertionId: `a-${predicate}-${direction}`,
  predicate,
  direction,
  otherId: 'other',
  otherLabel: 'Hito Hito no Mi',
  otherType,
  literalValue: null,
  epistemicStatus: 'explicit',
  knowledgeFromChapter: 140,
  knowledgeUntilChapter: null,
  locked: false,
  evidence: [],
})

describe('manger un fruit du démon', () => {
  it('joins a character to the fruit, which nothing could say before', () => {
    const eats = PREDICATE_BY_KEY.get('eats')
    expect(eats?.labelFr).toBe('mange')
    expect(eats?.directed).toBe(true)
    expect(eats?.symmetric).toBe(false)
    expect(checkTypes('eats', 'character', 'object')).toBeNull()
  })

  it('refuses a crew as the eater, and a capacity as the meal', () => {
    // Un équipage ne mange pas un fruit : l'un de ses membres le fait, et c'est
    // sa fiche à lui que le lecteur ouvre.
    expect(checkTypes('eats', 'group', 'object')?.subjectAccepted).toBe(false)
    // Et ce qui se mange est le fruit, pas la capacité qu'il donne — c'est
    // exactement la distinction que le type « Objet » a été fait pour tenir.
    expect(checkTypes('eats', 'character', 'power')?.objectAccepted).toBe(false)
  })

  it('is not a revelation held for explicit review', () => {
    // Une mort ou une filiation fausse corrompt toutes les vues antérieures ;
    // un fruit mangé, non. La confiance du modèle suffit à le proposer.
    expect(REVIEW_REQUIRED_PREDICATES.has('eats')).toBe(false)
  })
})

describe('« confère le pouvoir », qui ne va pas vers un personnage', () => {
  it('still refuses the relation the review board showed', () => {
    const mismatch = checkTypes('grants_power', 'object', 'character')
    expect(mismatch?.objectAccepted).toBe(false)
    expect(mismatch?.expectedObjectTypes).toEqual(['power'])
  })

  it('offers « mange » to the reviewer, the two ends swapped', () => {
    // C'est la sortie que la carte n'avait pas : la liste « en inversant les
    // deux bouts » se lit « Tony Tony Chopper mange Hito Hito no Mi », et
    // l'accepter écrit le fait plutôt que de le perdre.
    const mismatch = checkTypes('grants_power', 'object', 'character')
    expect(mismatch?.reversedAlternatives.map((a) => a.key)).toContain('eats')
    // Dans ce sens-là, rien : un fruit ne fait rien à un personnage.
    expect(mismatch?.alternatives.map((a) => a.key)).not.toContain('eats')
  })

  it('keeps saying what a fruit gives, from the fruit to the capacity', () => {
    expect(checkTypes('grants_power', 'object', 'power')).toBeNull()
  })
})

describe('les deux fiches', () => {
  it('reads « a mangé » among what a character holds', () => {
    const [section] = buildEntityProfile('character', [
      fact('eats', 'outgoing', 'object'),
    ])
    expect(section!.key).toBe('avoir')
    expect(section!.entries[0]!.roles[0]!.label).toBe('a mangé')
  })

  it('opens the fruit’s sheet on who ate it', () => {
    // Un fruit mangé n'a plus de détenteur, il a eu un mangeur : la question se
    // pose avant celle des possessions, et sa section passe devant.
    const sections = buildEntityProfile('object', [
      fact('eats', 'incoming', 'character'),
      fact('owns', 'incoming', 'character'),
    ])
    expect(sections.map((s) => s.key)).toEqual(['mange-par', 'detenteurs'])
    expect(sections[0]!.entries[0]!.roles[0]!.label).toBe('mangé par')
    expect(roleLabel('eats', 'incoming')).toBe('mangé par')
  })

  it('leaves an ordinary object without the heading', () => {
    const sections = buildEntityProfile('object', [fact('owns', 'incoming', 'character')])
    expect(sections.map((s) => s.key)).not.toContain('mange-par')
  })
})
