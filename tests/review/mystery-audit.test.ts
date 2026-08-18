import { describe, expect, it } from 'vitest'
import {
  auditStorySnapshot,
  type AuditSnapshot,
} from '@/domains/review/audit.ts'
import {
  mysteryFindings,
  mysteryInputs,
  resolutionQuestion,
  soundResolutions,
  type MysteryUnderReview,
} from '@/domains/review/mystery-audit.ts'
import { resolvingScene, type Scene } from '@/domains/review/mystery-sweep.ts'

/**
 * La date d'une réponse, comparée à la première scène qui répond vraiment.
 *
 * Deux questions du Mode histoire de la bibliothèque de référence, et deux
 * défauts différents :
 *
 *   « Qui est réellement Mr 0 ? », ouverte au chapitre 111, est refermée au
 *   197 alors que le 113 y répond. Le lecteur a su au 113 ; le fil lui fait la
 *   révélation quatre-vingt-quatre chapitres plus tard.
 *
 *   « Qui est la voix que Vivi a entendue ? » est laissée ouverte alors que la
 *   scène du 197 y répond, et le graphe porte à la place une identité entre la
 *   question et la personne — ce qui efface la question au lieu d'y répondre.
 *
 * Le modèle ne choisit jamais le numéro de chapitre : il cite une scène qu'on
 * lui a donnée, et `resolvingScene` lit la date de cette scène dans le graphe.
 */

const EMPTY: AuditSnapshot = {
  entities: [],
  identities: [],
  memberships: [],
  events: [],
  firstWritten: new Map(),
  mysteries: [],
  resolutions: [],
  provenance: [],
}

function mystery(
  input: Partial<MysteryUnderReview> & { entityId: string; question: string },
): MysteryUnderReview {
  return {
    openedInChapter: 1,
    state: 'open',
    resolvedInChapter: null,
    resolutions: [],
    ...input,
  }
}

function scene(entityId: string, chapter: number, summary: string): Scene {
  return { entityId, chapter, summary }
}

describe('une question refermée trop tard', () => {
  const mrZero = mystery({
    entityId: 'm-mr0',
    question: 'Qui est réellement Mr 0 ?',
    openedInChapter: 111,
    state: 'resolved',
    resolvedInChapter: 197,
    resolutions: [{ assertionId: 'a-197', sceneEntityId: 's-197', chapter: 197 }],
  })

  const scenes = [
    scene('s-113', 113, 'Igaram révèle que Mr 0 est Crocodile, l’un des Sept Grands Corsaires.'),
    scene('s-197', 197, 'Crocodile se dresse enfin devant l’équipage, sous son propre nom.'),
  ]

  it('est datée du 113, que la lecture désigne, et non du 197 qu’elle affiche', () => {
    const resolution = resolvingScene(
      { insufficientData: false, citations: [{ assertionId: 's-113', chapter: 0 }] },
      scenes,
      mrZero.openedInChapter,
    )

    expect(resolution).toEqual({ sceneId: 's-113', chapter: 113 })

    const [finding, ...rest] = mysteryFindings({
      mystery: mrZero,
      answering: scenes.find((one) => one.entityId === resolution!.sceneId)!,
    })

    expect(rest).toHaveLength(0)
    expect(finding?.kind).toBe('mystere_resolu_trop_tard')
    expect(finding?.chapter).toBe(113)
    expect(finding?.fix).toEqual({
      action: 'publier_resolution',
      mysteryEntityId: 'm-mr0',
      sceneEntityId: 's-113',
      chapter: 113,
    })
  })

  it('ignore le chapitre que le modèle annonce, et lit celui de la scène', () => {
    // Le modèle prétend que la scène est du chapitre 500. Le graphe dit 113,
    // et c'est le graphe qui date : une résolution datée par le modèle serait
    // une révélation posée à la mauvaise frontière.
    const resolution = resolvingScene(
      { insufficientData: false, citations: [{ assertionId: 's-113', chapter: 500 }] },
      scenes,
      mrZero.openedInChapter,
    )

    expect(resolution?.chapter).toBe(113)
  })

  it('se tait quand la lecture ne désigne qu’un rappel postérieur', () => {
    const findings = mysteryFindings({
      mystery: mrZero,
      answering: scene('s-210', 210, 'On reparle de Crocodile.'),
    })

    expect(findings).toEqual([])
  })
})

