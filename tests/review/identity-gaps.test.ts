import { describe, expect, it } from 'vitest'
import {
  gapInputs,
  gapQuestion,
  identityGapFinding,
  parseIdentityGaps,
  type GapCandidate,
  type GapPassage,
} from '@/domains/review/identity-gaps.ts'

/**
 * Les identités que le texte révèle et que le graphe n'a jamais écrites.
 *
 * Trois couples, tirés du Mode histoire de la bibliothèque de référence, et
 * chacun éprouve une chose que la règle doit faire toute seule :
 *
 *   le renne du sommet mène à Chopper **et pas à Wapol**, parce que la fiche
 *   nommée est celle que le modèle cite parmi celles qu'on lui a données ;
 *
 *   « Mr Prince » mène à Sanji **et pas à Chopper**, pour la même raison ;
 *
 *   « Miss All Sunday » et Nico Robin sont datés du chapitre **176**, qui est
 *   celui du passage cité — jamais celui que le modèle annoncerait.
 *
 * Aucun de ces noms n'existe dans la logique : ce sont des données de test, et
 * la même fonction sur une autre œuvre trouvera ses propres révélations.
 */

function candidate(
  input: Partial<GapCandidate> & { entityId: string; label: string },
): GapCandidate {
  return {
    nodeType: 'character',
    firstSeenChapter: 1,
    revealedInChapter: 1,
    ...input,
  }
}

function passage(input: Partial<GapPassage> & { id: string; text: string }): GapPassage {
  return { ref: input.id, chapter: 1, ...input }
}

describe('la silhouette du sommet', () => {
  const candidates = [
    candidate({
      entityId: 'silhouette',
      label: 'Silhouette au sommet',
      firstSeenChapter: 138,
      revealedInChapter: 138,
    }),
    candidate({
      entityId: 'chopper',
      label: 'Tony Tony Chopper',
      firstSeenChapter: 140,
      revealedInChapter: 140,
    }),
    candidate({ entityId: 'wapol', label: 'Wapol', firstSeenChapter: 134, revealedInChapter: 134 }),
  ]

  const passages = [
    passage({
      id: 'b1',
      chapter: 140,
      text: 'Le renne bleu s’avance et se nomme : son véritable nom est Tony Tony Chopper.',
    }),
    passage({ id: 'b2', chapter: 140, text: 'Wapol, lui, reste terré dans la neige.' }),
  ]

  it('mène à la fiche que le passage nomme, et pas à l’autre', () => {
    const rows = parseIdentityGaps(
      'silhouette | chopper | revealed_identity | b1 | son véritable nom est Tony Tony Chopper | Le renne se nomme.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    const found = identityGapFinding({
      row: rows[0]!,
      candidates,
      passages,
      joined: new Set(),
    })

    expect(found?.finding.kind).toBe('identite_manquante')
    expect(found?.finding.subjectEntityId).toBe('silhouette')
    expect(found?.finding.objectEntityId).toBe('chopper')
    expect(found?.finding.fix).toMatchObject({
      action: 'proposer_identite',
      subjectEntityId: 'silhouette',
      objectEntityId: 'chopper',
      chapter: 140,
      ref: 'b1',
    })
  })

  it('ne publie jamais : le geste dépose une carte de revue', () => {
    const rows = parseIdentityGaps(
      'silhouette | chopper | revealed_identity | b1 | son véritable nom est Tony Tony Chopper | Le renne se nomme.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    const found = identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() })

    expect(found?.finding.fix?.action).toBe('proposer_identite')
    expect(found?.finding.detail).toContain('centre de revue')
  })

  it('se tait quand le graphe relie déjà les deux fiches', () => {
    const rows = parseIdentityGaps(
      'silhouette | chopper | revealed_identity | b1 | son véritable nom est Tony Tony Chopper | Le renne se nomme.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    expect(
      identityGapFinding({
        row: rows[0]!,
        candidates,
        passages,
        joined: new Set(['chopper|silhouette']),
      }),
    ).toBeNull()
  })
})

describe('un nom que quelqu’un se donne', () => {
  const candidates = [
    candidate({ entityId: 'prince', label: 'Mr Prince', firstSeenChapter: 179, revealedInChapter: 179 }),
    candidate({ entityId: 'sanji', label: 'Sanji', firstSeenChapter: 43, revealedInChapter: 43 }),
    candidate({
      entityId: 'chopper',
      label: 'Tony Tony Chopper',
      firstSeenChapter: 140,
      revealedInChapter: 140,
    }),
  ]

  const passages = [
    passage({
      id: 'b7',
      chapter: 179,
      text: 'Le cuisinier décroche l’escargophone : « Ici Mr Prince », dit Sanji en souriant.',
    }),
  ]

  it('mène au personnage que le passage nomme', () => {
    const rows = parseIdentityGaps(
      'prince | sanji | alias | b7 | « Ici Mr Prince », dit Sanji | Le cuisinier se donne ce nom.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    const found = identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() })

    expect(found?.finding.objectEntityId).toBe('sanji')
    expect(found?.finding.chapter).toBe(179)
  })

  it('refuse un déguisement, qui n’est pas une révélation', () => {
    const rows = parseIdentityGaps(
      'prince | chopper | disguise_or_impersonation | b7 | « Ici Mr Prince », dit Sanji | Un autre porte le nom.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    expect(rows).toHaveLength(1)
    expect(
      identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() }),
    ).toBeNull()
  })
})

