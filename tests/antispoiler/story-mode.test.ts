import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getStoryPage } from '@/domains/temporal/story.ts'
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
 * boundary. A window covering chapters 1 to 6 is six moments in one response,
 * and the cheap way to build it — read once at chapter 6, sort into buckets
 * afterwards — produces a page that looks perfect and lies on every panel
 * before the last: chapter 1 titled with a name revealed in chapter 5, a face
 * shown beside a character the reader has not been introduced to.
 *
 * That failure is invisible in a library seeded with one chapter, invisible in
 * a screenshot, and invisible to anyone who already knows the story. So it is
 * pinned here, with the blocking scenarios, rather than in the behavioural
 * suite.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 4, 5])
})

afterAll(async () => {
  await closeDb()
})

describe('a window never lets one chapter borrow a later chapter’s knowledge', () => {
  it('leaves a character unnamed on the chapter where they were unnamed', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'l’homme au tablier de cuir', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo Renn', 'true_name', 3, 100)

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 5,
      ceiling: 5,
    })

    const introduced = page.chapters[0]!.cast.find(
      (member) => member.entityId === stranger,
    )
    expect(introduced).toBeDefined()
    expect(introduced!.label).toBe('l’homme au tablier de cuir')

    // And the true name lands exactly once, on the chapter that reveals it.
    expect(page.chapters[2]!.reveals).toHaveLength(1)
    expect(page.chapters[2]!.reveals[0]!.label).toBe('Kaelo Renn')
    expect(page.chapters[2]!.reveals[0]!.previous).toBe(
      'l’homme au tablier de cuir',
    )
  })

  it('names an event with the name it had at the chapter that told it', async () => {
    const battle = await createEntity(world, 'event', 2)
    await addLabel(world, battle, 'l’incident du village', 'alias', 2, 10)
    await addLabel(world, battle, 'le Massacre de Fuchsia', 'true_name', 4, 100)
    await addEvent(world, battle, { summary: 'Quelque chose arrive.', toldIn: 2 })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 5,
      ceiling: 5,
    })

    expect(page.chapters[1]!.events[0]!.label).toBe('l’incident du village')
  })

  it('does not carry a later reveal into an earlier chapter’s “previous name”', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'la silhouette', 'alias', 1, 10)
    await addLabel(world, stranger, 'Kaelo', 'true_name', 3, 100)
    await addLabel(world, stranger, 'Kaelo D. Renn', 'true_name', 5, 110)

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 5,
      ceiling: 5,
    })

    // Chapter 3 knows what came before it, and nothing of chapter 5.
    expect(page.chapters[2]!.reveals[0]!.previous).toBe('la silhouette')
    // Chapter 5's reveal knows chapter 3's name as its predecessor.
    expect(page.chapters[4]!.reveals[0]!.label).toBe('Kaelo D. Renn')
    expect(page.chapters[4]!.reveals[0]!.previous).toBe('Kaelo')
  })

  it('never reaches past the reader’s boundary, even mid-window', async () => {
    const late = await createEntity(world, 'character', 4)
    await addLabel(world, late, 'Buggy', 'true_name', 4, 100)
    const event = await createEntity(world, 'event', 4)
    await addLabel(world, event, 'l’arrivée de Buggy', 'true_name', 4, 100)
    await addEvent(world, event, { summary: 'Buggy débarque.', toldIn: 4 })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 12,
      ceiling: 3,
    })

    expect(page.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3])
    const everything = JSON.stringify(page)
    expect(everything).not.toContain('Buggy')
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

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 5,
      ceiling: 5,
    })

    expect(page.chapters[0]!.refutations).toHaveLength(0)
    expect(page.chapters[1]!.refutations).toHaveLength(0)
    expect(page.chapters[2]!.refutations).toHaveLength(0)
    expect(page.chapters[3]!.refutations).toHaveLength(1)
    expect(page.chapters[4]!.refutations).toHaveLength(0)
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

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 3,
      ceiling: 3,
    })

    expect(page.chapters[0]!.mysteriesOpened).toHaveLength(1)
    for (const chapter of page.chapters) {
      expect(chapter.mysteriesResolved).toHaveLength(0)
    }
  })

  it('shows another reader nothing at all', async () => {
    const stranger = await createEntity(world, 'character', 1)
    await addLabel(world, stranger, 'Luffy', 'true_name', 1, 100)

    const other = await seedWorld([1, 2, 3])
    const page = await getStoryPage(other.userId, other.workId, {
      from: 1,
      count: 3,
      ceiling: 3,
    })

    for (const chapter of page.chapters) {
      expect(chapter.cast).toHaveLength(0)
      expect(chapter.reveals).toHaveLength(0)
      expect(chapter.isSilent).toBe(true)
    }
  })
})
