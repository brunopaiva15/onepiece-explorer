import { describe, expect, it } from 'vitest'
import { ARCS, arcOf } from '@/domains/temporal/arcs.ts'

/**
 * The table of contents, checked against the table of contents.
 *
 * Story mode names an arc beside a chapter number, and the one way that can be
 * wrong is off by a chapter: « Alabasta » on chapter 218, which is Jaya, is a
 * page telling the reader they are somewhere they are not. The bounds below are
 * written out again rather than derived from the module, because a test that
 * asks the source to confirm itself confirms nothing.
 */

/** Each arc's first and last chapter, as the work publishes them. */
const RANGES: ReadonlyArray<readonly [number, number | null, string]> = [
  [1, 7, 'Romance Dawn'],
  [8, 21, 'Orange Town'],
  [22, 41, 'Syrup Village'],
  [42, 68, 'Baratie'],
  [69, 95, 'Arlong Park'],
  [96, 100, 'Loguetown'],
  [101, 105, 'Reverse Mountain'],
  [106, 114, 'Whisky Peak'],
  [115, 129, 'Little Garden'],
  [130, 154, 'Drum Island'],
  [155, 217, 'Alabasta'],
  [218, 236, 'Jaya'],
  [237, 302, 'Skypiea'],
  [303, 321, 'Long Ring Long Land'],
  [322, 374, 'Water Seven'],
  [375, 430, 'Enies Lobby'],
  [431, 441, 'Post-Enies Lobby'],
  [442, 489, 'Thriller Bark'],
  [490, 513, 'Archipel Sabaody'],
  [514, 524, 'Amazon Lily'],
  [525, 549, 'Impel Down'],
  [550, 580, 'Marineford'],
  [581, 597, 'Après-guerre'],
  [598, 602, 'Retour à Sabaody'],
  [603, 653, 'Île des Hommes-Poissons'],
  [654, 699, 'Punk Hazard'],
  [700, 801, 'Dressrosa'],
  [802, 824, 'Zou'],
  [825, 902, 'Whole Cake Island'],
  [903, 908, 'Rêverie'],
  [909, 1057, 'Pays des Wa'],
  [1058, 1125, 'Egghead'],
  [1126, null, 'Elbaf'],
]

describe('the arc a chapter belongs to', () => {
  it('names both ends of every arc', () => {
    for (const [first, last, name] of RANGES) {
      expect(arcOf(first)?.name, `chapitre ${first}`).toBe(name)
      if (last !== null) expect(arcOf(last)?.name, `chapitre ${last}`).toBe(name)
    }
  })

  it('turns over on the chapter that opens the next arc', () => {
    // The one mistake worth a test of its own: a boundary read as inclusive on
    // the wrong side moves every arc by a chapter and nothing else looks amiss.
    expect(arcOf(217)?.name).toBe('Alabasta')
    expect(arcOf(218)?.name).toBe('Jaya')
    expect(arcOf(1057)?.name).toBe('Pays des Wa')
    expect(arcOf(1058)?.name).toBe('Egghead')
  })

  it('carries the arc’s own bounds', () => {
    const alabasta = arcOf(200)
    expect(alabasta).toEqual({ name: 'Alabasta', from: 155, to: 217 })
  })

  it('leaves the last arc open', () => {
    // The work is still coming out. An end written here would make the arc
    // stop at whatever chapter this file was last edited on.
    expect(arcOf(1126)).toEqual({ name: 'Elbaf', from: 1126, to: null })
    expect(arcOf(4000)?.name).toBe('Elbaf')
  })

  it('claims every chapter from the first one on', () => {
    for (let chapter = 1; chapter <= 1200; chapter += 1) {
      expect(arcOf(chapter), `chapitre ${chapter}`).not.toBeNull()
    }
  })

  it('names no arc for a chapter the work has none for', () => {
    // A library holding a chapter 0, or a number that is not one: nothing to
    // name, and the pages render nothing rather than the nearest guess.
    expect(arcOf(0)).toBeNull()
    expect(arcOf(-3)).toBeNull()
    expect(arcOf(Number.NaN)).toBeNull()
  })

  it('holds one contiguous run, with no hole and no overlap', () => {
    for (const [index, arc] of ARCS.entries()) {
      const next = ARCS[index + 1]
      if (next === undefined) {
        expect(arc.to).toBeNull()
        continue
      }
      expect(arc.to).toBe(next.from - 1)
    }
  })
})