describe('la date d’une révélation', () => {
  const candidates = [
    candidate({
      entityId: 'sunday',
      label: 'Miss All Sunday',
      firstSeenChapter: 114,
      revealedInChapter: 114,
    }),
    candidate({
      entityId: 'robin',
      label: 'Nico Robin',
      firstSeenChapter: 176,
      revealedInChapter: 176,
    }),
  ]

  const passages = [
    passage({
      id: 'b3',
      chapter: 176,
      text: 'Crocodile l’appelle par son vrai nom : Nico Robin.',
    }),
    passage({ id: 'b4', chapter: 114, text: 'Miss All Sunday sourit sans rien dire.' }),
  ]

  it('vient du passage cité, jamais du modèle', () => {
    const rows = parseIdentityGaps(
      'sunday | robin | revealed_identity | b3 | l’appelle par son vrai nom : Nico Robin | Le vrai nom est dit.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    const found = identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() })

    expect(found?.chapter).toBe(176)
    expect(found?.finding.chapter).toBe(176)
  })

  it('ne peut pas précéder l’un de ses deux bouts', () => {
    // Le passage est du 114 ; la fiche « Nico Robin » n'est lisible qu'au 176.
    // Dater du 114 rapprocherait pour le lecteur deux choses dont il n'en
    // connaît qu'une, et afficherait un nom que son chapitre n'a pas écrit.
    const rows = parseIdentityGaps(
      'sunday | robin | revealed_identity | b4 | Miss All Sunday sourit sans rien dire | Rien.',
      candidates.map((one) => one.entityId),
      passages.map((one) => one.id),
    )

    const found = identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() })

    expect(found?.chapter).toBe(176)
  })
})

describe('ce qu’une réponse n’a pas le droit de contenir', () => {
  const candidates = [
    candidate({ entityId: 'x', label: 'Alpha' }),
    candidate({ entityId: 'y', label: 'Beta' }),
  ]
  const passages = [passage({ id: 'b1', text: 'Alpha est en réalité Beta.' })]

  it('refuse une fiche que le modèle a formée', () => {
    expect(
      parseIdentityGaps(
        'x | inventee | revealed_identity | b1 | Alpha est en réalité Beta | raison',
        ['x', 'y'],
        ['b1'],
      ),
    ).toEqual([])
  })

  it('refuse un passage que le modèle n’a pas reçu', () => {
    expect(
      parseIdentityGaps(
        'x | y | revealed_identity | b99 | Alpha est en réalité Beta | raison',
        ['x', 'y'],
        ['b1'],
      ),
    ).toEqual([])
  })

  it('refuse une fiche rapprochée d’elle-même', () => {
    expect(
      parseIdentityGaps(
        'x | x | revealed_identity | b1 | Alpha est en réalité Beta | raison',
        ['x', 'y'],
        ['b1'],
      ),
    ).toEqual([])
  })

  it('refuse une citation qui n’est pas dans le passage cité', () => {
    const rows = parseIdentityGaps(
      'x | y | revealed_identity | b1 | Beta est en réalité Gamma | raison',
      ['x', 'y'],
      ['b1'],
    )

    expect(rows).toHaveLength(1)
    expect(
      identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() }),
    ).toBeNull()
  })

  it('ne rapproche pas deux fois la même paire', () => {
    const rows = parseIdentityGaps(
      'x | y | revealed_identity | b1 | Alpha est en réalité Beta | premier\n' +
        'y | x | alias | b1 | Alpha est en réalité Beta | second',
      ['x', 'y'],
      ['b1'],
    )

    expect(rows).toHaveLength(1)
  })

  it('ne produit rien sur insufficient_data', () => {
    const rows = parseIdentityGaps(
      'x | y | insufficient_data | b1 | Alpha est en réalité Beta | rien de sûr',
      ['x', 'y'],
      ['b1'],
    )

    expect(
      identityGapFinding({ row: rows[0]!, candidates, passages, joined: new Set() }),
    ).toBeNull()
  })
})

describe('la consigne', () => {
  it('interdit d’indiquer un chapitre et nomme ce qu’il faut écarter', () => {
    const question = gapQuestion(176)

    expect(question).toContain("N'indiquez aucun numéro de chapitre")
    expect(question).toContain('disguise_or_impersonation')
    expect(question).toContain('decoy')
    expect(question).toContain('véritable nom')
  })
})

describe('ce qui décide de relire un chapitre', () => {
  const passages = [passage({ id: 'b1', text: 'Alpha est en réalité Beta.' })]
  const candidates = [candidate({ entityId: 'x', label: 'Alpha' })]

  it('ne change pas quand rien n’a changé', () => {
    expect(gapInputs(passages, candidates)).toEqual(gapInputs(passages, candidates))
  })

  it('ne dépend pas de l’ordre dans lequel les fiches arrivent', () => {
    const other = candidate({ entityId: 'y', label: 'Beta' })

    expect(gapInputs(passages, [candidates[0]!, other])).toEqual(
      gapInputs(passages, [other, candidates[0]!]),
    )
  })

  it('change quand le texte du chapitre change', () => {
    expect(
      gapInputs([passage({ id: 'b1', text: 'Alpha est en réalité Gamma.' })], candidates),
    ).not.toEqual(gapInputs(passages, candidates))
  })
})
