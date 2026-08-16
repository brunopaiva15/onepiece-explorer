import { describe, expect, it } from 'vitest'
import {
  collectThread,
  storyAsText,
  type StoryWindow,
} from '@/app/histoire/transcript.ts'
import type { BeatKind, StoryBeat } from '@/domains/temporal/story.ts'

/**
 * Le fil, mis à plat en texte.
 *
 * Le bouton de copie ne demande rien de plus que ce que la page a déjà lu : il
 * repasse par les mêmes fenêtres, à la même frontière, et écrit les perles
 * qu'on lui tend. Tout ce qui peut être faux est donc ici — la mise en forme —
 * et c'est de l'arithmétique sur un tableau de perles, vérifiable sans
 * navigateur ni base de données.
 *
 * Deux promesses tiennent ces tests. La copie dit la même chose que la page :
 * mêmes verbes, même ancien nom barré d'une flèche, même mention de la langue
 * sous une citation. Et la copie est complète : ce que le fil replie derrière
 * un résumé, parce qu'un fil se lit, la copie l'écrit — on la prend pour la
 * relire ailleurs, et une copie qui retiendrait dix événements par chapitre
 * serait la copie d'autre chose.
 */

function beat(
  kind: BeatKind,
  text: string,
  extra: Partial<StoryBeat> = {},
): StoryBeat {
  return {
    id: `${kind}-${text.slice(0, 12)}`,
    chapter: 12,
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

function write(beats: StoryBeat[], start = 1, lastChapter = 45): string {
  return storyAsText(beats, { start, lastChapter })
}

describe('la copie parcourt le fil comme le défilement le parcourt', () => {
  it('suit les fenêtres jusqu’au bout et garde l’ordre', async () => {
    const windows: Record<number, StoryWindow> = {
      1: { beats: [beat('entree', 'Zeff', { id: 'a' })], nextCursor: 7 },
      7: { beats: [beat('entree', 'Patty', { id: 'b' })], nextCursor: 13 },
      13: { beats: [beat('entree', 'Carne', { id: 'c' })], nextCursor: null },
    }

    const vues: number[] = []
    const perles = await collectThread(1, async (from) => {
      vues.push(from)
      return windows[from]!
    })

    expect(vues).toEqual([1, 7, 13])
    expect(perles.map((perle) => perle.text)).toEqual(['Zeff', 'Patty', 'Carne'])
  })

  it('n’écrit pas deux fois une perle que deux fenêtres se partagent', async () => {
    const windows: Record<number, StoryWindow> = {
      1: {
        beats: [beat('entree', 'Zeff', { id: 'a' }), beat('entree', 'Patty', { id: 'b' })],
        nextCursor: 7,
      },
      7: {
        beats: [beat('entree', 'Patty', { id: 'b' }), beat('entree', 'Carne', { id: 'c' })],
        nextCursor: null,
      },
    }

    const perles = await collectThread(1, async (from) => windows[from]!)
    expect(perles.map((perle) => perle.id)).toEqual(['a', 'b', 'c'])
  })

  it('s’arrête plutôt que de relire la même fenêtre indéfiniment', async () => {
    let appels = 0
    const perles = await collectThread(1, async () => {
      appels += 1
      // Un curseur qui n'avance pas : ailleurs une mauvaise réponse, ici une
      // boucle infinie dans l'onglet de quelqu'un.
      return { beats: [beat('entree', 'Zeff', { id: 'a' })], nextCursor: 1 }
    })

    expect(appels).toBe(1)
    expect(perles).toHaveLength(1)
  })

  it('dit à chaque fois où elle en est', async () => {
    const étapes: number[] = []
    await collectThread(
      10,
      async (from) => ({ beats: [], nextCursor: from < 20 ? from + 6 : null }),
      (chapitre) => étapes.push(chapitre),
    )
    expect(étapes).toEqual([10, 16, 22])
  })
})

describe('l’en-tête dit de quelle copie il s’agit', () => {
  it('nomme les deux bouts du fil', () => {
    const texte = write([], 7, 42)
    expect(texte).toContain('du chapitre 7 au chapitre 42')
  })

  it('se termine par un saut de ligne, comme un fichier', () => {
    expect(write([beat('entree', 'Zeff')])).toMatch(/\n$/)
  })
})

/** Le titre de chapitre écrit, seul — l’en-tête du document en contient aussi. */
function titre(texte: string): string | undefined {
  return texte.split('\n').find((ligne) => ligne.startsWith('## '))
}

describe('un chapitre est un titre', () => {
  it('porte son arc et son titre', () => {
    const texte = write([beat('chapitre', 'À l’aube', { chapter: 12 })])
    expect(titre(texte)).toBe('## Orange Town · Chapitre 12 — À l’aube')
  })

  it('reste un titre sans titre : le numéro est ce qu’il dit', () => {
    const texte = write([beat('chapitre', '', { chapter: 12 })])
    expect(titre(texte)).toBe('## Orange Town · Chapitre 12')
  })
})

describe('les perles disent ce que la page dit', () => {
  it('met le verbe devant la ligne', () => {
    expect(write([beat('entree', 'Zeff')])).toContain('- entre en scène : Zeff')
    expect(write([beat('mention', 'Zoro')])).toContain('- on en parle : Zoro')
  })

  it('garde l’ancien nom, séparé par la flèche', () => {
    const texte = write([
      beat('nom', 'Monkey D. Luffy', { detail: 'le garçon au chapeau' }),
    ])
    expect(texte).toContain('- un nom : le garçon au chapeau → Monkey D. Luffy')
  })

  it('porte le moment d’un souvenir sur l’étiquette, pas en seconde ligne', () => {
    const texte = write([
      beat('souvenir', 'Shanks perd son bras gauche', {
        detail: 'environ dix ans plus tôt',
      }),
    ])
    expect(texte).toContain(
      '- souvenir · environ dix ans plus tôt : Shanks perd son bras gauche',
    )
  })

  it('dit depuis quand une croyance tenait, quand elle tombe', () => {
    const texte = write([
      beat('dementi', 'Zoro est un chasseur de primes', {
        detail: 'cru depuis le chapitre 3',
      }),
    ])
    expect(texte).toContain(
      '- on ne croit plus : Zoro est un chasseur de primes (cru depuis le chapitre 3)',
    )
  })

  it('cite en bloc, et dit dans quelle langue', () => {
    const texte = write([
      beat('citation', 'Je serai le roi des pirates.', { chapter: 5 }),
    ])
    expect(texte).toContain('> Je serai le roi des pirates.')
    expect(texte).toContain(
      '> — cité du chapitre 5, dans la langue de la source',
    )
  })

  it('laisse tomber une perle dont la ligne est vide', () => {
    const texte = write([beat('evenement', '   '), beat('entree', 'Zeff')])
    expect(texte).toContain('Zeff')
    expect(texte).not.toContain('- il arrive')
  })
})

describe('la copie est complète', () => {
  it('écrit aussi la queue que la page replie', () => {
    const texte = write([
      beat('evenement', 'Le premier', { id: 'a' }),
      beat('evenement', 'Le sixième', { id: 'f', collapsed: true }),
    ])
    expect(texte).toContain('- il arrive : Le premier')
    expect(texte).toContain('- il arrive : Le sixième')
  })

  it('serre les perles et n’aère qu’autour des blocs', () => {
    const texte = write([
      beat('chapitre', 'À l’aube', { chapter: 12 }),
      beat('entree', 'Zeff'),
      beat('entree', 'Patty'),
      beat('citation', 'Une phrase citée.'),
      beat('entree', 'Carne'),
    ])

    // Deux perles de suite forment une liste, pas deux listes d'une perle.
    expect(texte).toContain('- entre en scène : Zeff\n- entre en scène : Patty')
    // Un bloc respire des deux côtés.
    expect(texte).toContain('Patty\n\n> Une phrase citée.')
    expect(texte).toContain('source\n\n- entre en scène : Carne')
  })

  it('garde l’ordre du fil : une copie n’est pas un index', () => {
    const texte = write([
      beat('chapitre', 'À l’aube', { chapter: 12 }),
      beat('entree', 'Zeff'),
      beat('evenement', 'Alvida perd sa massue'),
    ])
    const rangs = ['## Orange Town · Chapitre 12', 'Zeff', 'Alvida'].map((part) =>
      texte.indexOf(part),
    )
    expect(rangs).toEqual([...rangs].sort((a, b) => a - b))
    expect(rangs.every((rang) => rang > 0)).toBe(true)
  })
})
