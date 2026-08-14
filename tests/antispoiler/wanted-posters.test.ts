import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { postersFor } from '@/domains/images/posters.ts'
import { displayImages } from '@/domains/images/index.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Une prime ne se lit jamais en avance.
 *
 * A wanted poster is the densest spoiler this work has: a face two years older
 * than the reader knows, an epithet the story has not given yet, and a number
 * that is the whole measure of how far a character has come. Chapter 96 puts
 * thirty million on Luffy and chapter 1053 puts three billion; showing the
 * second to somebody reading the first tells them how it goes.
 *
 * The protection is not new code, and that is the point of this file. A poster
 * is a row in `entity_images` dated by the chapter that shows it, and the
 * policy written in 0012 and tightened in 0022 already refuses a picture from
 * beyond the boundary. What is tested here is that posters really do go through
 * it: that the date on the row is the manifest's chapter, that the newest
 * *visible* printing is the one shown, and that none of this leaks into the
 * portrait path, which answers a different question.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 96, 435, 801, 1053])
})

afterAll(async () => {
  await closeDb()
})

/** A poster row, written the way the enrichment writes one. */
async function addPoster(
  entityId: string,
  label: string,
  chapter: number,
  file: string,
): Promise<void> {
  await raw`
    INSERT INTO entity_images (
      user_id, entity_id, source, source_ref, source_url, attribution,
      storage_key, thumb_key, width, height, mime, bytes,
      matched_label, match_method, match_score, revealed_in_chapter, era,
      kind, is_primary
    ) VALUES (
      ${world.userId}, ${entityId}, 'fandom', ${`bounty:File:${file}`},
      ${`https://onepiece.fandom.com/wiki/File:${file}`}, 'onepiece.fandom.com',
      ${`${world.userId}/entities/${entityId}/full/${file}.webp`},
      ${`${world.userId}/entities/${entityId}/thumb/${file}.webp`},
      512, 800, 'image/webp', 1000,
      ${label}, 'bounty-manifest', 1, ${chapter}, 'unknown', 'poster', false
    )
  `
}

/** Luffy, with the three printings the gallery can actually resolve. */
async function seedLuffy(): Promise<string> {
  const luffy = await createEntity(world, 'character', 1)
  await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
  await addPoster(luffy, 'Monkey D. Luffy', 601, 'Luffy Wanted Poster.png')
  await addPoster(luffy, 'Monkey D. Luffy', 903, "Monkey D. Luffy's Sixth Wanted Poster.png")
  await addPoster(luffy, 'Monkey D. Luffy', 1053, "Monkey D. Luffy's Seventh Wanted Poster.png")
  return luffy
}

describe('un avis de recherche est daté comme tout le reste', () => {
  it('n’apparaît pas avant le chapitre qui le montre', async () => {
    const luffy = await seedLuffy()
    const labels = new Map([[luffy, 'Monkey D. Luffy']])

    // Chapter 600: the story has shown a wanted poster of Luffy three times by
    // now, and the wiki has a file for none of them. Nothing is invented to
    // fill the gap.
    const early = await postersFor(world.userId, 600, [luffy], labels)
    expect(early.size).toBe(0)
  })

  it('montre le dernier tirage que le lecteur a lu, jamais le suivant', async () => {
    const luffy = await seedLuffy()
    const labels = new Map([[luffy, 'Monkey D. Luffy']])

    const atSeven = await postersFor(world.userId, 700, [luffy], labels)
    expect(atSeven.get(luffy)?.chapter).toBe(601)
    expect(atSeven.get(luffy)?.amount).toBe(400_000_000)

    const atNine = await postersFor(world.userId, 950, [luffy], labels)
    expect(atNine.get(luffy)?.chapter).toBe(903)
    expect(atNine.get(luffy)?.amount).toBe(1_500_000_000)

    const atEnd = await postersFor(world.userId, 1100, [luffy], labels)
    expect(atEnd.get(luffy)?.chapter).toBe(1053)
    expect(atEnd.get(luffy)?.amount).toBe(3_000_000_000)
  })

  /*
   * The figure and the picture come from the same row, and this is the test
   * that says so.
   *
   * They did not, once: the amount was looked up at the *reader's* chapter
   * while the picture came from the newest printing the wiki had a file for,
   * and Chopper's fifty-berry poster went out with « 1 000 ฿ » printed under
   * it. The gallery is incomplete by nature, so the two will keep diverging;
   * the number has to follow the paper.
   */
  it('affiche la somme imprimée sur l’affiche, pas celle du chapitre du lecteur', async () => {
    const chopper = await createEntity(world, 'character', 1)
    await addLabel(world, chopper, 'Tony Tony Chopper', 'true_name', 1, 100)
    // The reader is at 1100, where Chopper is wanted for a thousand berries.
    // The newest picture anybody has of him is the hundred-berry printing.
    await addPoster(chopper, 'Tony Tony Chopper', 801, "Tony Tony Chopper's Second Wanted Poster.png")

    const shown = await postersFor(
      world.userId,
      1100,
      [chopper],
      new Map([[chopper, 'Tony Tony Chopper']]),
    )
    expect(shown.get(chopper)?.amount).toBe(100)
    expect(shown.get(chopper)?.chapter).toBe(801)
  })

  it('ne dit rien d’un personnage que le manifeste ne connaît pas', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'un villageois sans nom', 'placeholder', 1, 10)
    await addPoster(stranger, 'un villageois sans nom', 1, 'Rien.png')

    const shown = await postersFor(
      world.userId,
      1100,
      [stranger],
      new Map([[stranger, 'un villageois sans nom']]),
    )
    // A row with no bounty behind it has no number to print, so it is not a
    // poster this page can show.
    expect(shown.size).toBe(0)
  })

  /*
   * The two paths answer different questions and must not answer each other's.
   * A poster in the portrait slot would put a document where a face goes, and
   * would do it at whatever chapter the portrait rules allow rather than at the
   * chapter the poster is dated to.
   */
  it('n’est jamais servi comme portrait', async () => {
    const luffy = await seedLuffy()
    const portraits = await displayImages(world.userId, 1100, [luffy])
    expect(portraits.size).toBe(0)
  })
})
