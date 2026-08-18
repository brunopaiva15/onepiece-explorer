import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { poneglyphsAtChapter } from '@/domains/temporal/spotlight.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Une pierre ne se lit jamais en avance — et le graphe non plus.
 *
 * The manifest's own dating is checked without a database in
 * `tests/temporal/poneglyphes.test.ts`: a stone, its place, the sight of it and
 * the reading of it each appear on the chapter that gives them and not before.
 * What is checked here is the half that manifest cannot do alone.
 *
 * The card carries a link into the library — « Tombeau des Rois → » — and that
 * link is built from a name the *extraction* produced, at a chapter the reader
 * may not have reached. So it goes through the boundary like everything else,
 * and the two failures worth a test are opposite: a link offered to a reader who
 * has not met the place, and a link missing for one who has.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([155, 193, 202, 203])
})

afterAll(async () => {
  await closeDb()
})

/** Alabasta, the tomb under it, and the library's own node for the stones. */
async function seedAlabasta(): Promise<{ kingdom: string; tomb: string; subject: string }> {
  const kingdom = await createEntity(world, 'place', 155)
  await addLabel(world, kingdom, 'Royaume d’Alabasta', 'true_name', 155, 100)

  /* The tomb is a place of chapter 202: Cobra takes Robin down the hidden
     staircase there, and no earlier chapter names it. */
  const tomb = await createEntity(world, 'place', 202)
  await addLabel(world, tomb, 'Tombeau des Rois', 'true_name', 202, 100)

  const subject = await createEntity(world, 'object', 193)
  await addLabel(world, subject, 'Ponéglyphe', 'true_name', 193, 100)

  return { kingdom, tomb, subject }
}

describe('les ponéglyphes d’un lecteur, au chapitre où il en est', () => {
  it('n’en montre aucun avant que l’œuvre en parle', async () => {
    await seedAlabasta()
    const watch = await poneglyphsAtChapter(world.userId, 192)
    expect(watch.stones).toEqual([])
    /* And no subject either: the entity exists in the library, at a chapter the
       reader has not reached. */
    expect(watch.node).toBeNull()
  })

  it('nomme le royaume au chapitre 193 et le tombeau au 202', async () => {
    const { kingdom, tomb } = await seedAlabasta()

    const early = await poneglyphsAtChapter(world.userId, 193)
    expect(early.stones).toHaveLength(1)
    expect(early.stones[0]!.where).toBe('Royaume d’Alabasta')
    expect(early.stones[0]!.place?.entityId).toBe(kingdom)
    /* The stone is on the page at 202 and read at 203. Neither may be dated
       here, because neither has happened to this reader. */
    expect(early.stones[0]!.seen).toBeNull()
    expect(early.stones[0]!.read).toBeNull()

    const later = await poneglyphsAtChapter(world.userId, 202)
    expect(later.stones[0]!.where).toBe('Tombeau des Rois, sous Alubarna')
    expect(later.stones[0]!.place?.entityId).toBe(tomb)
    expect(later.stones[0]!.seen).toBe(202)
    expect(later.stones[0]!.read).toBeNull()

    const read = await poneglyphsAtChapter(world.userId, 203)
    expect(read.stones[0]!.read).toBe(203)
  })

  it('ne propose pas un lieu que le lecteur n’a pas rencontré', async () => {
    /*
     * The tomb exists in this library and is revealed at 202. A reader at 195
     * is told the stone is somewhere in Alabasta — which is what chapter 193
     * gave them — and the card has nowhere else to send them.
     */
    const { kingdom } = await seedAlabasta()
    const watch = await poneglyphsAtChapter(world.userId, 195)
    expect(watch.stones[0]!.place?.entityId).toBe(kingdom)
    expect(watch.stones[0]!.where).toBe('Royaume d’Alabasta')
  })

  it('nomme la pierre sans lien quand la bibliothèque n’a pas le lieu', async () => {
    /*
     * An empty library still knows what the work says. The card names the tomb
     * because chapter 202 does; the link is the part that depends on what was
     * imported, and its absence costs the reader nothing but a click.
     */
    const watch = await poneglyphsAtChapter(world.userId, 202)
    expect(watch.stones).toHaveLength(1)
    expect(watch.stones[0]!.where).toBe('Tombeau des Rois, sous Alubarna')
    expect(watch.stones[0]!.place).toBeNull()
    expect(watch.node).toBeNull()
  })

  it('rattache la section au nœud « Ponéglyphe » du graphe', async () => {
    const { subject } = await seedAlabasta()
    const watch = await poneglyphsAtChapter(world.userId, 193)
    expect(watch.node?.entityId).toBe(subject)
  })

  it('ne compte les pierres du monde qu’une fois qu’on les a comptées devant lui', async () => {
    await seedAlabasta()
    const watch = await poneglyphsAtChapter(world.userId, 203)
    expect(watch.roads).toBeNull()
    expect(watch.total).toBeNull()
    /* Inuarashi says « quatre » at 818 and Tamago « trente » at 846. A reader of
       Alabasta holding one stone must not be told how many are missing. */
    expect(watch.stones.every((stone) => stone.road === false)).toBe(true)
  })
})
