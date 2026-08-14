import { describe, expect, it } from 'vitest'
import { planShots, progressOf, RATES } from '@/app/histoire/shots.ts'
import type { DisplayImage } from '@/domains/images/index.ts'
import type { BeatKind, StoryBeat, StoryPart } from '@/domains/temporal/story.ts'

/**
 * Le découpage du fil en plans.
 *
 * Le mode animation ne va rien chercher que le fil n'ait déjà : il rejoue les
 * mêmes perles, dans le même ordre, à la même frontière. Ce qui peut être faux
 * est donc entièrement ici — ce qu'on coupe, combien de temps on tient un plan,
 * quels visages une phrase porte — et c'est de l'arithmétique sur un tableau de
 * perles, vérifiable sans navigateur.
 *
 * Le premier test est le seul qui touche à la promesse du produit : un plan ne
 * peut afficher qu'une image que la perle portait déjà. Une image que la
 * frontière n'a pas laissé passer n'est pas dans la perle, donc pas dans le
 * film — il n'y a pas de second chemin vers les visages.
 */

/** Une illustration, telle que le fil la remet — signée et courte de vie. */
function image(name: string): DisplayImage {
  return {
    url: `https://exemple.test/${name}.png?sig=abc`,
    thumbUrl: `https://exemple.test/${name}-mini.png?sig=abc`,
    attribution: 'onepieceapi.com',
    sourceUrl: `https://exemple.test/fiche/${name}`,
    matchedLabel: name,
    matchMethod: 'exact',
    matchScore: 1,
    width: 512,
    height: 700,
  }
}

function beat(kind: BeatKind, text: string, extra: Partial<StoryBeat> = {}): StoryBeat {
  return {
    id: `${kind}-${text.slice(0, 12)}`,
    chapter: 42,
    kind,
    text,
    detail: null,
    textParts: null,
    detailParts: null,
    entityId: null,
    portrait: null,
    ...extra,
  }
}

/** Une phrase découpée autour des noms qu'elle cite, comme le fil la rend. */
function parts(
  ...runs: Array<string | readonly [string, DisplayImage]>
): StoryPart[] {
  return runs.map((run) =>
    typeof run === 'string'
      ? { text: run }
      : { text: run[0], entityId: run[0], portrait: run[1] },
  )
}

