import { describe, expect, it } from 'vitest'
import { sameBeat } from '@/domains/knowledge/beats.ts'
import { oneEntryPerScene, type ChronologyEvent } from '@/domains/temporal/chronology.ts'
import { oneBeadPerBeat, type BeatKind, type StoryBeat } from '@/domains/temporal/story.ts'

/**
 * Le chapitre 2, relu deux fois.
 *
 * Le fil affichait « Luffy et Koby prennent la mer ensemble, Koby lui parlant de
 * Zoro que Luffy décide de recruter », puis, six perles plus loin, « Luffy et
 * Koby prennent la mer ensemble ; Koby parle de Zoro à Luffy qui décide de le
 * recruter ». Une seule chose s'est produite. Deux traitements du même chapitre
 * l'ont écrite deux fois, avec des mots différents — donc deux empreintes, donc
 * deux entités, et rien en aval pour les rejoindre.
 *
 * Les deux directions comptent, et la seconde plus que la première : une scène
 * repliée à tort est une scène que le lecteur ne verra jamais, et c'est
 * exactement ce que ce produit existe pour ne pas faire. Les cas « ce sont deux
 * scènes » sont donc pris dans les formes où ils se ressemblent le plus — même
 * verbe, même sujet, une seule chose qui change.
 */

const A_LEFT =
  'Luffy et Koby prennent la mer ensemble, Koby lui parlant de Zoro que Luffy décide de recruter.'
const A_RIGHT =
  'Luffy et Koby prennent la mer ensemble ; Koby parle de Zoro à Luffy qui décide de le recruter.'

function beat(text: string, kind: BeatKind = 'evenement', id = text): StoryBeat {
  return {
    id,
    chapter: 2,
    kind,
    text,
    detail: null,
    textParts: null,
    detailParts: null,
    entityId: null,
    portrait: null,
  }
}

describe('sameBeat', () => {
  it('reconnaît une scène racontée deux fois par deux traitements', () => {
    expect(sameBeat(A_LEFT, A_RIGHT)).toBe(true)
  })

  it('reconnaît la même phrase à une incise près', () => {
    expect(
      sameBeat(
        'Kuina meurt en tombant dans les escaliers ; Zoro obtient son sabre.',
        'Kuina meurt le lendemain en tombant dans les escaliers ; Zoro obtient son sabre.',
      ),
    ).toBe(true)
  })

  it('garde deux scènes qui ne partagent que leur distribution', () => {
    expect(sameBeat('Zoro affronte Morgan', 'Zoro promet à Koby')).toBe(false)
  })

  it('garde deux coups portés à deux personnes différentes', () => {
    // Le cas dangereux : même sujet, même verbe, une seule chose qui change.
    expect(sameBeat('Luffy frappe Alvida', 'Luffy frappe Morgan')).toBe(false)
    expect(
      sameBeat(
        'Zoro tranche Kuroobi dans le hall du restaurant.',
        'Zoro tranche Hachi dans le hall du restaurant.',
      ),
    ).toBe(false)
  })

  it('ne rapproche rien sur un seul mot commun', () => {
    expect(sameBeat('Luffy mange', 'Luffy dort')).toBe(false)
  })

  it('ne compare pas des phrases trop courtes pour être comparées', () => {
    /*
     * Le mot qui les distingue est un chiffre, et aucun découpage ne le garde.
     * Une proportion de trois mots n'est pas une mesure : au-dessous du seuil,
     * la règle ne répond pas plutôt que de répondre au hasard.
     */
    expect(sameBeat('Il arrive 0.', 'Il arrive 1.')).toBe(false)
    expect(sameBeat('Higuma arrive.', 'Higuma repart.')).toBe(false)
  })

  it('accepte que la version la plus complète nomme quelqu’un de plus', () => {
    /*
     * Un nom exclusif d'un seul côté, c'est la version longue qui est longue —
     * pas une seconde scène. Il en faut un de chaque côté pour que les deux
     * parlent de gens différents.
     */
    expect(
      sameBeat(
        'Luffy protège Koby et met Alvida hors de combat.',
        'Luffy protège Koby et l’assomme.',
      ),
    ).toBe(true)
  })
})

