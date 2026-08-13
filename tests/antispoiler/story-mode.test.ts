import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getStoryPage, type BeatKind, type StoryPage } from '@/domains/temporal/story.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Story mode reads several chapters at once. That is the danger.
 *
 * Every other read in this application asks for one moment and gets one
 * boundary. A stretch of thread covering chapters 1 to 6 is six moments in one
 * response, and the cheap way to build it — read once at chapter 6, sort into
 * beads afterwards — produces a thread that looks perfect and lies on every
 * bead before the last: chapter 1 introducing a character by a name revealed in
 * chapter 5, a face shown beside someone the reader has not met.
 *
 * That failure is invisible in a library seeded with one chapter, invisible in
 * a screenshot, and invisible to anyone who already knows the story. So it is
 * pinned here, with the blocking scenarios.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 4, 5])
})

afterAll(async () => {
  await closeDb()
})

function at(page: StoryPage, chapter: number, kind: BeatKind) {
  return page.beats.filter(
    (beat) => beat.chapter === chapter && beat.kind === kind,
  )
}

async function read(from: number, count: number, ceiling: number) {
  return getStoryPage(world.userId, world.workId, { from, count, ceiling })
}

describe('no bead borrows a later chapter’s knowledge', () => {
  it('leaves a character unnamed on the chapter where they were unnamed', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'l’homme au tablier de cuir', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 3, 100)

    const page = await read(1, 5, 5)

    const walkOn = at(page, 1, 'entree').find((b) => b.entityId === stranger)
    expect(walkOn).toBeDefined()
    expect(walkOn!.text).toBe('l’homme au tablier de cuir')

    // And the true name lands exactly once, on the chapter that reveals it.
    const named = at(page, 3, 'nom')
    expect(named).toHaveLength(1)
    expect(named[0]!.text).toBe('Kaelo Renn')
    expect(named[0]!.detail).toBe('l’homme au tablier de cuir')
  })

  it('names an event with the name it had at the chapter that told it', async () => {
    const battle = await createEntity(world, 'event', 2)
    await addLabel(world, battle, 'l’incident du village', 'alias', 2, 10)
    await addLabel(world, battle, 'le Massacre de Fuchsia', 'true_name', 4, 100)
    await addEvent(world, battle, { summary: 'Quelque chose arrive.', toldIn: 2 })

    const page = await read(1, 5, 5)

    expect(at(page, 2, 'evenement')[0]!.text).toBe('l’incident du village')
  })

  it('does not carry a later reveal into an earlier bead’s previous name', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'la silhouette', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo', 'true_name', 3, 100)
    await addLabel(world, stranger, 'Kaelo D. Renn', 'true_name', 5, 110)

    const page = await read(1, 5, 5)

    expect(at(page, 3, 'nom')[0]!.detail).toBe('la silhouette')
    expect(at(page, 5, 'nom')[0]!.text).toBe('Kaelo D. Renn')
    expect(at(page, 5, 'nom')[0]!.detail).toBe('Kaelo')
  })

  it('never reaches past the reader’s boundary, even mid-window', async () => {
    const late = await createEntity(world, 'character', 4)
    await addLabel(world, late, 'Buggy', 'true_name', 4, 100)
    const event = await createEntity(world, 'event', 4)
    await addLabel(world, event, 'l’arrivée de Buggy', 'true_name', 4, 100)
    await addEvent(world, event, { summary: 'Buggy débarque.', toldIn: 4 })

    const page = await read(1, 12, 3)

    expect([...new Set(page.beats.map((beat) => beat.chapter))]).toEqual([1, 2, 3])
    expect(JSON.stringify(page)).not.toContain('Buggy')
  })

  it('does not show a belief as refuted before the chapter that refutes it', async () => {
    const subject = await createEntity(world, 'character', 1)
    const village = await createEntity(world, 'place', 1)
    await addLabel(world, subject, 'Shanks', 'true_name', 1, 100)
    await addLabel(world, village, 'Fuchsia', 'true_name', 1, 100)
    await addAssertion(world, {
      subject,
      predicate: 'located_at',
      object: village,
      knowledgeFrom: 1,
      knowledgeUntil: 4,
    })

    const page = await read(1, 5, 5)

    for (const chapter of [1, 2, 3, 5]) {
      expect(at(page, chapter, 'dementi')).toHaveLength(0)
    }
    expect(at(page, 4, 'dementi')).toHaveLength(1)
  })

  it('does not announce a resolution the reader has not reached', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Le trésor', 'true_name', 1, 100)
    await addMystery(world, mystery, {
      question: 'Où est le trésor de Higuma ?',
      openedIn: 1,
      state: 'resolved',
      resolvedIn: 5,
    })

    const page = await read(1, 3, 3)

    expect(at(page, 1, 'question')).toHaveLength(1)
    expect(page.beats.filter((beat) => beat.kind === 'reponse')).toHaveLength(0)
  })

  it('shows another reader a bare thread', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'Luffy', 'true_name', 1, 100)

    const other = await seedWorld([1, 2, 3])
    const page = await getStoryPage(other.userId, other.workId, {
      from: 1,
      count: 3,
      ceiling: 3,
    })

    // Notches, because the chapters exist; no beads, because nothing in them
    // belongs to this reader.
    expect(page.beats.every((beat) => beat.kind === 'chapitre')).toBe(true)
    expect(page.beats).toHaveLength(3)
  })
})
