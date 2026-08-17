import { describe, expect, it } from 'vitest'
import {
  revealedIdentity,
  windowFor,
  type NamedOption,
  type SweptPassage,
  type UnnamedFigure,
} from '@/domains/review/identity-sweep.ts'

/**
 * Ce que le balayage d'identités croit, et ce qu'il refuse de croire.
 *
 * Aucune base, aucun modèle, aucun appel payant : la règle est ici précisément
 * pour qu'elle s'exerce. C'est la leçon du balayage des mystères, dont ce module
 * est le frère — une règle qu'on ne peut vérifier qu'au prix d'un appel réel est
 * une règle que personne ne vérifie, et celle-ci décide d'écrire une identité,
 * ce que l'ontologie place en revue humaine obligatoire.
 */

const FIGURE: UnnamedFigure = {
  entityId: 'fig-1',
  label: 'Homme mystérieux debout sur l’eau',
  firstSeenChapter: 131,
}

const WAPOL: NamedOption = {
  entityId: 'wapol',
  label: 'Wapol',
  revealedInChapter: 131,
}

/*
 * Deux passages dont les références de bloc se répètent d'un chapitre à l'autre,
 * exprès : `b2` existe dans les deux, et seul `id` les distingue. C'est le
 * défaut que ce jeu de données épingle — sans identifiant unique, une citation
 * du 134 se daterait du 131.
 */
const PASSAGES: SweptPassage[] = [
  {
    id: '131:b2',
    ref: 'b2',
    chapter: 131,
    text: 'Le navire surgit des flots et son capitaine, Wapol, dévore le Vogue Merry.',
  },
  {
    id: '134:b2',
    ref: 'b2',
    chapter: 134,
    text: 'Dalton explique que Wapol était le roi du pays mais qu’il a fui.',
  },
]

describe('l’identité qu’une réponse établit', () => {
  it('demande les deux moitiés : le nom cité et la phrase qui le dit', () => {
    const found = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: 'wapol', excerpt: '' },
          { id: '131:b2', excerpt: 'son capitaine, Wapol' },
        ],
      },
      FIGURE,
      [WAPOL],
      PASSAGES,
    )

    expect(found).toEqual({
      namedEntityId: 'wapol',
      chapter: 131,
      ref: 'b2',
      excerpt: 'son capitaine, Wapol',
    })
  })

  it('ne croit pas un nom sans phrase', () => {
    // Nommer sans citer, c'est un souvenir du modèle — la seule chose que tout
    // ce système existe pour refuser.
    expect(
      revealedIdentity(
        { insufficientData: false, citations: [{ id: 'wapol', excerpt: '' }] },
        FIGURE,
        [WAPOL],
        PASSAGES,
      ),
    ).toBeNull()
  })

  it('ne croit pas une phrase sans nom', () => {
    expect(
      revealedIdentity(
        {
          insufficientData: false,
          citations: [{ id: '131:b2', excerpt: 'son capitaine, Wapol' }],
        },
        FIGURE,
        [WAPOL],
        PASSAGES,
      ),
    ).toBeNull()
  })

  it('refuse un identifiant que le modèle a formé', () => {
    // Un modèle à qui l'on tend quarante passages en cite parfois un
    // quarante-et-unième, au bon format.
    expect(
      revealedIdentity(
        {
          insufficientData: false,
          citations: [
            { id: 'kureha', excerpt: '' },
            { id: '131:b2', excerpt: 'son capitaine, Wapol' },
          ],
        },
        FIGURE,
        [WAPOL],
        PASSAGES,
      ),
    ).toBeNull()
  })

  it('refuse un extrait qui n’est pas mot pour mot dans le passage', () => {
    // La carte de revue portera cette citation et la base la revérifiera au
    // moment de publier : mieux vaut ne pas écrire la carte.
    expect(
      revealedIdentity(
        {
          insufficientData: false,
          citations: [
            { id: 'wapol', excerpt: '' },
            { id: '131:b2', excerpt: 'le capitaine s’appelle Wapol' },
          ],
        },
        FIGURE,
        [WAPOL],
        PASSAGES,
      ),
    ).toBeNull()
  })

  it('refuse la figure citée comme étant elle-même', () => {
    expect(
      revealedIdentity(
        {
          insufficientData: false,
          citations: [
            { id: 'fig-1', excerpt: '' },
            { id: '131:b2', excerpt: 'son capitaine, Wapol' },
          ],
        },
        FIGURE,
        [{ ...WAPOL, entityId: 'fig-1' }],
        PASSAGES,
      ),
    ).toBeNull()
  })

  it('se tait quand le modèle dit qu’il ne sait pas', () => {
    expect(
      revealedIdentity(
        {
          insufficientData: true,
          citations: [
            { id: 'wapol', excerpt: '' },
            { id: '131:b2', excerpt: 'son capitaine, Wapol' },
          ],
        },
        FIGURE,
        [WAPOL],
        PASSAGES,
      ),
    ).toBeNull()
  })
})

describe('la date, qui ne vient jamais de la citation', () => {
  it('retient le plus tôt des passages cités', () => {
    // Le lecteur l'a appris la première fois qu'on le lui a dit ; un chapitre
    // ultérieur qui le redit n'est pas le moment où il a su.
    const found = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: 'wapol', excerpt: '' },
          { id: '134:b2', excerpt: 'Wapol était le roi du pays' },
          { id: '131:b2', excerpt: 'son capitaine, Wapol' },
        ],
      },
      FIGURE,
      [WAPOL],
      PASSAGES,
    )

    expect(found?.chapter).toBe(131)
    expect(found?.ref).toBe('b2')
  })

  it('ne descend jamais sous l’entrée en scène de la figure', () => {
    // Une identité datée avant l'un de ses bouts rapprocherait pour le lecteur
    // deux choses dont il n'en connaît qu'une.
    const found = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: 'wapol', excerpt: '' },
          { id: '131:b2', excerpt: 'son capitaine, Wapol' },
        ],
      },
      { ...FIGURE, firstSeenChapter: 140 },
      [WAPOL],
      PASSAGES,
    )

    expect(found?.chapter).toBe(140)
  })

  it('ne descend jamais sous la révélation du nom', () => {
    const found = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: 'wapol', excerpt: '' },
          { id: '131:b2', excerpt: 'son capitaine, Wapol' },
        ],
      },
      FIGURE,
      [{ ...WAPOL, revealedInChapter: 139 }],
      PASSAGES,
    )

    expect(found?.chapter).toBe(139)
  })
})

describe('la fenêtre', () => {
  it('ne lit qu’après la figure, et pas jusqu’à la fin de l’œuvre', () => {
    const passages: SweptPassage[] = [130, 131, 132, 145, 160].map((chapter) => ({
      id: `${chapter}:b1`,
      ref: 'b1',
      chapter,
      text: 'peu importe',
    }))

    const window = windowFor({ ...FIGURE, firstSeenChapter: 131 }, passages, 15)

    // 130 est avant la rencontre, 160 est hors fenêtre. Ce que ça coûte est
    // réel : une révélation à deux cents chapitres reste au geste manuel.
    expect(window.map((passage) => passage.chapter)).toEqual([132, 145])
  })
})
