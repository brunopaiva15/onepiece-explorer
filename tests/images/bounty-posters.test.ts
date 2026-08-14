import { describe, expect, it } from 'vitest'
import {
  BOUNTY_HISTORY,
  bountiesUpTo,
  bountyAtChapter,
  bountyCharacter,
  formatBerries,
} from '@/domains/images/bounties.ts'
import {
  CATEGORY,
  findPoster,
  isCanon,
  parseGallery,
  plainCaption,
} from '@/domains/images/sources/bounty-posters.ts'

/**
 * Les avis de recherche, et la seule façon de les montrer sans mentir.
 *
 * A wanted poster carries a face, an epithet and a number, and all three belong
 * to one moment of the story. Everything below is about the two ways that goes
 * wrong: showing a poster too early, which is a spoiler, and showing the wrong
 * printing, which is a lie about a number.
 *
 * The second one is not hypothetical. The first pass of the manifest pinned
 * five of nine posters to the wrong printing, every one of them because the
 * wiki files them under « … Current Wanted Poster.png » and « current » means
 * whatever it meant on the day somebody last uploaded — 2016, for Nami's, which
 * shows sixty-six million rather than the three hundred and sixty-six she is
 * wanted for now. These tests pin the rules that were written in response.
 */

/** The real gallery's shape, trimmed to the lines that matter. */
const GALLERY = `
{{DISPLAYTITLE:Wanted Posters}}
{{GalleryBG|#665200|Wanted Posters|#FFE4C4|
==The Straw Hat Pirates' Posters==
{{Gallery|width=100|height=110|captionalign=center|position=center
|Monkey D. Luffy's Seventh Wanted Poster.png|[[Monkey D. Luffy|Luffy]]'s wanted poster.
|Nami's Current Wanted Poster.png|[[Nami]]'s wanted poster.
|Tony Tony Chopper's Second Wanted Poster.png|[[Tony Tony Chopper|Chopper]]'s wanted poster.
}}

===Former depictions===
{{Gallery|width=100|height=110
|Luffy Wanted Poster.png|Luffy's former wanted poster (pre-Dressrosa).
|Zoro's Wanted Poster.png|Zoro's former wanted poster.
}}

==East Blue Posters==
{{Gallery
|Higuma Bounty Poster.png|[[Higuma]]'s wanted poster as seen in Episode of Luffy.
}}

==Eyecatchers==
{{Gallery
|Luffy eyecatcher poster.png|The end of Luffy's first eyecatcher.
|Zoro eyecatcher poster.png|The end of Zoro's first eyecatcher.
}}
}}
`

const gallery = parseGallery(GALLERY)
const luffy = BOUNTY_HISTORY.find((c) => c.canonical === 'Monkey D. Luffy')!
const chopper = BOUNTY_HISTORY.find((c) => c.canonical === 'Tony Tony Chopper')!
const zoro = BOUNTY_HISTORY.find((c) => c.canonical === 'Roronoa Zoro')!

describe('la galerie du wiki, telle qu’elle est écrite', () => {
  it('lit les entrées du gabarit {{Gallery}}, pas seulement la balise <gallery>', () => {
    // The page uses the template, whose entries are `|File.png|caption` with no
    // namespace. A parser that required `File:` read this page as empty.
    expect(gallery.length).toBe(8)
    expect(gallery[0]?.title).toBe("File:Monkey D. Luffy's Seventh Wanted Poster.png")
  })

  it('garde la section de chaque fichier', () => {
    const eyecatcher = gallery.find((entry) => entry.title.includes('eyecatcher'))
    expect(eyecatcher?.section).toBe('Eyecatchers')
  })

  it('déplie les liens du wiki dans les légendes', () => {
    expect(plainCaption("[[Monkey D. Luffy|Luffy]]'s wanted poster.")).toBe(
      "Monkey D. Luffy Luffy's wanted poster.",
    )
  })
})

describe('ce qui n’est pas une affiche de chapitre', () => {
  it('écarte les eyecatchers et les affiches hors canon', () => {
    const eyecatcher = gallery.find((entry) => entry.title.includes('eyecatcher'))!
    expect(isCanon(eyecatcher)).toBe(false)
  })

  it('écarte un film cité dans une section canonique', () => {
    const higuma = gallery.find((entry) => entry.title.includes('Higuma'))!
    expect(higuma.section).toBe('East Blue Posters')
    expect(isCanon(higuma)).toBe(false)
  })
})

describe('un fichier connu de la seule catégorie', () => {
  /*
   * Half the catalogue reaches us with a name and nothing else: the category
   * lists two hundred and fifty files and carries no caption and no heading. So
   * the non-canon check reads the name too, or a film poster walks in unlabelled.
   */
  it('est jugé sur son nom, faute de légende', () => {
    const stampede = { title: "File:Kuro's Wanted Poster in Stampede.png", caption: '', section: CATEGORY }
    const liveAction = { title: 'File:Buggy Wanted Poster Live Action.png', caption: '', section: CATEGORY }
    const real = { title: "File:Koby's Wanted Poster.png", caption: '', section: CATEGORY }

    expect(isCanon(stampede)).toBe(false)
    expect(isCanon(liveAction)).toBe(false)
    expect(isCanon(real)).toBe(true)
  })

  it('reste rattachable quand le manifeste le nomme', () => {
    const gallery = [{ title: "File:Koby's Wanted Poster.png", caption: '', section: CATEGORY }]
    const row = { chapter: 1, amount: 1, edition: 1, file: "Koby's Wanted Poster.png" }
    expect(findPoster(gallery, luffy, row)?.entry.title).toBe("File:Koby's Wanted Poster.png")
  })
})

