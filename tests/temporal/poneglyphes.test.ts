import { describe, expect, it } from 'vitest'
import {
  PONEGLYPHS,
  labelNames,
  poneglyphAtChapter,
  poneglyphCountsAtChapter,
  poneglyphsKnownAt,
  whereAtChapter,
} from '@/domains/temporal/poneglyphs.ts'

/**
 * Une pierre ne se lit jamais en avance.
 *
 * The manifest is written by hand, so no test can tell you that the stone under
 * Alubarna really appears on page 18 of chapter 202 — somebody read that off the
 * page, and that is the whole value of the file. What a test *can* do is the
 * thing a hand-written table gets wrong: it can check that every date in it is
 * used as a threshold rather than as a decoration.
 *
 * That is what follows. Not « is the number right », but « does a reader sitting
 * one chapter before the number see nothing » — for the stone's existence, for
 * its place, for the sight of it, for the reading of it, for the word « road »,
 * for the fact that one of them is missing, and for the counts. Each of those is
 * a separate leak with its own field, and each one is checked at the chapter
 * before and the chapter itself.
 */

describe('les ponéglyphes connus à un chapitre', () => {
  it('n’en connaît aucun avant que l’œuvre en parle', () => {
    /*
     * Chapter 192 is not an arbitrary number: 193 is the chapter in which Cobra
     * agrees to lead Crocodile to the stone, and it is the first time the work
     * uses the word at all. A front page that showed a « ponéglyphes » heading
     * to a reader of Little Garden would be raising a subject the story has not.
     */
    expect(poneglyphsKnownAt(0)).toEqual([])
    expect(poneglyphsKnownAt(192)).toEqual([])
    expect(poneglyphsKnownAt(193).map((stone) => stone.slug)).toEqual(['alabasta'])
  })

  it('révèle chaque pierre au chapitre qui en parle, et pas avant', () => {
    for (const stone of PONEGLYPHS) {
      const before = poneglyphsKnownAt(stone.known - 1).map((known) => known.slug)
      const after = poneglyphsKnownAt(stone.known).map((known) => known.slug)
      expect(before, `${stone.slug} avant le chapitre ${stone.known}`).not.toContain(stone.slug)
      expect(after, `${stone.slug} au chapitre ${stone.known}`).toContain(stone.slug)
    }
  })

  it('les rend dans l’ordre où le lecteur les apprend', () => {
    const known = poneglyphsKnownAt(9999)
    expect(known).toHaveLength(PONEGLYPHS.length)
    const chapters = known.map((stone) => stone.known)
    expect([...chapters].sort((a, b) => a - b)).toEqual(chapters)
  })
})

describe('ce qu’une pierre dit d’elle-même à un chapitre', () => {
  const alabasta = PONEGLYPHS.find((stone) => stone.slug === 'alabasta')!

  it('ne dit pas où elle est avant le chapitre qui le montre', () => {
    /*
     * The stone is known from 193 and the tomb is known from 202. Nine chapters
     * in which the honest answer is « en Alabasta », and « Tombeau des Rois »
     * would be the interface telling the reader where Cobra is about to take
     * Crocodile.
     */
    expect(poneglyphAtChapter(alabasta, 193).where).toBe('Royaume d’Alabasta')
    expect(poneglyphAtChapter(alabasta, 201).where).toBe('Royaume d’Alabasta')
    expect(poneglyphAtChapter(alabasta, 202).where).toBe('Tombeau des Rois, sous Alubarna')
  })

  it('ne dit pas qu’elle a été vue ni lue avant les chapitres qui le font', () => {
    const atMention = poneglyphAtChapter(alabasta, 193)
    expect(atMention.seen).toBeNull()
    expect(atMention.read).toBeNull()

    const atSight = poneglyphAtChapter(alabasta, 202)
    expect(atSight.seen).toBe(202)
    /* Robin reads it at 203. « Lu au chapitre 203 » on the screen of somebody
       reading 202 tells them what the next chapter is about. */
    expect(atSight.read).toBeNull()

    expect(poneglyphAtChapter(alabasta, 203).read).toBe(203)
  })

  it('ne prononce pas le mot « road » avant qu’Inuarashi le prononce', () => {
    const zou = PONEGLYPHS.find((stone) => stone.slug === 'zou')!
    /* Seen at 817, called a road poneglyph at 818: the one line in the manifest
       where the stone and its classification arrive in different chapters. */
    expect(poneglyphAtChapter(zou, 817).seen).toBe(817)
    expect(poneglyphAtChapter(zou, 817).road).toBe(false)
    expect(poneglyphAtChapter(zou, 818).road).toBe(true)

    for (const stone of PONEGLYPHS) {
      if (stone.road === undefined) continue
      expect(
        poneglyphAtChapter(stone, stone.road - 1).road,
        `${stone.slug} avant le chapitre ${stone.road}`,
      ).toBe(false)
    }
  })

  it('ne dit d’aucune pierre qu’elle a disparu avant qu’on l’apprenne', () => {
    for (const stone of PONEGLYPHS) {
      if (stone.lost === undefined) {
        expect(poneglyphAtChapter(stone, 9999).lost, stone.slug).toBe(false)
        continue
      }
      expect(poneglyphAtChapter(stone, stone.lost - 1).lost, stone.slug).toBe(false)
      expect(poneglyphAtChapter(stone, stone.lost).lost, stone.slug).toBe(true)
    }
  })

  it('ne propose jamais un lieu du graphe que le chapitre n’a pas encore nommé', () => {
    /*
     * The aliases travel with the description, not with the stone, and this is
     * why: they are what a card is allowed to link to, so a set of them left
     * hanging on the stone itself would offer « Tombeau des Rois » nine chapters
     * before the tomb is named.
     */
    expect(poneglyphAtChapter(alabasta, 193).entities).toEqual(['Alabasta'])
    expect(poneglyphAtChapter(alabasta, 202).entities).toEqual([
      'Tombeau des Rois',
      'Alubarna',
    ])
  })
})

