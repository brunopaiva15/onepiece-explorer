import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { postersFor, wantedAtChapter } from '@/domains/images/posters.ts'
import { displayImages } from '@/domains/images/index.ts'
import { castAtChapter, castOf } from '@/domains/temporal/spotlight.ts'
import {
  addAssertion,
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

/**
 * Qui est recherché, et par quel bout on le demande.
 *
 * The home page has asked this wrongly twice, and each answer threw away part
 * of the wall:
 *
 *   **By rank.** The sixty best-connected characters, filtered to those with a
 *   poster. Higuma carries the first bounty in One Piece and three lines of
 *   dialogue, so he was never in the pool to be filtered.
 *
 *   **By picture.** Everybody with a stored poster, which reads as the whole
 *   answer and is the intersection of « wanted » and « photographed ». The wiki
 *   has a file for about a quarter of the printings the manifest knows, so
 *   Brogy — a hundred million on the page at chapter 118, no picture of it
 *   anywhere — was missing from the wall of a reader who had just read it.
 *
 * The question is now the reader's own: who do I know a bounty for. These tests
 * pin that, and pin the two things it must not become — a wall that invents a
 * bounty for somebody who has none, and a wall that shows one early.
 */
describe('le mur part des primes connues, pas du classement ni des images', () => {
  /** A bandit with a poster, a name and no relations whatsoever. */
  async function seedHiguma(): Promise<string> {
    const higuma = await createEntity(world, 'character', 1)
    await addLabel(world, higuma, 'Higuma', 'true_name', 1, 100)
    await addPoster(higuma, 'Higuma', 1, 'Higuma Bounty Poster.png')
    return higuma
  }

  it('trouve un personnage qu’aucun classement par degré ne remonterait', async () => {
    const higuma = await seedHiguma()
    // Somebody with relations, so the ranking has something to prefer.
    await seedLuffy()

    const wanted = await wantedAtChapter(world.userId, 1100)
    expect(wanted.has(higuma)).toBe(true)

    // And the cast built from that list holds him with his name, which the
    // degree-ranked pool is free never to have heard of.
    const cast = await castOf(world.userId, 1100, [...wanted.keys()])
    expect(cast.find((member) => member.memberIds.includes(higuma))?.label).toBe('Higuma')
  })

  /*
   * Le chapitre 118, tel qu'il a été signalé.
   *
   * Brogy is worth a hundred million at Little Garden and the wiki has no
   * picture of that poster: the one file that names him shows the printing of
   * chapter 1130, and the one that shows both giants is an anime frame with no
   * figure on it. Under the picture-first wall he was simply absent, which told
   * a reader of chapter 118 that the bounty they had just read did not exist.
   */
  it('affiche une prime que personne n’a jamais photographiée', async () => {
    const brogy = await createEntity(world, 'character', 118)
    await addLabel(world, brogy, 'Brogy', 'true_name', 118, 100)

    const wanted = await wantedAtChapter(world.userId, 187)
    expect(wanted.get(brogy)?.amount).toBe(100_000_000)
    expect(wanted.get(brogy)?.chapter).toBe(118)

    // And no picture is conjured to go with it: the page shows the character.
    const posters = await postersFor(world.userId, 187, [brogy], new Map([[brogy, 'Brogy']]))
    expect(posters.size).toBe(0)
  })

  /*
   * The bounty is the manga's and the drawing is the anime's, and the site
   * shows the first without the second. The picture stays in the library —
   * nothing deletes it — and the manifest decides at read time that it does not
   * reach a page, so the rule holds for libraries enriched before the decision.
   */
  it('donne le montant sans l’affiche quand l’image vient de l’anime', async () => {
    const higuma = await seedHiguma()

    const wanted = await wantedAtChapter(world.userId, 187)
    expect(wanted.get(higuma)?.amount).toBe(8_000_000)

    const posters = await postersFor(world.userId, 187, [higuma], new Map([[higuma, 'Higuma']]))
    expect(posters.size).toBe(0)

    // The row was never removed; it is the reading that refuses it.
    const held = await raw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM entity_images
      WHERE entity_id = ${higuma} AND kind = 'poster'
    `
    expect(held[0]?.n).toBe(1)
  })

  it('s’arrête au chapitre du lecteur, comme la lecture des affiches', async () => {
    await seedHiguma()
    const luffy = await seedLuffy()

    // Chapter 1 shows Higuma's eight million. Luffy is not wanted for anything
    // until chapter 96, whatever the library holds a picture of.
    expect((await wantedAtChapter(world.userId, 1)).has(luffy)).toBe(false)
    expect((await wantedAtChapter(world.userId, 700)).has(luffy)).toBe(true)
  })

  /*
   * The figure follows the reader, and stops at them. Luffy is worth thirty
   * million from 96, four hundred from 601 and three billion from 1053, and the
   * wall must never be one printing ahead of the person reading it.
   */
  it('ne montre jamais le tirage suivant', async () => {
    const luffy = await seedLuffy()

    expect((await wantedAtChapter(world.userId, 96)).get(luffy)?.amount).toBe(30_000_000)
    expect((await wantedAtChapter(world.userId, 600)).get(luffy)?.amount).toBe(300_000_000)
    expect((await wantedAtChapter(world.userId, 700)).get(luffy)?.amount).toBe(400_000_000)
    expect((await wantedAtChapter(world.userId, 1100)).get(luffy)?.amount).toBe(3_000_000_000)
  })

  /*
   * A name the reader has not been told cannot put anybody on the wall. The
   * labels are read inside the boundary, so an entity known here only as « le
   * bandit » matches no manifest line and carries no bounty — which is the
   * conservative half of the same rule that dates everything else.
   */
  it('ne reconnaît pas un personnage dont le nom n’est pas encore révélé', async () => {
    const higuma = await createEntity(world, 'character', 1)
    await addLabel(world, higuma, 'un bandit des montagnes', 'placeholder', 1, 10)
    await addLabel(world, higuma, 'Higuma', 'true_name', 96, 100)

    expect((await wantedAtChapter(world.userId, 10)).has(higuma)).toBe(false)
    expect((await wantedAtChapter(world.userId, 96)).get(higuma)?.amount).toBe(8_000_000)
  })

  /*
   * Le chapitre 124, tel qu'il a été signalé.
   *
   * The whole bug in one library. A reader at 124 has read six wanted posters,
   * and the wall showed three of them: Krieg, Buggy and Arlong, all of whom
   * carry an arc's worth of relations. Higuma has one. The assertions below are
   * what the old ranking read, and they are stacked deliberately so that a pool
   * of two would have had no room for him.
   */
  it('garde le bandit du chapitre 1 devant les capitaines du chapitre 96', async () => {
    const higuma = await createEntity(world, 'character', 1)
    await addLabel(world, higuma, 'Higuma', 'true_name', 1, 100)
    await addPoster(higuma, 'Higuma', 1, 'Higuma Bounty Poster.png')

    const connected: string[] = []
    for (const [name, chapter] of [
      ['Arlong', 69],
      ['Don Krieg', 96],
      ['Buggy', 96],
    ] as const) {
      const id = await createEntity(world, 'character', 1)
      await addLabel(world, id, name, 'true_name', 1, 100)
      await addPoster(id, name, chapter, `${name} Wanted Poster.png`)
      connected.push(id)
    }

    // Everything the ranking counts, given to everyone except the bandit.
    for (const subject of connected) {
      for (const object of connected) {
        if (subject === object) continue
        await addAssertion(world, {
          subject,
          predicate: 'enemy_of',
          object,
          knowledgeFrom: 1,
        })
      }
    }

    const wanted = await wantedAtChapter(world.userId, 124)
    expect(wanted.get(higuma)?.amount).toBe(8_000_000)

    // And the ranking really would have buried him: asked for the two best
    // connected characters, the old pool holds none of the reader's bandits.
    const podium = await castAtChapter(world.userId, 124, { pool: 2 })
    expect(podium.some((member) => member.memberIds.includes(higuma))).toBe(false)

    // The wall keeps him because it is built from the bounties, in any order.
    const cast = await castOf(world.userId, 124, [...wanted.keys()])
    expect(cast.some((member) => member.memberIds.includes(higuma))).toBe(true)

    /*
     * Three of the four carry a picture: Higuma's is the anime's drawing of the
     * poster, so his card is the bandit's face and his eight million rather
     * than a rendering no chapter printed.
     */
    const posters = await postersFor(
      world.userId,
      124,
      cast.flatMap((member) => member.memberIds),
      new Map(cast.map((member) => [member.entityId, member.label])),
    )
    expect(posters.has(higuma)).toBe(false)
    expect(posters.size).toBe(3)
  })

  it('ne rend rien quand le manifeste ne connaît personne de la bibliothèque', async () => {
    const nobody = await createEntity(world, 'character', 1)
    await addLabel(world, nobody, 'Makino', 'true_name', 1, 100)

    expect(await wantedAtChapter(world.userId, 1100)).toEqual(new Map())
    // The page falls through to faces, and the pool for those is unchanged.
    expect(await castOf(world.userId, 1100, [])).toEqual([])
    expect((await castAtChapter(world.userId, 1100)).length).toBeGreaterThan(0)
  })
})