describe('rattacher un tirage à un fichier', () => {
  it('lit l’ordinal dans le nom du fichier', () => {
    const seventh = luffy.rows.find((row) => row.edition === 7)!
    expect(findPoster(gallery, luffy, seventh)?.entry.title).toBe(
      "File:Monkey D. Luffy's Seventh Wanted Poster.png",
    )
  })

  /*
   * The bug this whole file exists for. « The end of Luffy's first eyecatcher »
   * contains the word « first », so an ordinal read out of a caption attached
   * an anime interstitial to Luffy's thirty-million poster — and it looked
   * entirely plausible on the page.
   */
  it('ne lit jamais l’ordinal dans la légende', () => {
    const first = luffy.rows.find((row) => row.edition === 1)!
    expect(findPoster(gallery, luffy, first)).toBeNull()
  })

  it('refuse un fichier qui nomme le personnage sans dire quel tirage', () => {
    /*
     * « Zoro's Wanted Poster.png » names Zoro and says nothing about which of
     * his four posters it is. It happens to be the hundred-and-twenty-million
     * printing, which is why the manifest pins it — but that was a person
     * opening the picture and reading the figure, and the pin is stripped here
     * so the assertion is about the matcher's own judgement. Left to itself it
     * must decline, because the name supports no answer.
     */
    for (const row of zoro.rows) {
      const { file: _pinned, ...unpinned } = row
      const match = findPoster(gallery, zoro, unpinned)
      expect(match?.entry.title ?? '').not.toBe("File:Zoro's Wanted Poster.png")
    }
  })

  it('prend le fichier que le manifeste nomme', () => {
    const fourth = luffy.rows.find((row) => row.edition === 4)!
    expect(fourth.file).toBe('Luffy Wanted Poster.png')
    expect(findPoster(gallery, luffy, fourth)?.why).toContain('manifeste')
  })

  it('ne rattache rien quand le fichier nommé a disparu de la galerie', () => {
    const missing = { chapter: 1, amount: 1, edition: 1, file: 'Introuvable.png' }
    expect(findPoster(gallery, luffy, missing)).toBeNull()
  })

  it('rattache le bon tirage à Chopper', () => {
    const second = chopper.rows.find((row) => row.edition === 2)!
    expect(second.amount).toBe(100)
    expect(findPoster(gallery, chopper, second)?.entry.title).toBe(
      "File:Tony Tony Chopper's Second Wanted Poster.png",
    )
  })
})

describe('la prime que le lecteur connaît', () => {
  it('est la dernière imprimée avant sa position', () => {
    expect(bountyAtChapter(luffy, 1100)?.amount).toBe(3_000_000_000)
    expect(bountyAtChapter(luffy, 1000)?.amount).toBe(1_500_000_000)
    expect(bountyAtChapter(luffy, 500)?.amount).toBe(300_000_000)
    expect(bountyAtChapter(luffy, 100)?.amount).toBe(30_000_000)
  })

  it('n’existe pas avant la première', () => {
    expect(bountyAtChapter(luffy, 95)).toBeNull()
    expect(bountiesUpTo(luffy, 95)).toEqual([])
  })

  it('ne dépasse jamais la position, quel que soit le chapitre', () => {
    // The property, stated once for every character and every chapter that
    // matters: nothing visible was printed after the reader got there.
    for (const character of BOUNTY_HISTORY) {
      for (const chapter of [1, 96, 234, 435, 597, 801, 903, 1058, 1100]) {
        for (const row of bountiesUpTo(character, chapter)) {
          expect(row.chapter).toBeLessThanOrEqual(chapter)
        }
      }
    }
  })
})

describe('le manifeste', () => {
  it('garde les chapitres et les tirages croissants', () => {
    for (const character of BOUNTY_HISTORY) {
      const chapters = character.rows.map((row) => row.chapter)
      const editions = character.rows.map((row) => row.edition)
      expect(chapters).toEqual([...chapters].sort((a, b) => a - b))
      expect(editions).toEqual([...editions].sort((a, b) => a - b))
    }
  })

  it('ne nomme jamais deux fois le même fichier', () => {
    // Two printings pinned to one picture means one of them is wrong, and the
    // wrong one is showing a bounty that is not its own.
    const files = BOUNTY_HISTORY.flatMap((c) => c.rows.map((row) => row.file)).filter(
      (file): file is string => file !== undefined,
    )
    expect(new Set(files).size).toBe(files.length)
  })

  it('reconnaît un personnage par n’importe lequel de ses noms', () => {
    expect(bountyCharacter('Luffy')?.canonical).toBe('Monkey D. Luffy')
    expect(bountyCharacter('Monkey D. Luffy')?.canonical).toBe('Monkey D. Luffy')
    expect(bountyCharacter('Sogeking')?.canonical).toBe('Usopp')
    // The longer alias wins: « Vinsmoke Sanji » contains « Sanji », and taking
    // the first match in declaration order would be an accident of ordering.
    expect(bountyCharacter('Vinsmoke Sanji')?.canonical).toBe('Sanji')
  })

  it('ne reconnaît pas un nom qui en contient un autre par hasard', () => {
    expect(bountyCharacter('Namur')).toBeNull()
    expect(bountyCharacter('Brooklyn')).toBeNull()
    expect(bountyCharacter('un villageois sans nom')).toBeNull()
  })

  it('écrit la somme comme une affiche l’imprime', () => {
    // Narrow no-break spaces, written as escapes here so the expectation says
    // which character it means rather than looking like an ordinary space.
    expect(formatBerries(30_000_000)).toBe('30\u202f000\u202f000\u202f\u0e3f')
    expect(formatBerries(1_111_000_000)).toBe('1\u202f111\u202f000\u202f000\u202f\u0e3f')
    expect(formatBerries(50)).toBe('50\u202f\u0e3f')
  })
})
