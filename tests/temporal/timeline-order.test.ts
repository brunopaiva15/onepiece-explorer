import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getTimeline } from '@/domains/temporal/timeline.ts'
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
 * Everything a chapter reveals shares one revelation number.
 *
 * Which makes the revelation axis, on its own, no order at all inside a
 * chapter: the sort had nothing left to compare, and the list fell back to
 * whatever PostgreSQL returned for a query with no ORDER BY. Chapter 5 showed
 * Kuina's death above the duel that precedes it, and nothing guaranteed it
 * would show the same arrangement twice.
 *
 * Publication order is the tie-break, and it is an approximation — it follows
 * the review queue, which follows extraction, which walks the passages in
 * order. What is being pinned here is not that the order is *right*; it is that
 * there is one, and that it is the same on every read.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 5])
})

afterAll(async () => {
  await closeDb()
})

/** An event as publication writes one, with an explicit write time. */
async function storeEvent(summary: string, chapter: number, recordedAt: string) {
  const id = await createEntity(world, 'event', chapter)
  await addLabel(world, id, summary, 'alias', chapter, 10)
  await raw`
    INSERT INTO events (entity_id, user_id, work_id, summary, shown_in_chapter, created_at)
    VALUES (${id}, ${world.userId}, ${world.workId}, ${summary}, ${chapter}, ${recordedAt})
  `
}

const DUEL = 'Zoro défie Kuina à l’arme réelle et perd.'
const DEATH = 'Kuina meurt en tombant dans les escaliers.'
const OATH = 'Zoro obtient le sabre de Kuina et jure de devenir le meilleur.'

describe('events of one chapter', () => {
  beforeEach(async () => {
    // Written in narrative order, deliberately not in alphabetical or id order.
    await storeEvent(DUEL, 5, '2026-01-01T10:00:00Z')
    await storeEvent(DEATH, 5, '2026-01-01T10:00:01Z')
    await storeEvent(OATH, 5, '2026-01-01T10:00:02Z')
  })

  it('keep the order they were recorded in', async () => {
    const timeline = await getTimeline(world.userId, 10)

    expect(timeline.byRevelation.map((entry) => entry.summary)).toEqual([DUEL, DEATH, OATH])
  })

  it('come out the same on every read', async () => {
    const first = await getTimeline(world.userId, 10)
    const second = await getTimeline(world.userId, 10)

    expect(second.byRevelation.map((e) => e.entityId)).toEqual(
      first.byRevelation.map((e) => e.entityId),
    )
  })
})

describe('the revelation axis still wins', () => {
  it('over the tie-break', async () => {
    // Recorded last, revealed first: chapter order is the axis, and the
    // tie-break must never reorder across chapters.
    await storeEvent(DEATH, 5, '2026-01-01T10:00:00Z')
    await storeEvent('Luffy quitte Fuchsia.', 1, '2026-01-01T11:00:00Z')

    const timeline = await getTimeline(world.userId, 10)

    expect(timeline.byRevelation.map((entry) => entry.knownFromChapter)).toEqual([1, 5])
  })
})

describe('a mystery', () => {
  it('is placed by the same rule', async () => {
    const id = await createEntity(world, 'mystery', 5)
    await addLabel(world, id, 'Qui était le sensei de Kuina ?', 'alias', 5, 10)
    await raw`
      INSERT INTO mysteries (entity_id, user_id, work_id, question, opened_in_chapter, created_at)
      VALUES (${id}, ${world.userId}, ${world.workId},
              'Qui était le sensei de Kuina ?', 5, ${'2026-01-01T09:00:00Z'})
    `
    await storeEvent(DEATH, 5, '2026-01-01T10:00:00Z')

    const timeline = await getTimeline(world.userId, 10)

    expect(timeline.byRevelation.map((entry) => entry.kind)).toEqual(['mystery', 'event'])
  })
})

describe('a fresh identifier', () => {
  it('does not decide the order', async () => {
    // The regression in one line: a row written later must sort later, whatever
    // its uuid happens to be. Ten pairs, because a uuid ordering that agreed
    // with insertion order by chance would pass a single one.
    for (let round = 0; round < 10; round++) {
      await resetDatabase()
      world = await seedWorld([5])
      await storeEvent(`Premier ${randomUUID()}`, 5, '2026-01-01T10:00:00Z')
      await storeEvent(`Second ${randomUUID()}`, 5, '2026-01-01T10:00:05Z')

      const timeline = await getTimeline(world.userId, 10)
      expect(timeline.byRevelation[0]!.summary!.startsWith('Premier')).toBe(true)
    }
  })
})
