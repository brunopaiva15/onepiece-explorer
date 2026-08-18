import { describe, expect, it } from 'vitest'
import { sameBeat } from '@/domains/knowledge/beats.ts'
import { auditStorySnapshot, type AuditEvent, type AuditSnapshot } from '@/domains/review/audit.ts'
import {
  parseTwinVerdicts,
  twinCandidates,
  twinFinding,
  twinInputs,
  twinQuestion,
} from '@/domains/review/scene-twins.ts'

/**
 * La bande entre « manifestement la même scène » et « manifestement pas ».
 *
 * `sameBeat` replie ce qu'il peut sans rien payer, et son seuil est posé là où
 * un repliement faux est impossible — parce qu'il *écrit* : ce qu'il replie,
 * personne ne le relit. Les deux paires ci-dessous, relevées aux chapitres 14
 * et 138 de la bibliothèque de référence, passent sous ce seuil et sont
 * pourtant une seule scène chacune. C'est exactement ce qu'une seconde lecture,
 * payée, a à apporter.
 *
 * Le seuil gratuit ne bouge pas d'un point pour les faire passer, et le premier
 * test de ce fichier est là pour le prouver : un seuil abaissé replierait sans
 * qu'on le lui demande, et une scène cachée ne se remarque pas.
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

function event(entityId: string, chapter: number, summary: string, createdAt = 1): AuditEvent {
  return { entityId, chapter, summary, createdAt }
}

const CHAPITRE_14 = [
  event('s-14-court', 14, 'Nami dérobe la carte de Grand Line dans le repaire de Baggy.', 1),
  event(
    's-14-long',
    14,
    'La voleuse quitte le repaire des pirates avec le plan de Grand Line qu’elle convoitait.',
    2,
  ),
]

const CHAPITRE_138 = [
  event('s-138-court', 138, 'Luffy escalade la falaise gelée en portant Nami sur son dos.', 1),
  event(
    's-138-long',
    138,
    'Portant Nami sur son dos, Luffy gravit la paroi glacée jusqu’au sommet du Drum.',
    2,
  ),
]

describe('le filtre gratuit reste ce qu’il est', () => {
  it('ne replie ni la paire du 14 ni celle du 138', () => {
    expect(sameBeat(CHAPITRE_14[0]!.summary, CHAPITRE_14[1]!.summary)).toBe(false)
    expect(sameBeat(CHAPITRE_138[0]!.summary, CHAPITRE_138[1]!.summary)).toBe(false)
  })

  it('replie toujours ce qu’il repliait, et rien de plus', () => {
    expect(
      sameBeat(
        'Luffy et Koby prennent la mer ensemble.',
        'Luffy et Koby prennent la mer ensemble, Koby parlant de Zoro à Luffy.',
      ),
    ).toBe(true)

    expect(
      sameBeat(
        'Zoro tranche Kuroobi dans le hall du restaurant.',
        'Zoro tranche Hachi dans le hall du restaurant.',
      ),
    ).toBe(false)
  })

  it('ne produit aucun constat gratuit sur ces deux paires', () => {
    const findings = auditStorySnapshot({ ...EMPTY, events: [...CHAPITRE_14, ...CHAPITRE_138] })
    expect(findings.filter((finding) => finding.kind === 'scene_dupliquee')).toEqual([])
  })
})

describe('les paires qui méritent d’être lues', () => {
  it('retient celles des chapitres 14 et 138', () => {
    const pairs = twinCandidates([...CHAPITRE_14, ...CHAPITRE_138])

    expect(pairs).toHaveLength(2)
    expect(pairs.map((pair) => pair.left.chapter).sort((a, b) => a - b)).toEqual([14, 138])
  })

  it('ne repropose pas une paire que le filtre gratuit replie déjà', () => {
    const pairs = twinCandidates([
      event('a', 2, 'Luffy et Koby prennent la mer ensemble.', 1),
      event('b', 2, 'Luffy et Koby prennent la mer ensemble, Koby parlant de Zoro.', 2),
    ])

    expect(pairs).toEqual([])
  })

  it('ne rapproche jamais deux chapitres : une scène redite au suivant est un souvenir', () => {
    const pairs = twinCandidates([
      event('a', 78, 'Arlong exécute Bell-mère devant ses filles.', 1),
      event('b', 79, 'Devant les deux sœurs, Bell-mère est abattue par le chef des hommes-poissons.', 2),
    ])

    expect(pairs).toEqual([])
  })

  it('laisse de côté deux phrases qui ne partagent presque rien', () => {
    const pairs = twinCandidates([
      event('a', 5, 'Zoro affronte le capitaine Morgan sur la place.', 1),
      event('b', 5, 'Nami dessine une carte dans sa cabine.', 2),
    ])

    expect(pairs).toEqual([])
  })
})

describe('ce qu’un doublon confirmé a le droit de proposer', () => {
  const pairs = twinCandidates(CHAPITRE_14)
  const passages = [
    'Nami s’enfuit du repaire de Baggy, la carte de Grand Line serrée contre elle.',
  ]

  it('garde la formulation la plus complète et rejette l’autre', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | same_scene | Nami s’enfuit du repaire de Baggy | Une seule fuite.',
      pairs,
    )

    const finding = twinFinding({ row: rows[0]!, pairs, passages })

    expect(finding?.kind).toBe('scene_redite')
    expect(finding?.chapter).toBe(14)
    expect(finding?.fix).toEqual({
      action: 'rejeter_entite',
      entityId: 's-14-court',
      because: expect.stringContaining('Doublon sémantique'),
    })
  })

  it('n’écrit rien quand la phrase citée n’est pas dans le chapitre', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | same_scene | Nami revend la carte à Baggy | inventé',
      pairs,
    )

    expect(twinFinding({ row: rows[0]!, pairs, passages })).toBeNull()
  })

  it('n’écrit rien sur deux étapes d’une même séquence', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | distinct_steps | Nami s’enfuit du repaire de Baggy | Deux moments.',
      pairs,
    )

    expect(twinFinding({ row: rows[0]!, pairs, passages })).toBeNull()
  })

  it('n’écrit rien sur un rappel', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | recall_or_flashback | Nami s’enfuit du repaire de Baggy | Un souvenir.',
      pairs,
    )

    expect(twinFinding({ row: rows[0]!, pairs, passages })).toBeNull()
  })

  it('n’écrit rien sur insufficient_data', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | insufficient_data | Nami s’enfuit du repaire de Baggy | Rien de sûr.',
      pairs,
    )

    expect(twinFinding({ row: rows[0]!, pairs, passages })).toBeNull()
  })

  it('garde la plus complète du 138, quel que soit l’ordre de la ligne', () => {
    const drum = twinCandidates(CHAPITRE_138)
    const rows = parseTwinVerdicts(
      's-138-long | s-138-court | same_scene | Luffy grimpe la falaise avec Nami sur le dos | La même montée.',
      drum,
    )

    const finding = twinFinding({
      row: rows[0]!,
      pairs: drum,
      passages: ['Luffy grimpe la falaise avec Nami sur le dos, sans jamais lâcher prise.'],
    })

    expect(finding?.fix).toMatchObject({ action: 'rejeter_entite', entityId: 's-138-court' })
    expect(finding?.objectEntityId).toBe('s-138-long')
  })
})

describe('ce qu’une réponse n’a pas le droit de contenir', () => {
  const pairs = twinCandidates(CHAPITRE_14)

  it('refuse une paire que le modèle a formée', () => {
    expect(
      parseTwinVerdicts('s-14-court | s-inventee | same_scene | phrase | raison', pairs),
    ).toEqual([])
  })

  it('refuse un mot qui n’est pas un verdict', () => {
    expect(
      parseTwinVerdicts('s-14-court | s-14-long | peut-être | phrase | raison', pairs),
    ).toEqual([])
  })

  it('ne juge pas deux fois la même paire, dans un sens ou dans l’autre', () => {
    const rows = parseTwinVerdicts(
      's-14-court | s-14-long | same_scene | phrase | premier\n' +
        's-14-long | s-14-court | distinct_steps | phrase | second',
      pairs,
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.verdict).toBe('same_scene')
  })

  it('ignore une réponse en prose', () => {
    expect(parseTwinVerdicts('insufficient_data', pairs)).toEqual([])
  })
})

describe('la consigne', () => {
  it('nomme les trois façons de ne pas être un doublon', () => {
    const question = twinQuestion(14)

    expect(question).toContain('same_scene')
    expect(question).toContain('distinct_steps')
    expect(question).toContain('recall_or_flashback')
    expect(question).toContain('insufficient_data')
  })
})

describe('ce qui décide de relire un chapitre', () => {
  const pairs = twinCandidates(CHAPITRE_14)

  it('ne change pas quand rien n’a changé', () => {
    expect(twinInputs(pairs, ['un passage'])).toEqual(twinInputs(pairs, ['un passage']))
  })

  it('change quand une scène est reformulée', () => {
    const other = twinCandidates([
      CHAPITRE_14[0]!,
      { ...CHAPITRE_14[1]!, summary: `${CHAPITRE_14[1]!.summary} Puis elle disparaît.` },
    ])

    expect(twinInputs(other, ['un passage'])).not.toEqual(twinInputs(pairs, ['un passage']))
  })
})