describe('une question laissée ouverte alors que la réponse existe', () => {
  const voix = mystery({
    entityId: 'm-voix',
    question: 'Qui est la voix que Vivi a entendue ?',
    openedInChapter: 190,
  })

  it('propose d’écrire la relation, puis de recalculer l’état', () => {
    const [finding] = mysteryFindings({
      mystery: voix,
      answering: scene('s-197', 197, 'Vivi reconnaît la voix : c’est celle de Koza.'),
    })

    expect(finding?.kind).toBe('mystere_sans_resolution_ecrite')
    expect(finding?.chapter).toBe(197)
    expect(finding?.fix).toEqual({
      action: 'publier_resolution',
      mysteryEntityId: 'm-voix',
      sceneEntityId: 's-197',
      chapter: 197,
    })
  })

  it('n’écrit rien quand la lecture n’a rien désigné', () => {
    expect(mysteryFindings({ mystery: voix, answering: null })).toEqual([])
  })

  it('n’écrit rien sur une scène antérieure à l’ouverture de la question', () => {
    expect(
      mysteryFindings({
        mystery: voix,
        answering: scene('s-190', 190, 'Vivi entend une voix qu’elle croit connaître.'),
      }),
    ).toEqual([])
  })

  /*
   * Le défaut voisin, et il est gratuit : au lieu de « résout le mystère », le
   * graphe porte une identité entre la question et la personne. Fusionnées, la
   * question disparaît du fil, ce qui est pire que de la laisser ouverte.
   */
  it('signale l’identité écrite à la place, sans lire un chapitre', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      entities: [
        {
          id: 'm-voix',
          nodeType: 'mystery',
          firstSeenChapter: 190,
          labels: [
            {
              id: 'l-voix',
              label: 'Qui est la voix que Vivi a entendue ?',
              normalized: 'qui est la voix',
              kind: 'alias',
              revealedInChapter: 190,
              precedence: 50,
            },
          ],
        },
        {
          id: 'koza',
          nodeType: 'character',
          firstSeenChapter: 190,
          labels: [
            {
              id: 'l-koza',
              label: 'Koza',
              normalized: 'koza',
              kind: 'true_name',
              revealedInChapter: 190,
              precedence: 100,
            },
          ],
        },
      ],
      identities: [
        {
          assertionId: 'a-fusion',
          subjectEntityId: 'm-voix',
          objectEntityId: 'koza',
          knowledgeFromChapter: 197,
        },
      ],
    }).filter((finding) => finding.kind === 'identite_avec_un_mystere')

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'retirer_identite', assertionId: 'a-fusion' })
  })
})

describe('une réponse rattachée à la mauvaise scène', () => {
  it('le dit sans proposer de correction : deux scènes d’un chapitre peuvent répondre', () => {
    const question = mystery({
      entityId: 'm-1',
      question: 'Qui a prévenu l’ennemi ?',
      openedInChapter: 100,
      state: 'resolved',
      resolvedInChapter: 110,
      resolutions: [{ assertionId: 'a-1', sceneEntityId: 's-autre', chapter: 110 }],
    })

    const [finding] = mysteryFindings({
      mystery: question,
      answering: scene('s-vraie', 110, 'Le traître avoue devant tout le monde.'),
    })

    expect(finding?.kind).toBe('mystere_mauvaise_scene')
    expect(finding?.fix).toBeNull()
  })

  it('se tait quand la scène désignée est celle qui est écrite', () => {
    const question = mystery({
      entityId: 'm-1',
      question: 'Qui a prévenu l’ennemi ?',
      openedInChapter: 100,
      state: 'resolved',
      resolvedInChapter: 110,
      resolutions: [{ assertionId: 'a-1', sceneEntityId: 's-vraie', chapter: 110 }],
    })

    expect(
      mysteryFindings({
        mystery: question,
        answering: scene('s-vraie', 110, 'Le traître avoue devant tout le monde.'),
      }),
    ).toEqual([])
  })
})

