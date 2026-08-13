import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { enrichEntityImages } from '@/domains/images/index.ts'
import type { Catalogue, ImageCandidate } from '@/domains/images/types.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'
import { CANDIDATES, fakeDownload } from '../helpers/image-catalogue.ts'

/**
 * A matching rule corrected after the fact, applied to what is already stored.
 *
 * The reader who found this had « Morgan » wearing the face of « Morgans ». The
 * rule that refuses that rapprochement went into the matcher, and changed
 * nothing at all for them: the enrichment pass skips whatever already has a
 * picture, so the wrong face was never looked at again. A rule that only
 * applies to matches not yet made is a rule for new libraries.
 *
 * So this is the run that goes back over the rapprochements made on a
 * resemblance, forgets the ones today's rules refuse, and — in the same pass,
 * because an entity that has just lost its picture is an entity without one —
 * looks again.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 3, 43])
})

afterAll(async () => {
  await closeDb()
})

/**
 * The catalogue on the day the bug happened.
 *
 * onepieceapi is the only source that dates a first appearance, and it is
 * therefore the only one that can tell « Morgans » apart from « Morgan » by
 * anything other than a letter. Take its row away — a rate limit, a 503, a cold
 * start that timed out — and what is left is an undated copy of the wrong
 * character, resembling the right one at 0.8.
 */
const BEFORE: ImageCandidate[] = CANDIDATES.filter(
  (candidate) => candidate.sourceRef !== 'op-morgans',
)

/** Axe-Hand Morgan, whom AniList really does carry and onepieceapi does not. */
const REAL_MORGAN: ImageCandidate = {
  source: 'anilist',
  sourceRef: 'al-morgan',
  kind: 'character',
  names: ['Morgan', 'Axe-Hand'],
  imageUrl: 'https://example.invalid/al-morgan.png',
  pageUrl: 'https://anilist.co/character/9333',
  attribution: 'AniList',
  firstAppearanceChapter: null,
  era: 'unknown',
}

function catalogue(candidates: ImageCandidate[]): Catalogue {
  return { fetchedAt: '2026-08-13T00:00:00.000Z', candidates, failures: [] }
}

/** Never the real wiki, and never the real catalogue cache. */
function run(candidates: ImageCandidate[], recheck = false) {
  return enrichEntityImages(world.userId, {
    refresh: true,
    build: async () => catalogue(candidates),
    download: fakeDownload(),
    lookup: async () => [],
    recheck,
  })
}

async function picturesOf(entityId: string) {
  return raw<Array<{ source: string; source_ref: string; match_method: string }>>`
    SELECT source, source_ref, match_method
      FROM entity_images WHERE entity_id = ${entityId}
  `
}

/** Met in chapter 3, under that name and no other. */
async function seedMorgan(): Promise<string> {
  const entity = await createEntity(world, 'character', 3)
  await addLabel(world, entity, 'Morgan', 'true_name', 3, 100)
  return entity
}

describe('re-checking what was matched by resemblance', () => {
  it('reproduces the wrong face, then takes it away', async () => {
    const morgan = await seedMorgan()

    await run(BEFORE)
    const before = await picturesOf(morgan)
    expect(before).toHaveLength(1)
    expect(before[0]!.source_ref).toBe('al-morgans')
    expect(before[0]!.match_method).toBe('trigram')

    const report = await run(CANDIDATES, true)

    expect(report.dropped).toBe(1)
    expect(await picturesOf(morgan)).toHaveLength(0)
  })

  it('illustrates the entity again in the same run', async () => {
    const morgan = await seedMorgan()
    await run(BEFORE)

    // The right row is in the catalogue this time, under the exact name. One
    // button: the wrong picture goes, the right one arrives.
    const report = await run([...CANDIDATES, REAL_MORGAN], true)

    expect(report.dropped).toBe(1)
    expect(report.stored).toBe(1)

    const after = await picturesOf(morgan)
    expect(after).toHaveLength(1)
    expect(after[0]!.source_ref).toBe('al-morgan')
    expect(after[0]!.match_method).toBe('exact')
  })

  it('leaves a picture found by the name itself alone', async () => {
    /*
     * The rule guards a resemblance, not an identity, and the re-check must not
     * be stricter than the matcher it enforces. A page that names « Morgans »
     * names Morgans, whatever the arithmetic on chapters says.
     */
    const journalist = await createEntity(world, 'character', 1)
    await addLabel(world, journalist, 'Morgans', 'true_name', 1, 100)

    await run(CANDIDATES)
    expect(await picturesOf(journalist)).toHaveLength(1)

    const report = await run(CANDIDATES, true)

    expect(report.dropped).toBe(0)
    const kept = await picturesOf(journalist)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.source_ref).toBe('op-morgans')
    expect(kept[0]!.match_method).toBe('exact')
  })

  it('takes nothing away while a source is unreachable', async () => {
    /*
     * Not being able to look a candidate up is not evidence against it. A
     * re-check made on a thin catalogue would otherwise read an outage as a
     * verdict and empty the library.
     */
    const morgan = await seedMorgan()
    await run(BEFORE)

    const report = await run([], true)

    expect(report.dropped).toBe(0)
    expect(await picturesOf(morgan)).toHaveLength(1)
  })

  it('does nothing at all unless it is asked to', async () => {
    // The ordinary pass, and the automatic one behind it, never delete. The
    // wrong face survives a run that was not asked to re-check.
    const morgan = await seedMorgan()
    await run(BEFORE)

    const report = await run(CANDIDATES)

    expect(report.dropped).toBe(0)
    expect(await picturesOf(morgan)).toHaveLength(1)
  })
})