describe('oneBeadPerBeat', () => {
  it('ne dit qu’une fois ce que le chapitre a écrit deux fois', () => {
    const beads = oneBeadPerBeat([beat(A_LEFT), beat('Alvida détruit le bateau de Koby.'), beat(A_RIGHT)])

    expect(beads.map((bead) => bead.text)).toEqual([
      A_LEFT,
      'Alvida détruit le bateau de Koby.',
    ])
  })

  it('garde la première version, à sa place dans le fil', () => {
    // L'ordre du fil est l'ordre du récit : une redite n'a pas de droit sur une
    // place que l'histoire ne lui a pas donnée.
    const beads = oneBeadPerBeat([beat(A_RIGHT), beat(A_LEFT)])
    expect(beads).toHaveLength(1)
    expect(beads[0]!.text).toBe(A_RIGHT)
  })

  it('replie une scène même si les deux traitements l’ont classée différemment', () => {
    // Un traitement dit « souvenir », l'autre « il arrive ». Ils ne sont pas
    // d'accord sur le cadre ; ils racontent la même chose.
    const beads = oneBeadPerBeat([beat(A_LEFT, 'evenement'), beat(A_RIGHT, 'souvenir')])
    expect(beads).toHaveLength(1)
  })

  it('laisse la déduplication exacte faire son travail sur les autres perles', () => {
    const beads = oneBeadPerBeat([
      beat('Koby', 'entree', 'a'),
      beat('Koby', 'entree', 'b'),
      beat('Koby', 'mention', 'c'),
    ])
    expect(beads.map((bead) => bead.kind)).toEqual(['entree', 'mention'])
  })

  it('ne replie pas deux entrées en scène qui se ressemblent', () => {
    // La règle des scènes ne s'applique qu'aux scènes : « Pirates d'Alvida » et
    // « Pirates de Baggy » sont deux groupes, quoi qu'en dise leur libellé.
    const beads = oneBeadPerBeat([
      beat('Pirates d’Alvida', 'entree', 'a'),
      beat('Pirates de Baggy', 'entree', 'b'),
    ])
    expect(beads).toHaveLength(2)
  })
})

function entry(
  entityId: string,
  summary: string,
  overrides: Partial<ChronologyEvent> = {},
): ChronologyEvent {
  return {
    entityId,
    label: summary.slice(0, 200),
    summary,
    chapter: 2,
    isFlashback: false,
    placement: { kind: 'present' },
    storyTime: null,
    recordedAt: 0,
    ...overrides,
  }
}

describe('oneEntryPerScene', () => {
  it('ne compte qu’une fois une scène écrite deux fois dans le même chapitre', () => {
    const kept = oneEntryPerScene([
      entry('a', A_LEFT, { recordedAt: 1 }),
      entry('b', A_RIGHT, { recordedAt: 2 }),
    ])
    expect(kept.map((event) => event.entityId)).toEqual(['a'])
  })

  it('replie la copie même quand les deux traitements ne la placent pas pareil', () => {
    /*
     * Le cas qu'un repli fait bucket par bucket ne verrait jamais : un
     * traitement a coché « souvenir », l'autre non, donc les deux copies
     * atterrissent dans deux colonnes de la page et s'y comptent chacune.
     */
    const kept = oneEntryPerScene([
      entry('a', A_LEFT, { recordedAt: 1 }),
      entry('b', A_RIGHT, {
        recordedAt: 2,
        isFlashback: true,
        placement: { kind: 'earlier', description: null },
      }),
    ])
    expect(kept.map((event) => event.entityId)).toEqual(['a'])
  })

  it('garde la même scène racontée par deux chapitres', () => {
    // Un chapitre qui reraconte, c'est un flash-back — pas un doublon.
    const kept = oneEntryPerScene([
      entry('a', A_LEFT, { chapter: 2 }),
      entry('b', A_LEFT, { chapter: 40, isFlashback: true }),
    ])
    expect(kept).toHaveLength(2)
  })

  it('replie d’après le premier récit, quel que soit l’ordre des lignes lues', () => {
    const rows = [
      entry('b', A_RIGHT, { recordedAt: 2 }),
      entry('a', A_LEFT, { recordedAt: 1 }),
    ]
    expect(oneEntryPerScene(rows).map((event) => event.entityId)).toEqual(['a'])
    expect(oneEntryPerScene([...rows].reverse()).map((event) => event.entityId)).toEqual([
      'a',
    ])
  })
})
