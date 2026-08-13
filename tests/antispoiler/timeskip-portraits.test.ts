import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { enrichEntityImages, imagesFor } from '@/domains/images/index.ts'
import type { Era } from '@/domains/images/index.ts'
import type { ImageCandidate } from '@/domains/images/types.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'
import { fakeDownload, useFixtureCatalogue } from '../helpers/image-catalogue.ts'

/**
 * A face from after the ellipse is a spoiler, and the database is what stops it.
 *
 * Two years pass between the last page of chapter 597 and the first of 598.
 * What comes back is not a redesign — it is the pay-off of the arc before it:
 * a scar across Luffy's chest, Zoro's missing eye, Franky rebuilt. Showing that
 * face to a reader forty chapters in tells them, in the most convincing form an
 * interface has, how the arc they are reading ends.
 *
 * The rule enforced here: a picture whose source dates it after the ellipse is
 * invisible below chapter 598, and a reader below it is shown the picture from
 * before it in preference to an undated one. Both halves matter — the first is
 * the spoiler, the second is the reason the feature is worth having.
 *
 * The wiki is stubbed, as it is everywhere else in the suite. What is under
 * test is what this application does with a dated picture, not whether
 * onepiece.fandom.com is up.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 3, 43])
  await useFixtureCatalogue()
})

afterAll(async () => {
  await closeDb()
})

function wikiPortrait(name: string, era: Era): ImageCandidate {
  return {
    source: 'fandom',
    sourceRef: `en:${name}#File:${name} Manga ${era} Infobox.png`,
    kind: 'page',
    names: [name],
    imageUrl: `https://static.invalid/${name}-${era}.png`,
    pageUrl: `https://onepiece.fandom.com/wiki/${name}`,
    attribution: 'onepiece.fandom.com',
    firstAppearanceChapter: null,
    era,
  }
}

/**
 * Zoro: named at chapter 3, in the fixture catalogue, and drawn very
 * differently on the two sides of the ellipse. The catalogue places him; the
 * wiki dates him.
 */
async function seedZoro(): Promise<string> {
  const entity = await createEntity(world, 'character', 1)
  await addLabel(world, entity, 'Roronoa Zoro', 'true_name', 3, 100)
  return entity
}

async function enrich(lookup: (name: string) => Promise<ImageCandidate[]>) {
  return enrichEntityImages(world.userId, {
    download: fakeDownload(),
    lookup,
  })
}

async function erasOf(entityId: string): Promise<string[]> {
  const rows = await raw<Array<{ era: string }>>`
    SELECT era FROM entity_images WHERE entity_id = ${entityId} ORDER BY era
  `
  return rows.map((row) => row.era)
}

describe('an entity keeps a face for each side of the ellipse', () => {
  it('stores both, because enrichment does not know where the reader is', async () => {
    const zoro = await seedZoro()

    const report = await enrich(async (name) =>
      name === 'Roronoa Zoro'
        ? [wikiPortrait(name, 'pre_timeskip'), wikiPortrait(name, 'post_timeskip')]
        : [],
    )

    /*
     * Three pictures for one entity: the catalogue's undated portrait, and the
     * wiki's two dated ones. Choosing between them at enrichment time would be
     * choosing for a reader whose position this code does not know — the run
     * covers the whole library at once and the reader moves afterwards.
     */
    expect(report.stored).toBe(3)
    expect(report.preTimeskip).toBe(1)
    expect(report.postTimeskip).toBe(1)
    expect(await erasOf(zoro)).toEqual(['post_timeskip', 'pre_timeskip', 'unknown'])
  })

  it('shows the one from before the ellipse to a reader who has not reached it', async () => {
    const zoro = await seedZoro()
    await enrich(async (name) => [
      wikiPortrait(name, 'pre_timeskip'),
      wikiPortrait(name, 'post_timeskip'),
    ])

    const early = (await imagesFor(world.userId, 100, [zoro])).get(zoro)
    expect(early?.era).toBe('pre_timeskip')

    // And the other one after it. Same entity, same row set, different reader.
    const late = (await imagesFor(world.userId, 900, [zoro])).get(zoro)
    expect(late?.era).toBe('post_timeskip')
  })

  it('changes hands between 597 and 598 and nowhere else', async () => {
    const zoro = await seedZoro()
    await enrich(async (name) => [
      wikiPortrait(name, 'pre_timeskip'),
      wikiPortrait(name, 'post_timeskip'),
    ])

    const at = async (chapter: number) =>
      (await imagesFor(world.userId, chapter, [zoro])).get(zoro)?.era

    expect(await at(597)).toBe('pre_timeskip')
    expect(await at(598)).toBe('post_timeskip')
  })
})

