import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getChronology } from '@/domains/temporal/chronology.ts'
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
 * The axis of the story's own time.
 *
 * Three things are being pinned, and the second one is the one that used to be
 * missing entirely.
 *
 * A scene the chapter dates has a coordinate. A scene the chapter calls a
 * memory has a *position* — before the present — even with no number attached,
 * and that position is real information the old page threw into a bin labelled
 * « sans position connue ». Everything else is the present of the story.
 *
 * And the boundary is not bypassed to do any of it. The page reads at the
 * library's ceiling rather than at the reader's cursor, which is a different
 * argument to the same policy: nothing outside the library can appear, and a
 * chapter that has not been imported is not readable at any ceiling.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 5, 40])
})

afterAll(async () => {
  await closeDb()
})

async function storeEvent(
  summary: string,
  chapter: number,
  options: {
    flashback?: boolean
    storyTime?: unknown
    recordedAt?: string
  } = {},
): Promise<string> {
  const id = await createEntity(world, 'event', chapter)
  await addLabel(world, id, summary, 'alias', chapter, 10)
  await raw`
    INSERT INTO events (
      entity_id, user_id, work_id, summary, shown_in_chapter,
      is_flashback, story_time, created_at
    )
    VALUES (
      ${id}, ${world.userId}, ${world.workId}, ${summary}, ${chapter},
      ${options.flashback ?? false},
      ${options.storyTime === undefined ? null : raw.json(options.storyTime as never)},
      ${options.recordedAt ?? '2026-01-01T10:00:00Z'}
    )
  `
  return id
}

const DEPARTURE = "L'homme au foulard rayé quitte le village."
const DUEL = 'Zoro défie Kuina et perd.'
const SAILING = 'Luffy prend la mer.'

describe('a scene the chapter dates', () => {
  it('gets a coordinate, in the words the chapter used', async () => {
    await storeEvent(DEPARTURE, 5, {
      flashback: true,
      storyTime: { kind: 'approximate', description: 'dix ans plus tôt', yearsAgo: 10 },
    })

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.dated).toHaveLength(1)
    expect(chronology.dated[0]!.placement).toEqual({
      kind: 'dated',
      yearsAgo: 10,
      description: 'dix ans plus tôt',
    })
  })

  it('sorts furthest back first, whatever chapter told it', async () => {
    await storeEvent('Il y a vingt ans.', 40, {
      flashback: true,
      storyTime: { kind: 'approximate', description: 'vingt ans plus tôt', yearsAgo: 20 },
    })
    await storeEvent('Il y a cinq ans.', 1, {
      flashback: true,
      storyTime: { kind: 'approximate', description: 'cinq ans plus tôt', yearsAgo: 5 },
    })

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.dated.map((event) => event.summary)).toEqual([
      'Il y a vingt ans.',
      'Il y a cinq ans.',
    ])
  })

  it('is a distance, not a year, so an order without one is not one', async () => {
    // « avant l'exécution de Roger » places a scene relative to another scene.
    // Storing it beside a number would sort it as though somebody had counted.
    await storeEvent(DEPARTURE, 5, {
      flashback: true,
      storyTime: { kind: 'relative', note: "avant l'exécution de Roger" },
    })

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.dated).toHaveLength(0)
    expect(chronology.earlier[0]!.placement).toEqual({
      kind: 'earlier',
      description: "avant l'exécution de Roger",
    })
  })
})

describe('a memory nobody put a number on', () => {
  it('is still placed before the present', async () => {
    // The branch the old page had no name for. `is_flashback` has been recorded
    // since the schema was written; « earlier, by an amount the chapter does not
    // give » is a true statement, and it beats « position inconnue ».
    await storeEvent(DUEL, 5, { flashback: true })

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.earlier.map((event) => event.summary)).toEqual([DUEL])
    expect(chronology.earlier[0]!.placement).toEqual({ kind: 'earlier', description: null })
    expect(chronology.present).toHaveLength(0)
  })

  it('keeps the order the chapters recounted them in', async () => {
    await storeEvent('Raconté tard.', 40, { flashback: true })
    await storeEvent('Raconté tôt.', 1, { flashback: true })

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.earlier.map((event) => event.summary)).toEqual([
      'Raconté tôt.',
      'Raconté tard.',
    ])
  })
})

describe('everything else', () => {
  it('is the present of the story, in chapter order', async () => {
    await storeEvent(SAILING, 1)
    await storeEvent('Luffy arrive à Loguetown.', 40)

    const chronology = await getChronology(world.userId, 40)

    expect(chronology.present.map((event) => event.summary)).toEqual([
      SAILING,
      'Luffy arrive à Loguetown.',
    ])
    expect(chronology.dated).toHaveLength(0)
    expect(chronology.earlier).toHaveLength(0)
  })
})

describe('the ceiling', () => {
  it('is the library, so a late chapter dating an early scene is readable', async () => {
    /*
     * The reason this page does not stop at the cursor. The scene is ancient
     * and the chapter that dates it is chapter 40 — which is the normal shape
     * of a flashback, not an edge case. Read at a cursor of 5 it would be
     * absent, and the axis would be missing exactly the rows it exists for.
     */
    await storeEvent(DEPARTURE, 40, {
      flashback: true,
      storyTime: { kind: 'approximate', description: 'vingt ans plus tôt', yearsAgo: 20 },
    })

    expect((await getChronology(world.userId, 40)).dated).toHaveLength(1)
  })

  it('is still a boundary, and still refuses what is past it', async () => {
    // Not bypassed — asked a different question. A ceiling is a boundary like
    // any other, and the policy does at 5 exactly what it does anywhere.
    await storeEvent(DEPARTURE, 40, { flashback: true })

    const early = await getChronology(world.userId, 5)

    expect(early.dated).toHaveLength(0)
    expect(early.earlier).toHaveLength(0)
    expect(early.present).toHaveLength(0)
  })
})