describe('une question qui se répond elle-même', () => {
  const snapshot = (resolutions: AuditSnapshot['resolutions']): AuditSnapshot => ({
    ...EMPTY,
    mysteries: [
      {
        entityId: 'm-1',
        question: 'Où est le trésor ?',
        openedInChapter: 50,
        state: 'resolved',
        resolvedInChapter: 50,
      },
    ],
    resolutions,
  })

  it('refuse une relation d’une question vers elle-même', () => {
    const found = auditStorySnapshot(
      snapshot([
        { assertionId: 'a-soi', sceneEntityId: 'm-1', mysteryEntityId: 'm-1', chapter: 50 },
      ]),
    ).filter((finding) => finding.kind === 'mystere_qui_se_repond')

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({
      action: 'retirer_resolution',
      assertionId: 'a-soi',
      mysteryEntityId: 'm-1',
    })
  })

  it('refuse une réponse du chapitre qui a posé la question', () => {
    const found = auditStorySnapshot(
      snapshot([
        { assertionId: 'a-meme', sceneEntityId: 's-50', mysteryEntityId: 'm-1', chapter: 50 },
      ]),
    ).filter((finding) => finding.kind === 'mystere_qui_se_repond')

    expect(found).toHaveLength(1)
    expect(found[0]?.detail).toContain('posée')
  })

  it('les écarte du calcul de la date', () => {
    const question = mystery({
      entityId: 'm-1',
      question: 'Où est le trésor ?',
      openedInChapter: 50,
      resolutions: [
        { assertionId: 'a-soi', sceneEntityId: 'm-1', chapter: 50 },
        { assertionId: 'a-vraie', sceneEntityId: 's-80', chapter: 80 },
      ],
    })

    expect(soundResolutions(question).map((row) => row.assertionId)).toEqual(['a-vraie'])
  })
})

describe('une date qui ne suit pas les relations acceptées', () => {
  it('propose de la recalculer quand la première réponse est plus ancienne', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      mysteries: [
        {
          entityId: 'm-1',
          question: 'Qui est réellement Mr 0 ?',
          openedInChapter: 111,
          state: 'resolved',
          resolvedInChapter: 197,
        },
      ],
      resolutions: [
        { assertionId: 'a-113', sceneEntityId: 's-113', mysteryEntityId: 'm-1', chapter: 113 },
        { assertionId: 'a-197', sceneEntityId: 's-197', mysteryEntityId: 'm-1', chapter: 197 },
      ],
    }).filter((finding) => finding.kind === 'mystere_date_incoherente')

    expect(found).toHaveLength(1)
    expect(found[0]?.fix).toEqual({ action: 'recalculer_mystere', mysteryEntityId: 'm-1' })
    expect(found[0]?.chapter).toBe(113)
  })

  it('propose de la recalculer quand rien n’étaye la fermeture', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      mysteries: [
        {
          entityId: 'm-1',
          question: 'Où est le trésor ?',
          openedInChapter: 1,
          state: 'resolved',
          resolvedInChapter: 40,
        },
      ],
    }).filter((finding) => finding.kind === 'mystere_date_incoherente')

    expect(found).toHaveLength(1)
    expect(found[0]?.detail).toContain('Aucune relation acceptée')
  })

  it('se tait quand la date affichée est celle de la première réponse', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      mysteries: [
        {
          entityId: 'm-1',
          question: 'Où est le trésor ?',
          openedInChapter: 1,
          state: 'resolved',
          resolvedInChapter: 40,
        },
      ],
      resolutions: [
        { assertionId: 'a-40', sceneEntityId: 's-40', mysteryEntityId: 'm-1', chapter: 40 },
      ],
    }).filter((finding) => finding.kind === 'mystere_date_incoherente')

    expect(found).toEqual([])
  })

  it('se tait sur une question ouverte que rien ne referme', () => {
    const found = auditStorySnapshot({
      ...EMPTY,
      mysteries: [
        {
          entityId: 'm-1',
          question: 'Où est le trésor ?',
          openedInChapter: 1,
          state: 'open',
          resolvedInChapter: null,
        },
      ],
    })

    expect(found).toEqual([])
  })
})

describe('la consigne posée avec la question', () => {
  it('reprend la question telle quelle et interdit de dater', () => {
    const question = resolutionQuestion('Où est le trésor de Gold Roger ?', 1)

    expect(question).toContain('Où est le trésor de Gold Roger ?')
    expect(question).toContain("N'indiquez aucun numéro de chapitre")
    expect(question).toContain('insufficient_data')
  })
})

describe('ce qui décide de relire une question', () => {
  const question = mystery({ entityId: 'm-1', question: 'Où ?', openedInChapter: 10 })
  const scenes = [scene('s-1', 11, 'Une scène.')]

  it('ne change pas quand rien n’a changé', () => {
    expect(mysteryInputs(question, scenes)).toEqual(mysteryInputs(question, scenes))
  })

  it('change quand une scène est publiée après', () => {
    expect(mysteryInputs(question, [...scenes, scene('s-2', 12, 'Une autre.')])).not.toEqual(
      mysteryInputs(question, scenes),
    )
  })

  it('change quand une réponse est acceptée entre-temps', () => {
    const closed = {
      ...question,
      resolutions: [{ assertionId: 'a-1', sceneEntityId: 's-1', chapter: 11 }],
    }

    expect(mysteryInputs(closed, scenes)).not.toEqual(mysteryInputs(question, scenes))
  })
})