describe('le fil découpé en plans', () => {
  it('ne montre que les images que la perle porte', () => {
    const luffy = image('Luffy')
    const shanks = image('Shanks')

    const [plan] = planShots([
      beat('evenement', 'Shanks sauve Luffy et perd son bras gauche.', {
        textParts: parts(
          ['Shanks', shanks],
          ' sauve ',
          ['Luffy', luffy],
          ' et perd son bras gauche.',
        ),
      }),
    ])

    expect(plan?.images.map((found) => found.matchedLabel)).toEqual([
      'Shanks',
      'Luffy',
    ])
  })

  it('prend le portrait de la perle avant les visages de sa phrase', () => {
    const zoro = image('Zoro')
    const koby = image('Koby')

    const [plan] = planShots([
      beat('mention', 'Roronoa Zoro', {
        portrait: zoro,
        textParts: parts(['Koby', koby]),
      }),
    ])

    expect(plan?.images[0]?.matchedLabel).toBe('Zoro')
  })

  it('ne compte qu’une fois un visage cité deux fois dans la même perle', () => {
    const luffy = image('Luffy')
    /*
     * La même image, signée deux fois : deux adresses pour un fichier. Le
     * rapprochement se fait donc sur la page source, la seule des deux qui ne
     * change pas d'une signature à l'autre.
     */
    const encore: DisplayImage = { ...luffy, url: `${luffy.url}&sig=autre` }

    const [plan] = planShots([
      beat('evenement', 'Luffy mange le fruit et Luffy ne sait plus nager.', {
        portrait: luffy,
        textParts: parts(['Luffy', encore], ' mange le fruit.'),
      }),
    ])

    expect(plan?.images).toHaveLength(1)
  })

  it('s’arrête à trois visages sur un plan', () => {
    const cast = ['Luffy', 'Zoro', 'Nami', 'Usopp', 'Sanji'].map(image)

    const [plan] = planShots([
      beat('evenement', 'L’équipage quitte le Baratie.', {
        textParts: parts(...cast.map((face) => [face.matchedLabel, face] as const)),
      }),
    ])

    expect(plan?.images).toHaveLength(3)
    expect(plan?.images.at(-1)?.matchedLabel).toBe('Nami')
  })

  it('coupe la queue repliée du chapitre', () => {
    const plans = planShots([
      beat('evenement', 'Le sixième événement du chapitre.', { collapsed: true }),
      beat('evenement', 'Celui que le chapitre est venu raconter.'),
    ])

    expect(plans.map((plan) => plan.line)).toEqual([
      'Celui que le chapitre est venu raconter.',
    ])
  })

  it('fait du chapitre un carton, avec son arc, titré ou non', () => {
    const [titre, nu] = planShots([
      beat('chapitre', 'Baratie', { id: 'ch-42', chapter: 42 }),
      beat('chapitre', '', { id: 'ch-43', chapter: 43 }),
    ])

    expect(titre?.label).toBe('Baratie')
    expect(titre?.line).toBe('Baratie')
    // Un chapitre sans titre reste un chapitre : c'est le numéro qui porte le
    // carton, et une perle vide ailleurs serait un écran blanc tenu deux
    // secondes.
    expect(nu?.chapter).toBe(43)
    expect(nu?.line).toBe('')
  })

  it('laisse tomber une perle dont la ligne est vide', () => {
    expect(planShots([beat('mention', '   ')])).toHaveLength(0)
  })

  it('garde le nom qu’un nom remplace', () => {
    const [plan] = planShots([
      beat('nom', 'Kuro', { detail: 'Klahadore', chapter: 26 }),
    ])

    expect(plan?.before).toBe('Klahadore')
    expect(plan?.line).toBe('Kuro')
    expect(plan?.label).toBe('un nom')
  })

  it('met le moment sur l’étiquette et non sous la phrase', () => {
    const [plan] = planShots([
      beat('souvenir', 'Zeff perd sa jambe.', {
        detail: 'environ dix ans plus tôt',
      }),
    ])

    expect(plan?.label).toBe('souvenir · environ dix ans plus tôt')
    expect(plan?.detail).toBeNull()
  })

  it('annonce une citation et la langue de sa source', () => {
    const [plan] = planShots([
      beat('citation', 'Je serai le roi des pirates !', { chapter: 1 }),
    ])

    expect(plan?.label).toBe('citation')
    expect(plan?.detail).toBe('Cité du chapitre 1, dans la langue de la source')
  })

  it('tient un plan le temps qu’il faut pour le lire, plancher et plafond compris', () => {
    const [nom, phrase, pavé] = planShots([
      beat('entree', 'Zeff'),
      beat('evenement', 'A'.repeat(60)),
      beat('evenement', 'A'.repeat(400)),
    ])

    // Un nom mesuré à sa seule longueur passerait en moins d'une seconde : ce
    // n'est pas un plan, c'est un clignotement.
    expect(nom?.ms).toBe(1600)
    expect(phrase?.ms).toBeGreaterThan(nom!.ms)
    expect(phrase?.ms).toBeLessThan(7000)
    expect(pavé?.ms).toBe(7000)
  })

  it('offre une vitesse normale, et rien qui arrête le film', () => {
    expect(RATES.some((speed) => speed.factor === 1)).toBe(true)
    for (const speed of RATES) expect(speed.factor).toBeGreaterThan(0)
  })
})

describe('l’avancée dans le fil', () => {
  it('se mesure en chapitres, du départ à la frontière', () => {
    expect(progressOf(1, 1, 101)).toBe(0)
    expect(progressOf(51, 1, 101)).toBeCloseTo(0.5)
    expect(progressOf(101, 1, 101)).toBe(1)
  })

  it('reste bornée quand le fil ne tient qu’un chapitre', () => {
    // Départ et frontière confondus : la jauge est pleine, pas divisée par
    // zéro.
    expect(progressOf(7, 7, 7)).toBe(1)
    expect(progressOf(200, 1, 101)).toBe(1)
    expect(progressOf(0, 1, 101)).toBe(0)
  })
})
