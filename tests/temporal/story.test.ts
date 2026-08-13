import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getStoryPage } from '@/domains/temporal/story.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  addQuote,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The story read forward, a window at a time.
 *
 * These pin the shape of one page of story mode: which beats land on which
 * chapter, what a silent chapter looks like, and where the window stops. The
 * property that a chapter never borrows a later chapter's knowledge is pinned
 * separately, in the anti-spoiler suite, because it is the one that must stay
 * blocking.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 4])
})

afterAll(async () => {
  await closeDb()
})

describe('a window of the story', () => {
  it('returns the chapters in reading order, from the first', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 3,
      ceiling: 4,
    })

    expect(page.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3])
  })

  it('hands back the next chapter as a cursor, and null at the end', async () => {
    const first = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 3,
      ceiling: 4,
    })
    expect(first.nextCursor).toBe(4)

    const second = await getStoryPage(world.userId, world.workId, {
      from: first.nextCursor!,
      count: 3,
      ceiling: 4,
    })
    expect(second.chapters.map((chapter) => chapter.number)).toEqual([4])
    expect(second.nextCursor).toBeNull()
  })

  it('stops at the reader’s own boundary, whatever the window asks for', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 12,
      ceiling: 2,
    })

    expect(page.chapters.map((chapter) => chapter.number)).toEqual([1, 2])
    expect(page.nextCursor).toBeNull()
    expect(page.lastChapter).toBe(2)
  })
})

describe('what lands on a chapter', () => {
  it('puts an event on the chapter that told it', async () => {
    const event = await createEntity(world, 'event', 2)
    await addLabel(world, event, 'Le départ de Luffy', 'true_name', 2, 100)
    await addEvent(world, event, {
      summary: 'Luffy quitte Fuchsia dans un tonneau.',
      toldIn: 2,
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 3,
      ceiling: 4,
    })

    expect(page.chapters[0]!.events).toHaveLength(0)
    expect(page.chapters[1]!.events).toHaveLength(1)
    expect(page.chapters[1]!.events[0]!.label).toBe('Le départ de Luffy')
    expect(page.chapters[1]!.events[0]!.summary).toBe(
      'Luffy quitte Fuchsia dans un tonneau.',
    )
  })

  it('keeps a flashback on the chapter that recounts it, and says so', async () => {
    const event = await createEntity(world, 'event', 3)
    await addLabel(world, event, 'Le sacrifice de Shanks', 'true_name', 3, 100)
    await addEvent(world, event, {
      summary: 'Shanks perd un bras.',
      toldIn: 3,
      isFlashback: true,
      storyTime: { kind: 'approximate', description: 'environ dix ans plus tôt' },
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 3,
      count: 1,
      ceiling: 4,
    })

    const [beat] = page.chapters[0]!.events
    expect(beat!.isFlashback).toBe(true)
    expect(beat!.storyTime?.description).toBe('environ dix ans plus tôt')
  })

  it('puts a refutation on the chapter that closes the belief', async () => {
    const subject = await createEntity(world, 'character', 1)
    const village = await createEntity(world, 'place', 1)
    await addLabel(world, subject, 'Higuma', 'true_name', 1, 100)
    await addLabel(world, village, 'Fuchsia', 'true_name', 1, 100)
    await addAssertion(world, {
      subject,
      predicate: 'located_at',
      object: village,
      knowledgeFrom: 1,
      knowledgeUntil: 3,
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 4,
      ceiling: 4,
    })

    expect(page.chapters[0]!.refutations).toHaveLength(0)
    const closed = page.chapters[2]!.refutations
    expect(closed).toHaveLength(1)
    expect(closed[0]!.subjectLabel).toBe('Higuma')
    expect(closed[0]!.heldSince).toBe(1)
  })

  it('opens a mystery once, on its own chapter, and never again', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Le One Piece', 'true_name', 1, 100)
    await addMystery(world, mystery, {
      question: 'Qu’est-ce que le One Piece ?',
      openedIn: 1,
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 4,
      ceiling: 4,
    })

    expect(page.chapters[0]!.mysteriesOpened).toHaveLength(1)
    expect(page.chapters[1]!.mysteriesOpened).toHaveLength(0)
    expect(page.chapters[2]!.mysteriesOpened).toHaveLength(0)
    expect(page.chapters[3]!.mysteriesOpened).toHaveLength(0)
  })

  it('closes a mystery on the chapter that resolves it', async () => {
    const mystery = await createEntity(world, 'mystery', 1)
    await addLabel(world, mystery, 'Le trésor de Higuma', 'true_name', 1, 100)
    await addMystery(world, mystery, {
      question: 'Où est le trésor ?',
      openedIn: 1,
      state: 'resolved',
      resolvedIn: 3,
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 4,
      ceiling: 4,
    })

    expect(page.chapters[0]!.mysteriesOpened).toHaveLength(1)
    expect(page.chapters[2]!.mysteriesResolved).toHaveLength(1)
    expect(page.chapters[2]!.mysteriesResolved[0]!.question).toBe('Où est le trésor ?')
  })

  it('quotes a line the pipeline anchored, never one it composed', async () => {
    const subject = await createEntity(world, 'character', 1)
    await addLabel(world, subject, 'Shanks', 'true_name', 1, 100)
    const assertionId = await addAssertion(world, {
      subject,
      predicate: 'promises',
      knowledgeFrom: 1,
      objectValue: { text: 'rendre le chapeau' },
    })
    const line =
      'Rends-moi ce chapeau quand tu seras devenu un grand pirate, Luffy.'
    await addQuote(world, { assertionId, chapterNumber: 1, text: line })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 1,
      ceiling: 4,
    })

    expect(page.chapters[0]!.quote?.excerpt).toBe(line)
  })
})

describe('a chapter with nothing to stage', () => {
  it('is marked silent rather than dressed up', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Luffy', 'true_name', 1, 100)

    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 2,
      ceiling: 4,
    })

    expect(page.chapters[0]!.isSilent).toBe(false)
    expect(page.chapters[1]!.isSilent).toBe(true)
  })

  it('counts the facts a chapter added even when it shows none of them', async () => {
    const subject = await createEntity(world, 'character', 1)
    const object = await createEntity(world, 'character', 1)
    await addAssertion(world, {
      subject,
      predicate: 'fights',
      object,
      knowledgeFrom: 2,
    })

    const page = await getStoryPage(world.userId, world.workId, {
      from: 2,
      count: 1,
      ceiling: 4,
    })

    expect(page.chapters[0]!.factCount).toBe(1)
  })
})

describe('a library with nothing in it', () => {
  it('returns an empty window rather than failing', async () => {
    const page = await getStoryPage(world.userId, '', {
      from: 1,
      count: 5,
      ceiling: 4,
    })

    expect(page.chapters).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('returns nothing when the reader has read nothing', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 1,
      count: 5,
      ceiling: 0,
    })

    expect(page.chapters).toEqual([])
  })
})
