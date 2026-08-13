import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ECHO_TOO_CLOSE, ECHO_WORTH_SHOWING, findEcho } from '@/domains/review/echoes.ts'
import { OCCURRENCE_TYPES } from '@/domains/knowledge/ontology.ts'
import { withIngest } from '@/db/boundary.ts'
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
 * The same scene, written twice.
 *
 * A chapter processed a second time produces a second run, and a model does not
 * phrase a scene identically twice. Neither exact check could see the pair —
 * `duplicates.ts` groups within one run and word for word, `exactTwin` compares
 * normalised labels — so both copies published, and the chronology showed
 * Kuina's death twice with two different endings.
 *
 * The two thresholds are the point of this suite. The pair that started it sits
 * between them on purpose: close enough to show the reviewer, not close enough
 * for the software to decide, because « le lendemain » is real information and
 * only a reader can say whether it makes two memories or one.
 */

const STORED =
  'Kuina meurt en tombant dans les escaliers ; Zoro obtient son sabre et jure de ' +
  'réaliser leur rêve à sa place.'

const REPHRASED =
  'Kuina meurt en tombant dans les escaliers le lendemain ; Zoro obtient son sabre ' +
  'et jure d’honorer leur promesse à sa place.'

const NEARLY_IDENTICAL =
  'Luffy traîne Hermep dans la base pour trouver le sabre de Zoro et l’utilise ' +
  'comme bouclier humain face aux Marines.'

const STORED_LUFFY =
  'Luffy traîne Hermep dans la base pour trouver le sabre de Zoro et l’utilise ' +
  'comme bouclier humain.'

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])
})

afterAll(async () => {
  await closeDb()
})

/** An event as publication writes one: an entity whose label is its summary. */
async function storeEvent(summary: string, chapter: number): Promise<string> {
  const id = await createEntity(world, 'event', chapter)
  await addLabel(world, id, summary.slice(0, 200), 'alias', chapter, 10)
  await raw`
    INSERT INTO events (entity_id, user_id, work_id, summary, shown_in_chapter)
    VALUES (${id}, ${world.userId}, ${world.workId}, ${summary}, ${chapter})
  `
  return id
}

function look(text: string, chapterNumber = 5) {
  return withIngest((db) =>
    findEcho(db, {
      workId: world.workId,
      userId: world.userId,
      nodeTypes: OCCURRENCE_TYPES,
      text,
      chapterNumber,
    }),
  )
}

describe('an event already in the graph', () => {
  it('is found again through a rephrasing', async () => {
    await storeEvent(STORED, 5)

    const echo = await look(REPHRASED)

    expect(echo).not.toBeNull()
    expect(echo?.label).toBe(STORED)
    expect(echo?.chapterNumber).toBe(5)
    expect(echo?.overlap).toBeGreaterThanOrEqual(ECHO_WORTH_SHOWING)
  })

  it('is shown to the reviewer without deciding for them', async () => {
    // The case that started this. « le lendemain » and a different verb for the
    // same promise: worth a glance, not worth a refusal.
    await storeEvent(STORED, 5)

    const echo = await look(REPHRASED)

    expect(echo!.overlap).toBeLessThan(ECHO_TOO_CLOSE)
  })

  it('is refused when the second version only adds a few words', async () => {
    await storeEvent(STORED_LUFFY, 5)

    const echo = await look(NEARLY_IDENTICAL)

    expect(echo!.overlap).toBeGreaterThanOrEqual(ECHO_TOO_CLOSE)
  })

  it('is refused when the second version only adds an adverb', async () => {
    await storeEvent('Zoro accepte de rejoindre l’équipage de Luffy.', 5)

    const echo = await look('Zoro accepte finalement de rejoindre l’équipage de Luffy.')

    expect(echo!.overlap).toBeGreaterThanOrEqual(ECHO_TOO_CLOSE)
  })

  it('scores a sentence by its words, not by its full stops', async () => {
    // « humain. » not matching « humain » cost a tenth of the score on the pair
    // this was written for, which was the difference between refusing and not.
    await storeEvent(STORED_LUFFY, 5)

    expect((await look(NEARLY_IDENTICAL))!.overlap).toBeGreaterThan(0.8)
  })
})

describe('what must not be called an echo', () => {
  it('a different scene sharing its cast', async () => {
    await storeEvent('Zoro affronte Morgan sur la place de la base.', 5)

    expect(await look('Zoro promet à Koby de le revoir un jour à Loguetown.')).toBeNull()
  })

  it('an event the reader has not reached', async () => {
    // Revealed at chapter 9, looked for while reviewing chapter 5: a resemblance
    // reported here would be a future chapter explaining a present one.
    await storeEvent(STORED, 9)

    expect(await look(REPHRASED, 5)).toBeNull()
  })

  it('an event of another reader’s library', async () => {
    const stranger = await seedWorld([])
    const id = randomUUID()
    await raw`
      INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
      VALUES (${id}, ${stranger.workId}, ${stranger.userId}, 'event', 5, 'accepted')
    `
    await addLabel(stranger, id, STORED, 'alias', 5, 10)

    expect(await look(REPHRASED)).toBeNull()
  })
})
