import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The queue that makes a batch import safe.
 *
 * Ten chapters imported together must not run together: `runResolve` compares a
 * proposal only against entities *already in the graph*, and only publication
 * puts them there. Identical names still join at publication, so what a blind
 * batch actually loses is every identity question weaker than an exact name —
 * an alias named one chapter later becomes a second entity and nothing asks.
 * These tests pin the ordering that avoids it, and the three ways it could go
 * wrong quietly.
 *
 * `startChapterRun` is replaced here on purpose. It schedules the pipeline with
 * `after()`, which needs a request context this test has none of, and what is
 * under test is the claim — which chapter is taken, exactly once, and what
 * happens when the run is refused.
 */

const started: Array<{ chapterId: string }> = []
let refuse: string | null = null

vi.mock('@/domains/pipeline/start.ts', () => ({
  startChapterRun: async (input: { chapterId: string }) => {
    if (refuse !== null) return { ok: false, error: refuse }
    started.push({ chapterId: input.chapterId })
    return { ok: true, runId: randomUUID() }
  },
}))

const { advanceQueue, clearQueue, queueForRun, queuedChapters } = await import(
  '@/domains/pipeline/queue.ts'
)
const { closeDb, raw, resetDatabase, seedWorld } = await import('../helpers/db.ts')

let world: Awaited<ReturnType<typeof seedWorld>>
const ids = new Map<number, string>()

/** A chapter that exists and has never been processed. */
async function chapter(number: number): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO chapters (id, work_id, user_id, number, status, source_kind)
    VALUES (${id}, ${world.workId}, ${world.userId}, ${number}, 'uploaded', 'summary')
  `
  ids.set(number, id)
  return id
}

beforeEach(async () => {
  await resetDatabase()
  started.length = 0
  refuse = null
  ids.clear()
  world = await seedWorld([])
})

afterAll(async () => {
  await closeDb()
})

describe('a queue of chapters', () => {
  it('starts the lowest-numbered chapter and leaves the rest waiting', async () => {
    const twelve = await chapter(12)
    await chapter(13)
    await chapter(14)

    await queueForRun(world.userId, [...ids.values()])
    const advanced = await advanceQueue(world.userId)

    expect(advanced.started?.number).toBe(12)
    expect(started.map((run) => run.chapterId)).toEqual([twelve])

    // The order matters more than the count: 13 before 14, because 14's
    // resolution needs 13's entities in the graph, not merely some of them.
    expect((await queuedChapters(world.userId)).map((row) => row.number)).toEqual([13, 14])
  })

  it('walks the queue one publication at a time', async () => {
    await chapter(12)
    await chapter(13)
    await chapter(14)
    await queueForRun(world.userId, [...ids.values()])

    const numbers: number[] = []
    for (let step = 0; step < 4; step++) {
      const advanced = await advanceQueue(world.userId)
      if (advanced.started) numbers.push(advanced.started.number)
    }

    expect(numbers).toEqual([12, 13, 14])
    expect(await queuedChapters(world.userId)).toEqual([])
  })

  it('gives the same chapter to only one of two publications landing together', async () => {
    /*
     * Two reviews published at once is not exotic — two tabs, or a double
     * click. A read-then-write would hand both the same chapter and pay for its
     * run twice; the claim is a conditional update for exactly this.
     */
    await chapter(12)
    await chapter(13)
    await queueForRun(world.userId, [...ids.values()])

    const [first, second] = await Promise.all([
      advanceQueue(world.userId),
      advanceQueue(world.userId),
    ])

    const claimed = [first.started?.number, second.started?.number].filter(
      (number) => number !== undefined,
    )
    expect(claimed.sort()).toEqual([12, 13])
    expect(started).toHaveLength(2)
    expect(new Set(started.map((run) => run.chapterId)).size).toBe(2)
  })

  it('puts a chapter back when its run is refused', async () => {
    await chapter(12)
    await chapter(13)
    await queueForRun(world.userId, [...ids.values()])

    // The realistic refusal is the hourly run limit, which means "later", not
    // "never". Dropping the chapter would end the queue at whichever chapter
    // happened to hit the ceiling, silently.
    refuse = 'Limite atteinte : 30 traitements dans l’heure.'
    const refused = await advanceQueue(world.userId)

    expect(refused.started).toBeNull()
    expect(refused.error).toMatch(/Limite atteinte/)
    expect((await queuedChapters(world.userId)).map((row) => row.number)).toEqual([12, 13])

    refuse = null
    expect((await advanceQueue(world.userId)).started?.number).toBe(12)
  })

  it('does nothing at all when the queue is empty', async () => {
    await chapter(12)

    // A chapter imported on its own, with « lancer le traitement » unticked, is
    // not in the queue and must never be swept into one: that choice was a
    // decision not to spend, not a delay.
    const advanced = await advanceQueue(world.userId)

    expect(advanced.started).toBeNull()
    expect(advanced.error).toBeNull()
    expect(started).toEqual([])
  })

  it('never reaches into another reader’s queue', async () => {
    await chapter(12)
    await queueForRun(world.userId, [...ids.values()])

    const other = await seedWorld([])
    const advanced = await advanceQueue(other.userId)

    expect(advanced.started).toBeNull()
    expect((await queuedChapters(world.userId)).map((row) => row.number)).toEqual([12])
  })

  it('empties the queue without deleting the chapters', async () => {
    await chapter(12)
    await chapter(13)
    await queueForRun(world.userId, [...ids.values()])

    expect(await clearQueue(world.userId)).toBe(2)
    expect(await queuedChapters(world.userId)).toEqual([])

    const rows = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM chapters WHERE user_id = ${world.userId}`
    expect(rows[0]!.count).toBe(2)
  })
})