describe('les comptes annoncés par l’histoire', () => {
  it('ne compte rien avant les chapitres qui comptent', () => {
    expect(poneglyphCountsAtChapter(817)).toEqual({ roads: null, total: null })
    /* Inuarashi, chapitre 818 : quatre pierres mènent à la dernière île. */
    expect(poneglyphCountsAtChapter(818)).toEqual({ roads: 4, total: null })
    expect(poneglyphCountsAtChapter(845)).toEqual({ roads: 4, total: null })
    /* Tamago, chapitre 846 : trente en tout dans le monde. */
    expect(poneglyphCountsAtChapter(846)).toEqual({ roads: 4, total: 30 })
  })

  it('ne connaît pas plus de pierres de route qu’il n’en existe', () => {
    /*
     * A tracker that showed five road poneglyphs while the story says there are
     * four would be wrong about the work, not merely about a reader. Checked at
     * the end of the manifest, where every road stone is known.
     */
    const { roads } = poneglyphCountsAtChapter(9999)
    const known = poneglyphsKnownAt(9999).filter((stone) => stone.road)
    expect(roads).not.toBeNull()
    expect(known.length).toBeLessThanOrEqual(roads!)
  })
})

describe('le manifeste lui-même', () => {
  it('ne donne pas deux fois la même clé', () => {
    const slugs = PONEGLYPHS.map((stone) => stone.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('date chaque description à partir du chapitre qui révèle la pierre', () => {
    for (const stone of PONEGLYPHS) {
      expect(stone.where.length, stone.slug).toBeGreaterThan(0)
      /* The first description arrives with the stone: a stone known and placed
         nowhere would be a card with a name and nothing under it. */
      expect(stone.where[0]!.chapter, stone.slug).toBe(stone.known)
      const chapters = stone.where.map((line) => line.chapter)
      expect([...chapters].sort((a, b) => a - b), stone.slug).toEqual(chapters)
      expect(whereAtChapter(stone, stone.known - 1), stone.slug).toBeNull()
    }
  })

  it('ne montre ni ne fait lire une pierre avant de l’avoir annoncée', () => {
    for (const stone of PONEGLYPHS) {
      if (stone.seen !== undefined) {
        expect(stone.seen, `${stone.slug} vu`).toBeGreaterThanOrEqual(stone.known)
      }
      if (stone.read !== undefined) {
        expect(stone.read, `${stone.slug} lu`).toBeGreaterThanOrEqual(stone.known)
      }
      if (stone.road !== undefined) {
        expect(stone.road, `${stone.slug} route`).toBeGreaterThanOrEqual(stone.known)
      }
      if (stone.lost !== undefined) {
        expect(stone.lost, `${stone.slug} disparu`).toBeGreaterThanOrEqual(stone.known)
      }
    }
  })

  it('ne nomme aucune pierre « road » : c’est un état, pas un nom', () => {
    /* The classification is dated and the name is not, so a name carrying the
       word would leak at 817 whatever `road` says. */
    for (const stone of PONEGLYPHS) {
      expect(stone.name.toLowerCase(), stone.slug).not.toContain('road')
    }
  })
})

describe('le nom d’un lieu, rapproché d’un libellé du graphe', () => {
  it('reconnaît le mot entier, accents et articles compris', () => {
    expect(labelNames('Royaume d’Alabasta', 'Alabasta')).toBe(true)
    expect(labelNames('Île des Hommes-Poissons', 'Ile des Hommes Poissons')).toBe(true)
    expect(labelNames('Tombeau des Rois', 'Tombeau des Rois')).toBe(true)
  })

  it('refuse un mot qui n’en est qu’un morceau', () => {
    /* The whole reason for the padding: a link is a claim that this label is
       that place, and « Zou » is not « Zoulou ». */
    expect(labelNames('Zoulou', 'Zou')).toBe(false)
    expect(labelNames('Oharan', 'Ohara')).toBe(false)
    expect(labelNames('Skypiea', 'Shandora')).toBe(false)
  })
})
