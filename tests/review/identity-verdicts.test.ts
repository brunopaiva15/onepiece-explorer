import { describe, expect, it } from 'vitest'
import {
  identityQuestion,
  identityVerdictFinding,
  identityInputs,
  identitiesWorthReading,
  parseIdentityVerdicts,
  passagesAround,
  type IdentitySide,
  type IdentityUnderReview,
} from '@/domains/review/identity-review.ts'

/**
 * Ce qu'une lecture des identités a le droit d'écrire.
 *
 * Les cinq couples ci-dessous sont des **données**, relevées dans le Mode
 * histoire de la bibliothèque de référence. Rien de ce que la règle sait ne les
 * nomme : elle lit un verdict, exige une phrase qui l'ancre, et refuse tout le
 * reste. La même fonction, sur une autre œuvre, jugera ses propres duos
 * confondus avec leur moitié.
 */

function side(input: Partial<IdentitySide> & { entityId: string; name: string }): IdentitySide {
  return {
    nodeType: 'character',
    firstSeenChapter: 1,
    names: [{ label: input.name, revealedInChapter: 1 }],
    memberships: [],
    ...input,
  }
}

function underReview(input: {
  assertionId: string
  chapter: number
  subject: IdentitySide
  object: IdentitySide
}): IdentityUnderReview {
  return { ...input, excerpt: null }
}