describe('what a reader before the ellipse may not see', () => {
  it('hides a post-ellipse picture even when it is the only one', async () => {
    /*
     * The case that used to leak. « Nefeltari Vivi » is not in the fixture
     * catalogue, so the wiki fallback answers — and what it hands back for a
     * character's article is the picture at the top of it today, which for
     * anyone who lived through the ellipse is the later face. Stored undated,
     * it appeared from the chapter that names her.
     *
     * The right outcome is no picture at all. An entity without one is
     * perfectly usable; nothing in the interface depends on a portrait.
     */
    const vivi = await createEntity(world, 'character', 1)
    await addLabel(world, vivi, 'Nefeltari Vivi', 'true_name', 1, 100)

    await enrich(async (name) => [wikiPortrait(name, 'post_timeskip')])

    expect(await erasOf(vivi)).toEqual(['post_timeskip'])
    expect((await imagesFor(world.userId, 597, [vivi])).size).toBe(0)
    expect((await imagesFor(world.userId, 598, [vivi])).size).toBe(1)
  })

  it('refuses it outside withBoundary, not merely unfiltered', async () => {
    const vivi = await createEntity(world, 'character', 1)
    await addLabel(world, vivi, 'Nefeltari Vivi', 'true_name', 1, 100)
    await enrich(async (name) => [wikiPortrait(name, 'post_timeskip')])

    /*
     * The same defence every other rule in this application has: it is a
     * row-level policy, not a WHERE clause someone has to remember. A session
     * that authenticates but never declares a boundary sees nothing —
     * app.boundary() answers -1 when unset, so the check fails closed.
     */
    const leaked = await raw.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims',
        ${JSON.stringify({ sub: world.userId, role: 'authenticated' })}, true)`
      await tx`SET LOCAL ROLE authenticated`
      return tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM entity_images WHERE entity_id = ${vivi}
      `
    })
    expect(leaked[0]?.n).toBe(0)
  })

  it('does not let a date override the name that found the picture', async () => {
    /*
     * The two rules compose rather than replace one another. A pre-ellipse
     * portrait is safe *for the period* and still invisible until the reader
     * has the name that located it — chapter 3 here, not chapter 1.
     */
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'la silhouette au foulard', 'placeholder', 1, 10)
    await addLabel(world, stranger, 'Roronoa Zoro', 'true_name', 3, 100)

    await enrich(async (name) =>
      name === 'Roronoa Zoro' ? [wikiPortrait(name, 'pre_timeskip')] : [],
    )

    expect((await imagesFor(world.userId, 2, [stranger])).size).toBe(0)
    expect((await imagesFor(world.userId, 3, [stranger])).get(stranger)?.era).toBe(
      'pre_timeskip',
    )
  })
})

describe('what an undated picture is still allowed to do', () => {
  it('serves both sides, because « unknown » is not « post »', async () => {
    /*
     * The three catalogues say nothing about when their portrait depicts its
     * subject. Reading that silence as "current artwork, therefore after the
     * ellipse" and hiding it would empty the graph of faces on the strength of
     * a guess — and guessing on a weak signal is the one thing this domain
     * refuses everywhere. Undated stays visible; only a picture its source
     * names as post-ellipse is withheld.
     */
    const sanji = await createEntity(world, 'character', 43)
    await addLabel(world, sanji, 'Sanji', 'true_name', 43, 100)

    await enrich(async () => [])

    expect(await erasOf(sanji)).toEqual(['unknown'])
    expect((await imagesFor(world.userId, 43, [sanji])).size).toBe(1)
    expect((await imagesFor(world.userId, 900, [sanji])).size).toBe(1)
  })

  it('is outranked by a dated one, on the side it is dated for', async () => {
    const zoro = await seedZoro()
    await enrich(async (name) => [wikiPortrait(name, 'pre_timeskip')])

    // Before the ellipse the dated picture wins; after it there is nothing
    // dated to prefer, and a portrait from before the ellipse is merely out of
    // date rather than a spoiler — so it is shown rather than withheld.
    expect((await imagesFor(world.userId, 100, [zoro])).get(zoro)?.era).toBe(
      'pre_timeskip',
    )
    expect((await imagesFor(world.userId, 900, [zoro])).get(zoro)?.era).toBe('unknown')
  })
})

describe('what the wiki is asked, and about what', () => {
  it('asks with the catalogue’s English name, not the French label', async () => {
    /*
     * The graph is written in French and the wiki files its articles in
     * English. « Barbe Blanche » finds nothing; the catalogue row that label
     * matched is called « Edward Newgate », and that finds everything. Asking
     * with the label alone would leave every French-named character undated,
     * which is most of them.
     */
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Roronoa Zoro', 'true_name', 3, 100)

    const asked: string[] = []
    await enrich(async (name) => {
      asked.push(name)
      return []
    })

    // The fixture's onepieceapi row for Zoro carries « Roronoa Zoro » and the
    // Japanese spelling; only the first is a title the English wiki could hold.
    expect(asked).toContain('Roronoa Zoro')
    expect(asked.some((name) => /[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]/u.test(name))).toBe(
      false,
    )
  })

  it('does not ask about a fruit, a ship or an island', async () => {
    /*
     * Only a person changes across the ellipse. Asking the wiki to date a Devil
     * Fruit would spend one request per entity on a question whose answer is
     * known, against a free wiki that owes us nothing.
     */
    const fruit = await createEntity(world, 'power', 1)
    await addLabel(world, fruit, 'Gum-Gum Fruit', 'true_name', 1, 100)
    const ship = await createEntity(world, 'object', 42)
    await addLabel(world, ship, 'Going Merry', 'true_name', 42, 100)

    const asked: string[] = []
    await enrich(async (name) => {
      asked.push(name)
      return []
    })

    expect(asked).toEqual([])
  })
})
