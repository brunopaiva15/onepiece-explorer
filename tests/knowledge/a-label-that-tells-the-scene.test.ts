import { describe, expect, it } from 'vitest'
import { readsAsDescription } from '@/domains/knowledge/label-shape.ts'

/**
 * A name that is only true in one panel.
 *
 * « Escargophone utilisé par Crocodile pour contacter les Billions » came back
 * from a real chapter, with an anchored excerpt saying exactly that, and became
 * the name of an object. Every guard in the pipeline agreed: anchoring checks
 * the claim, the ontology checks the type, and the label is free text nobody
 * reads. The cost lands two chapters later, when the same Escargophone in
 * another hand is described differently and the graph keeps two of them.
 *
 * The test is grammatical rather than editorial. A name is a noun phrase; a
 * description hangs a clause off one, and the clause is what belongs in a
 * relation. So the cases below are about where the clause starts, and about the
 * names that must go on passing — a rule that flags « Équipage du Chapeau de
 * Paille » would be a rule nobody keeps.
 */

describe('a label that tells the scene instead of naming the thing', () => {
  it('finds the agent clause and offers the name in front of it', () => {
    const found = readsAsDescription(
      'Escargophone utilisé par Crocodile pour contacter les Billions',
    )

    expect(found?.reason).toBe('clause')
    // « Escargophone utilisé » is not a name either: the participle goes with
    // the agent it introduced.
    expect(found?.suggestion).toBe('Escargophone')
  })

  it('keeps the compound name when the clause is what follows it', () => {
    const found = readsAsDescription('Tempêtes de sable de Yuba provoquées par Crocodile')

    expect(found?.suggestion).toBe('Tempêtes de sable de Yuba')
  })

  it('cuts a relative clause', () => {
    expect(readsAsDescription('L’homme au foulard rayé qui menace le village')).toEqual({
      reason: 'clause',
      suggestion: 'L’homme au foulard rayé',
    })
  })

  it('cuts a purpose clause', () => {
    expect(readsAsDescription('Clé de la cellule pour libérer les prisonniers')?.suggestion).toBe(
      'Clé de la cellule',
    )
  })

  it('cuts what follows a comma, which is a sentence getting in', () => {
    expect(readsAsDescription('Bananawani, les crocodiles du bassin')?.suggestion).toBe(
      'Bananawani',
    )
  })

  it('says a long label is long even with no clause to cut', () => {
    const found = readsAsDescription(
      'Grand navire de guerre noir aux voiles déchirées et à la proue brisée',
    )

    expect(found?.reason).toBe('length')
    // Nothing offered: there is no clause boundary here, and cutting a compound
    // name at the sixth word would invent a name rather than shorten one.
    expect(found?.suggestion).toBeNull()
  })

  it('leaves the names the work actually uses alone', () => {
    for (const label of [
      'Monkey D. Luffy',
      'Nefertari Vivi',
      'Équipage du Chapeau de Paille',
      'Village de Fuchsia',
      'l’homme au foulard rayé',
      'la femme au manteau rouge',
      'Le Seigneur de la Côte',
      'Fruit du Démon Bara Bara',
      'Escargophone',
      'Baroque Works',
      'Tempêtes de sable de Yuba',
    ]) {
      expect(readsAsDescription(label), label).toBeNull()
    }
  })

  it('does not cut a name that opens on a relative pronoun', () => {
    // « Ceux qui restent » is a group, not a clause hanging off a name: there
    // is nothing in front of the pronoun to keep.
    expect(readsAsDescription('Ceux qui restent')).toBeNull()
  })

  it('never leaves a preposition dangling at the end of a suggestion', () => {
    // « L'ami de » is not a name, and a button offering it would teach the
    // reviewer to stop reading the offers.
    expect(readsAsDescription('L’ami de qui parle Nami')?.suggestion).toBe('L’ami')
    expect(readsAsDescription('Le sabre de qui frappe Zoro')?.suggestion).toBe('Le sabre')
  })

  it('says nothing about an empty label', () => {
    expect(readsAsDescription('   ')).toBeNull()
  })
})