describe('un groupe et l’un de ses membres', () => {
  const identity = underReview({
    assertionId: 'a-nyaban',
    chapter: 31,
    subject: side({
      entityId: 'nyaban',
      name: 'Nyaban Brothers',
      nodeType: 'group',
      firstSeenChapter: 31,
    }),
    object: side({ entityId: 'sham', name: 'Sham', firstSeenChapter: 31 }),
  })

  const passages = [
    'Les Nyaban Brothers sont deux : Sham, le maigre, et Buchi, le gros.',
    'Sham bondit le premier, laissant Buchi derrière lui.',
  ]

  it('devient un constat, avec le retrait de la relation', () => {
    const [row] = parseIdentityVerdicts(
      'a-nyaban | group_member | Les Nyaban Brothers sont deux : Sham, le maigre, et Buchi, le gros. | Le duo compte deux membres.',
      ['a-nyaban'],
    )

    const finding = identityVerdictFinding({ row: row!, identity, passages })

    expect(finding?.kind).toBe('identite_douteuse')
    expect(finding?.title).toContain('un groupe et un membre')
    expect(finding?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-nyaban' })
    expect(finding?.chapter).toBe(31)
  })

  it('n’écrit rien quand la phrase citée n’est pas dans les passages', () => {
    const [row] = parseIdentityVerdicts(
      'a-nyaban | group_member | Sham est le seul membre du duo. | inventé',
      ['a-nyaban'],
    )

    expect(identityVerdictFinding({ row: row!, identity, passages })).toBeNull()
  })
})

describe('une fusion et l’un de ses composants', () => {
  it('n’est pas une identité', () => {
    const identity = underReview({
      assertionId: 'a-chess',
      chapter: 143,
      subject: side({ entityId: 'chess', name: 'Chess', firstSeenChapter: 134 }),
      object: side({ entityId: 'chessmarimo', name: 'Chessmarimo', firstSeenChapter: 143 }),
    })

    const passages = [
      'Wapol avale Chess et Kuromarimo, et les recrache soudés en un seul corps : Chessmarimo.',
    ]

    const [row] = parseIdentityVerdicts(
      'a-chess | fusion_or_composition | les recrache soudés en un seul corps | Chess n’est qu’une moitié.',
      ['a-chess'],
    )

    const finding = identityVerdictFinding({ row: row!, identity, passages })

    expect(finding?.title).toContain('une partie et son tout')
    expect(finding?.detail).toContain('efface l’autre moitié')
    expect(finding?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-chess' })
  })
})

describe('un nom que quelqu’un d’autre porte un moment', () => {
  it('est un leurre, pas une révélation', () => {
    const identity = underReview({
      assertionId: 'a-prince',
      chapter: 179,
      subject: side({ entityId: 'prince', name: 'Mr Prince', firstSeenChapter: 179 }),
      object: side({ entityId: 'chopper', name: 'Tony Tony Chopper', firstSeenChapter: 138 }),
    })

    const passages = [
      'Une voix annonce l’arrivée de Mr Prince ; ce n’est pas le renne, resté en arrière avec les blessés.',
    ]

    const [row] = parseIdentityVerdicts(
      'a-prince | decoy | ce n’est pas le renne, resté en arrière avec les blessés | Le nom est tenu par un autre.',
      ['a-prince'],
    )

    const finding = identityVerdictFinding({ row: row!, identity, passages })

    expect(finding?.title).toContain('un leurre')
    expect(finding?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-prince' })
  })
})

describe('une question et ce qui y répond', () => {
  it('appelle « résout le mystère », jamais une identité', () => {
    const identity = underReview({
      assertionId: 'a-voix',
      chapter: 197,
      subject: side({
        entityId: 'voix',
        name: 'Qui est la voix que Vivi a entendue ?',
        nodeType: 'mystery',
        firstSeenChapter: 190,
      }),
      object: side({ entityId: 'koza', name: 'Koza', firstSeenChapter: 190 }),
    })

    const passages = ['Vivi reconnaît enfin la voix qu’elle avait entendue : c’est celle de Koza.']

    const [row] = parseIdentityVerdicts(
      'a-voix | question_answer | Vivi reconnaît enfin la voix qu’elle avait entendue | La question reçoit sa réponse.',
      ['a-voix'],
    )

    const finding = identityVerdictFinding({ row: row!, identity, passages })

    expect(finding?.title).toContain('une question et sa réponse')
    expect(finding?.detail).toContain('résout le mystère')
  })
})

/**
 * Le couple que la lecture refuse de trancher, et pourquoi c'est le bon
 * comportement.
 *
 * « Humanoïde velu mystérieux » et Wapol : le graphe les a rapprochés, et
 * l'humanoïde est quelqu'un d'autre. Aucun des verdicts ne dit « ce sont deux
 * personnes différentes » — les six autres nomment une relation *réelle* entre
 * les deux nœuds, et il n'y en a aucune ici. Ce que le modèle doit répondre est
 * donc `insufficient_data`, et ce que la règle doit faire est **rien** : un
 * retrait décidé sur l'absence de preuve serait exactement le geste que cette
 * page ne peut pas se permettre.
 *
 * Le couple juste ne vient pas d'ici mais de la recherche d'identités
 * manquantes, qui lit le passage où le renne se nomme et propose la carte
 * correspondante. Voir `identity-gaps.test.ts`.
 */
describe('une identité que rien n’étaye', () => {
  it('ne produit aucun constat sur insufficient_data', () => {
    const identity = underReview({
      assertionId: 'a-wapol',
      chapter: 138,
      subject: side({
        entityId: 'humanoide',
        name: 'Humanoïde velu mystérieux',
        firstSeenChapter: 138,
      }),
      object: side({ entityId: 'wapol', name: 'Wapol', firstSeenChapter: 134 }),
    })

    const passages = [
      'Une créature velue marchant sur deux pattes s’enfuit dans la neige.',
      'Wapol, chassé de son château, erre sur la côte avec ses deux hommes.',
    ]

    const [row] = parseIdentityVerdicts(
      'a-wapol | insufficient_data | Une créature velue marchant sur deux pattes s’enfuit dans la neige. | Rien ne les relie.',
      ['a-wapol'],
    )

    expect(identityVerdictFinding({ row: row!, identity, passages })).toBeNull()
  })

  it('ne produit rien non plus quand la lecture confirme l’identité', () => {
    const identity = underReview({
      assertionId: 'a-juste',
      chapter: 116,
      subject: side({ entityId: 'geant', name: 'Silhouette géante', firstSeenChapter: 115 }),
      object: side({ entityId: 'brogy', name: 'Brogy', firstSeenChapter: 116 }),
    })

    const [row] = parseIdentityVerdicts(
      'a-juste | valid_identity | Le géant se présente : Brogy. | C’est bien lui.',
      ['a-juste'],
    )

    expect(
      identityVerdictFinding({
        row: row!,
        identity,
        passages: ['Le géant se présente : Brogy.'],
      }),
    ).toBeNull()
  })
})

describe('la réponse du modèle, ligne par ligne', () => {
  it('refuse une assertion qu’il a formée plutôt que recopiée', () => {
    const rows = parseIdentityVerdicts(
      'a-inventee | group_member | phrase | raison\na-vraie | decoy | phrase | raison',
      ['a-vraie'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.assertionId).toBe('a-vraie')
  })

  it('refuse un mot qui n’est pas un verdict', () => {
    expect(parseIdentityVerdicts('a-1 | peut-être | phrase | raison', ['a-1'])).toEqual([])
  })

  it('ne juge pas deux fois la même identité', () => {
    const rows = parseIdentityVerdicts(
      'a-1 | decoy | phrase | premier\na-1 | valid_identity | phrase | second',
      ['a-1'],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('decoy')
  })

  it('ignore une réponse en prose, qui n’est pas le format demandé', () => {
    expect(parseIdentityVerdicts('insufficient_data', ['a-1'])).toEqual([])
  })
})

describe('la consigne', () => {
  it('nomme les six façons dont deux nœuds proches ne sont pas la même chose', () => {
    const question = identityQuestion(
      underReview({
        assertionId: 'a-1',
        chapter: 31,
        subject: side({ entityId: 'x', name: 'Alpha' }),
        object: side({ entityId: 'y', name: 'Beta' }),
      }),
    )

    for (const verdict of [
      'valid_identity',
      'group_member',
      'fusion_or_composition',
      'disguise_or_impersonation',
      'decoy',
      'question_answer',
      'insufficient_data',
    ]) {
      expect(question).toContain(verdict)
    }

    // Aucun numéro de chapitre demandé : le graphe date, le modèle lit.
    expect(question).not.toContain('numéro du chapitre')
    expect(question).toContain('réellement la même')
  })
})

describe('ce qui décide de relire une identité', () => {
  const identity = underReview({
    assertionId: 'a-1',
    chapter: 31,
    subject: side({ entityId: 'x', name: 'Alpha' }),
    object: side({ entityId: 'y', name: 'Beta' }),
  })

  it('ne change pas quand rien n’a changé', () => {
    expect(identityInputs(identity, ['un passage'])).toEqual(
      identityInputs(identity, ['un passage']),
    )
  })

  it('change quand une fiche est renommée', () => {
    const renamed = {
      ...identity,
      object: side({ entityId: 'y', name: 'Bêta le Rouge' }),
    }

    expect(identityInputs(renamed, ['un passage'])).not.toEqual(
      identityInputs(identity, ['un passage']),
    )
  })

  it('change quand un passage est publié à côté', () => {
    expect(identityInputs(identity, ['un passage', 'un autre'])).not.toEqual(
      identityInputs(identity, ['un passage']),
    )
  })

  it('laisse de côté celles qu’une règle gratuite a déjà tranchées', () => {
    const worth = identitiesWorthReading([identity], new Set(['a-1']))
    expect(worth).toEqual([])
  })

  it('ne pèse une identité que contre les passages qui l’entourent', () => {
    const passages = [
      { chapter: 20, text: 'loin avant' },
      { chapter: 30, text: 'juste avant' },
      { chapter: 31, text: 'le chapitre' },
      { chapter: 33, text: 'juste après' },
      { chapter: 90, text: 'loin après' },
    ]

    expect(passagesAround(passages, 31).map((passage) => passage.chapter)).toEqual([30, 31, 33])
  })
})
