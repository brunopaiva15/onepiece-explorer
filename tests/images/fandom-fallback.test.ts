import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { enrichEntityImages } from '@/domains/images/index.ts'
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

/**
 * The wiki fallback, without the wiki.
 *
 * The lookup is stubbed, as the download already was: a test that asked
 * onepiece.fandom.com whether « Partys Bar » exists would fail the day somebody
 * renames the article, and would make the suite depend on a third party's
 * uptime to check our own logic.
 */

let world: SeededWorld
let previousCatalogue: string | undefined

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2])
  /*
   * Point the cache at a path that does not exist.
   *
   * `loadCatalogue()` refuses to overwrite a good cache with an empty result —
   * three sources failing usually means the network is down, not that One Piece
   * has no characters — so a real catalogue sitting in var/cache/ would be
   * returned here and these tests would silently stop testing the empty case.
   */
  previousCatalogue = process.env.IMAGE_CATALOGUE_PATH
  process.env.IMAGE_CATALOGUE_PATH = path.join(
    tmpdir(),
    `catalogue-repli-${randomUUID()}.json`,
  )
})

afterAll(async () => {
  if (previousCatalogue === undefined) delete process.env.IMAGE_CATALOGUE_PATH
  else process.env.IMAGE_CATALOGUE_PATH = previousCatalogue
  await closeDb()
})

/** An empty catalogue, built rather than fetched. Nothing opens a socket. */
const CATALOGUE = {
  refresh: true,
  build: async () => ({
    fetchedAt: '2026-01-01',
    candidates: [],
    failures: [],
  }),
}

function wikiCandidate(title: string): ImageCandidate {
  return {
    source: 'fandom',
    sourceRef: `fr:${title}`,
    kind: 'page',
    names: [title],
    imageUrl: 'https://static.invalid/x.png',
    pageUrl: `https://onepiece.fandom.com/fr/wiki/${title}`,
    attribution: 'onepiece.fandom.com (fr)',
    firstAppearanceChapter: null,
  }
}

const stored = async () => ({
  storageKey: 'k/full.webp',
  thumbKey: 'k/thumb.webp',
  width: 300,
  height: 400,
  mime: 'image/webp' as const,
  bytes: 1234,
})

async function imagesOf(entityId: string) {
  return raw`
    SELECT source, matched_label, revealed_in_chapter, source_url
      FROM entity_images WHERE entity_id = ${entityId}
  `
}

describe('what the catalogues cannot illustrate', () => {
  it('finds a place on the wiki and records the label that found it', async () => {
    const bar = await createEntity(world, 'place', 1)
    await addLabel(world, bar, 'Partys Bar', 'true_name', 1, 100)

    const report = await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      lookup: async (name) => (name === 'Partys Bar' ? wikiCandidate(name) : null),
    })

    expect(report.fromWiki).toBe(1)
    expect(report.stored).toBe(1)

    const rows = await imagesOf(bar)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('fandom')
    expect(rows[0]!.matched_label).toBe('Partys Bar')
    expect(rows[0]!.revealed_in_chapter).toBe(1)
  })

  it('reaches node types no catalogue kind covers', async () => {
    const crew = await createEntity(world, 'group', 1)
    await addLabel(world, crew, 'Équipage du Roux', 'true_name', 1, 100)
    const race = await createEntity(world, 'species', 1)
    await addLabel(world, race, 'Roi des Mers', 'true_name', 1, 100)

    const report = await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      lookup: async (name) => wikiCandidate(name),
    })

    // Before the fallback these two were never even queued: `considered` was 0
    // and the run reported nothing at all about them.
    expect(report.considered).toBe(2)
    expect(report.fromWiki).toBe(2)
  })

  it('hides a face found by a true name until that name is revealed', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'la silhouette', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 2, 100)

    await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      // Only the true name has an article, as is usually the case.
      lookup: async (name) => (name === 'Kaelo Renn' ? wikiCandidate(name) : null),
    })

    const rows = await imagesOf(stranger)
    expect(rows[0]!.matched_label).toBe('Kaelo Renn')
    expect(rows[0]!.revealed_in_chapter).toBe(2)
  })

  it('leaves an entity alone when the wiki has no article for it', async () => {
    const vague = await createEntity(world, 'place', 1)
    await addLabel(world, vague, 'la ruelle derrière le bar', 'alias', 1, 10)

    const report = await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      lookup: async () => null,
    })

    expect(report.unmatched).toBe(1)
    expect(await imagesOf(vague)).toHaveLength(0)
  })

  it('never asks the wiki about an event or a mystery', async () => {
    const event = await createEntity(world, 'event', 1)
    await addLabel(world, event, 'La bataille du quai', 'true_name', 1, 100)
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Qui a laissé la marque ?', 'true_name', 1, 100)

    const asked: string[] = []
    await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      lookup: async (name) => {
        asked.push(name)
        return wikiCandidate(name)
      },
    })

    expect(asked).toEqual([])
  })

  it('still runs when every catalogue is down', async () => {
    /*
     * The empty-catalogue guard used to end the run before any entity was
     * examined. That was right when the catalogues were the only source, and
     * wrong the moment a fallback existed that needs none of them — the case
     * where all three are unreachable is exactly when it earns its keep.
     */
    const bar = await createEntity(world, 'place', 1)
    await addLabel(world, bar, 'Partys Bar', 'true_name', 1, 100)

    const report = await enrichEntityImages(world.userId, {
      refresh: true,
      build: async () => ({
        fetchedAt: '2026-01-01',
        candidates: [],
        failures: [
          { source: 'onepieceapi' as const, reason: 'HTTP 503' },
          { source: 'anilist' as const, reason: 'HTTP 503' },
          { source: 'api-onepiece' as const, reason: 'HTTP 503' },
        ],
      }),
      download: stored,
      lookup: async (name) => wikiCandidate(name),
    })

    expect(report.stored).toBe(1)
  })

  it('does not touch the network when the fallback is switched off', async () => {
    const bar = await createEntity(world, 'place', 1)
    await addLabel(world, bar, 'Partys Bar', 'true_name', 1, 100)

    const report = await enrichEntityImages(world.userId, {
      ...CATALOGUE,
      download: stored,
      fandom: false,
      lookup: async () => {
        throw new Error('le repli ne devait pas être appelé')
      },
    })

    expect(report.stored).toBe(0)
  })
})
