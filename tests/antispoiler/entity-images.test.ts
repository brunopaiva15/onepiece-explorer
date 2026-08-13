import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  enrichEntityImages,
  imageCoverage,
  imagesFor,
} from '@/domains/images/index.ts'
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
 * A portrait must not arrive before its name.
 *
 * External illustrations are the first thing in this product that comes from
 * outside the imported chapters, so they are the first thing that could carry a
 * spoiler in from outside — and the leak is subtler than it looks.
 *
 * A picture is found by matching a *label* against a catalogue. At chapter 1 a
 * character is "l'homme au tablier de cuir" and matches nothing; at chapter 3
 * the story names him and suddenly he matches. Attaching that portrait to the
 * entity and showing it from chapter 1 would put a face in front of the reader
 * that was located *because* of a name they do not have yet. Not a caption, not
 * a fact — a face, which is the most convincing thing an interface can show.
 *
 * So the rule enforced here: an image is visible from the revelation chapter of
 * the label that found it, and the database is what enforces it.
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

/** The ferryman: a description at chapter 1, a name at chapter 3. */
async function seedLateName(): Promise<string> {
  const entity = await createEntity(world, 'character', 1)
  await addLabel(world, entity, "l'homme au tablier de cuir", 'placeholder', 1, 10)
  await addLabel(world, entity, 'Roronoa Zoro', 'true_name', 3, 100)
  return entity
}

async function enrich() {
  return enrichEntityImages(world.userId, {
    offline: true,
    download: fakeDownload(),
  })
}

describe('an illustration appears with the name that found it', () => {
  it('is invisible before the chapter that reveals the matching label', async () => {
    const entity = await seedLateName()
    const report = await enrich()
    expect(report.stored).toBe(1)

    // The picture exists in the table.
    const [stored] = await raw<Array<{ revealed_in_chapter: number; matched_label: string }>>`
      SELECT revealed_in_chapter, matched_label FROM entity_images
    `
    expect(stored?.matched_label).toBe('Roronoa Zoro')
    expect(stored?.revealed_in_chapter).toBe(3)

    // And it is not readable at chapter 1 or 2, where the reader has only the
    // description. This is the assertion the whole feature turns on.
    expect((await imagesFor(world.userId, 1, [entity])).size).toBe(0)
    expect((await imagesFor(world.userId, 2, [entity])).size).toBe(0)
    expect((await imagesFor(world.userId, 3, [entity])).size).toBe(1)
  })

  it('is refused outside withBoundary, not merely unfiltered', async () => {
    const entity = await seedLateName()
    await enrich()

    // The row is really there, as the ingestion role wrote it.
    const [stored] = await raw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM entity_images WHERE entity_id = ${entity}
    `
    expect(stored?.n).toBe(1)

    /*
     * The same defence every other table has. A session that authenticates but
     * never declares a boundary must see nothing rather than everything:
     * `app.boundary()` answers -1 when unset, so the policy fails closed.
     */
    const leaked = await raw.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims',
        ${JSON.stringify({ sub: world.userId, role: 'authenticated' })}, true)`
      await tx`SET LOCAL ROLE authenticated`
      return tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM entity_images WHERE entity_id = ${entity}
      `
    })
    expect(leaked[0]?.n).toBe(0)
  })

  it('shows nothing at all at boundary zero', async () => {
    const entity = await seedLateName()
    await enrich()
    expect((await imagesFor(world.userId, 0, [entity])).size).toBe(0)
  })

  it('is invisible to another reader whatever their boundary', async () => {
    const entity = await seedLateName()
    await enrich()

    const stranger = await seedWorld([1])
    expect((await imagesFor(stranger.userId, 9_999, [entity])).size).toBe(0)
  })
})

describe('enrichment is safe to re-run', () => {
  it('does not attach the same picture twice', async () => {
    const entity = await seedLateName()

    const first = await enrich()
    expect(first.stored).toBe(1)

    // Second pass: the entity already has a picture, so it is not even
    // considered. A re-run fills gaps rather than redoing work.
    const second = await enrich()
    expect(second.considered).toBe(0)
    expect(second.stored).toBe(0)

    const [count] = await raw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM entity_images WHERE entity_id = ${entity}
    `
    expect(count?.n).toBe(1)
  })

  it('keeps exactly one primary picture per entity', async () => {
    const entity = await seedLateName()
    await enrich()

    // Re-examining an illustrated entity may find an alternate from another
    // catalogue. It must become an alternate, never a second primary — two
    // primaries would make the displayed portrait depend on row order.
    await enrichEntityImages(world.userId, {
      offline: true,
      download: fakeDownload(),
      includeIllustrated: true,
    })

    const [primaries] = await raw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM entity_images
      WHERE entity_id = ${entity} AND is_primary
    `
    expect(primaries?.n).toBe(1)
  })
})

describe('what enrichment refuses to do', () => {
  it('leaves an entity with no plausible candidate alone', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'la silhouette au foulard', 'placeholder', 1, 10)

    const report = await enrich()
    expect(report.stored).toBe(0)
    expect(report.unmatched).toBe(1)
    expect(report.failures).toEqual([])
    expect((await imagesFor(world.userId, 9_999, [entity])).size).toBe(0)
  })

  it('does not consider a node type nothing can illustrate', async () => {
    const concept = await createEntity(world, 'concept', 1)
    await addLabel(world, concept, 'Le One Piece', 'true_name', 1, 100)

    /*
     * Not "unmatched" — not looked at. Counting it as a miss would make the
     * coverage figure permanently and misleadingly incomplete.
     *
     * `enrich()` runs offline, which now also switches off the wiki fallback,
     * and offline is the condition under which nothing can illustrate a
     * concept: the four catalogue kinds do not cover one. With the wiki
     * reachable this same entity *is* considered, and tests/images covers that.
     */
    const report = await enrich()
    expect(report.considered).toBe(0)
  })

  it('never writes an assertion or an evidence row', async () => {
    await seedLateName()
    await enrich()

    /*
     * The line that must not blur. An illustration is not knowledge: it proves
     * nothing, and no fact may rest on one. If enrichment ever started writing
     * assertions, the product's central claim — everything here came from your
     * pages — would quietly stop being true.
     */
    const [assertions] = await raw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM assertions`
    const [evidence] = await raw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM evidence`
    expect(assertions?.n).toBe(0)
    expect(evidence?.n).toBe(0)
  })

  it('reports coverage per node type', async () => {
    await seedLateName()
    const unnamed = await createEntity(world, 'character', 1)
    await addLabel(world, unnamed, 'la silhouette au foulard', 'placeholder', 1, 10)

    await enrich()

    const coverage = await imageCoverage(world.userId)
    const characters = coverage.find((line) => line.nodeType === 'character')
    expect(characters).toEqual({ nodeType: 'character', total: 2, illustrated: 1 })
  })
})

describe('a missing catalogue is an error, not an empty result', () => {
  it('refuses to run offline with no cache rather than reporting zero matches', async () => {
    await seedLateName()
    process.env.IMAGE_CATALOGUE_PATH = '/nonexistent/catalogue.json'

    // "0 illustrations found" and "the catalogue was never downloaded" look
    // identical in a report and mean completely different things.
    await expect(enrich()).rejects.toThrow(/catalogue/i)
  })
})
