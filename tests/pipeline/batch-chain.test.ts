import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A lot that walks itself to the end.
 *
 * Importing fifty chapters used to mean fifty visits to the review centre, and
 * the queue could not advance without one: it moves on a publication, and a
 * publication was something only a person did. So a batch imported in one click
 * ran one chapter and stopped.
 *
 * These tests pin the three things that make the chain safe rather than merely
 * automatic:
 *
 *   It is asked for per import. A chapter carrying `auto_review` publishes
 *   itself; the chapter imported next to it, without the flag, still arrives as
 *   a queue of proposals. That is the anti-spoiler guarantee narrowed on
 *   purpose, and not withdrawn everywhere at once.
 *
 *   It stops where a real question is. A chapter that holds a name, an identity
 *   or a contradiction does not open, so the next one does not start — because
 *   the next one's resolution would be compared against a graph missing exactly
 *   the entity being asked about.
 *
 *   It says which chapter, and why. A chain stopped on purpose and a chain
 *   broken look identical from outside; `batchStatus` is what tells them apart.
 *
 * `startChapterRun` is replaced with one that runs the pipeline inline. In
 * production it schedules with `after()`, which needs a request context no test
 * has — and what is under test is the chain, so the run has to actually happen.
 */

const { createRun } = await import('@/domains/pipeline/runs.ts')
const { executeRun } = await import('@/domains/pipeline/execute.ts')
const { openChainWindow, resetChainWindow } = await import('@/domains/pipeline/chain.ts')

/*
 * The real `startChapterRun`, minus the one thing a test cannot have.
 *
 * It opens the invocation's chain window and schedules the pipeline with
 * `after()`. The window is kept — it is what decides whether a chapter chains
 * the next one, and dropping it would test a chain that cannot happen. The
 * scheduling becomes a direct call: `after()` needs a request context, and what
 * is under test is what the chain does, so the run has to actually run.
 */
vi.mock('@/domains/pipeline/start.ts', () => ({
  startChapterRun: async (input: { userId: string; chapterId: string }) => {
    openChainWindow()
    const runId = await createRun(input.userId, input.chapterId)
    await executeRun(input.userId, input.chapterId, runId)
    return { ok: true, runId }
  },
}))

const { advanceQueue, queueForRun, queuedChapters } = await import(
  '@/domains/pipeline/queue.ts'
)
const { batchStatus } = await import('@/domains/pipeline/batch.ts')
const { autoReview, autoReviewsChapter, autoReviewsRun, enableAutoReview } =
  await import('@/domains/review/auto.ts')
const { getReviewQueue } = await import('@/domains/review/queue.ts')
const { importSummary } = await import('@/domains/ingestion/summary.ts')
const { closeDb, raw, resetDatabase, seedWorld } = await import('../helpers/db.ts')

/**
 * Three chapters sharing no proper noun, and neither point is decoration.
 *
 * Different from each other, because a decision is recorded against the
 * proposal's fingerprint so a re-import never asks the same question twice:
 * two chapters carrying the same text produce no second queue at all, which
 * would make every assertion below about "what the queue did" vacuous.
 *
 * And sharing no *name*, because a name that resembles one already in the graph
 * is exactly what raises a rapprochement — the one question this pass always
 * hands back. That is the behaviour under test in « stops at the chapter that
 * kept a question »; here it would be noise, and it would be the synthetic
 * provider's noise rather than a real identity doubt, since that provider
 * proposes every capitalised word it sees and knows nothing of who is already
 * in the graph.
 *
 * Each block starts lowercase on purpose: only a block's very first word is
 * exempt from being read as a name.
 */
const CASTS: Record<number, string[]> = {
  1: ['Vorrik Thal', 'Andemere', 'Belloq'],
  2: ['Sunimasa Ferry', 'Praxil', 'Hodderwych'],
  3: ['Egret Quillon', 'Tumbrel', 'Yanaki Bay'],
}

function summary(number: number): string {
  const [person, place, other] = CASTS[number]!
  return [
    `at first light ${person} walks the length of ${place} and finds the ` +
      `harbour empty, every rope cut and every lantern still burning.`,
    '',
    `by evening ${other} admits to having paid the crew to leave before ` +
      `sunrise, and ${person} listens without saying anything at all.`,
  ].join('\n')
}

let world: Awaited<ReturnType<typeof seedWorld>>

async function importChapter(number: number): Promise<string> {
  const { chapterId } = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: number,
    language: 'en',
    text: summary(number),
  })
  return chapterId
}

async function chapterStatus(chapterId: string): Promise<string> {
  const [row] = await raw<Array<{ status: string }>>`
    SELECT status FROM chapters WHERE id = ${chapterId}`
  return row!.status
}

/**
 * Run one chapter with no room left to chain the next.
 *
 * Straight to `executeRun`, because going through `startChapterRun` is what
 * opens a fresh window — an expired one means "this invocation is over" and the
 * request that finds it gets a new one. A test that wants the chain to decline
 * has to be inside the spent window, not at the door of a new invocation.
 */
async function runChapterInSpentWindow(chapterId: string): Promise<string> {
  const runId = await createRun(world.userId, chapterId)
  resetChainWindow()
  openChainWindow(Date.now() - 10 * 60 * 1_000)
  await executeRun(world.userId, chapterId, runId)
  return runId
}

async function stillProposed(chapterId: string): Promise<number> {
  const [row] = await raw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM review_items
      WHERE chapter_id = ${chapterId} AND status = 'proposed'`
  return Number(row!.count)
}

beforeEach(async () => {
  await resetDatabase()
  resetChainWindow()
  // The instance-wide flag stays off throughout: what is under test is the
  // per-import answer, and a test that leant on the environment would pass
  // whether or not the column was ever read.
  delete process.env.AUTO_REVIEW_NAMES_ONLY
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
  world = await seedWorld([])
})

afterAll(async () => {
  await closeDb()
})

describe('a lot that publishes itself', () => {
  it('opens a chapter that asked nothing, and leaves its neighbour in review', async () => {
    const automatic = await importChapter(1)
    const manual = await importChapter(2)
    await enableAutoReview(world.userId, [automatic])

    expect(await autoReviewsChapter(world.userId, automatic)).toBe(true)
    expect(await autoReviewsChapter(world.userId, manual)).toBe(false)

    for (const chapterId of [automatic, manual]) {
      const runId = await createRun(world.userId, chapterId)
      await executeRun(world.userId, chapterId, runId)
    }

    expect(await chapterStatus(automatic)).toBe('published')
    expect(await stillProposed(automatic)).toBe(0)

    // The guarantee this mode narrows rather than repeals: a chapter nobody
    // asked to automate still produces proposals and nothing else.
    expect(await chapterStatus(manual)).not.toBe('published')
    expect(await stillProposed(manual)).toBeGreaterThan(0)
  })

  it('answers the same question from a run, for the review centre', async () => {
    const chapterId = await importChapter(1)
    await enableAutoReview(world.userId, [chapterId])
    const runId = await createRun(world.userId, chapterId)

    expect(await autoReviewsRun(world.userId, runId)).toBe(true)

    const other = await importChapter(2)
    const otherRun = await createRun(world.userId, other)
    expect(await autoReviewsRun(world.userId, otherRun)).toBe(false)
  })

  it('walks the whole queue from a single start, with nobody publishing', async () => {
    const ids = [await importChapter(1), await importChapter(2), await importChapter(3)]
    await enableAutoReview(world.userId, ids)
    await queueForRun(world.userId, ids)

    /*
     * One start, three chapters. This is the property the whole feature is
     * for, and the one that was missing: chapter 1 published itself exactly as
     * designed and chapter 2 waited for a tick from a page nobody was on.
     */
    const advanced = await advanceQueue(world.userId)
    expect(advanced.started?.number).toBe(1)

    const finished = await batchStatus(world.userId)
    expect(finished.queued).toBe(0)
    expect(finished.blocked).toBeNull()
    expect(finished.running).toBeNull()

    for (const chapterId of ids) {
      expect(await chapterStatus(chapterId)).toBe('published')
    }
  })

  it('stops at a chapter boundary when the invocation’s window is spent', async () => {
    const ids = [await importChapter(1), await importChapter(2), await importChapter(3)]
    await enableAutoReview(world.userId, ids)
    await queueForRun(world.userId, [ids[1]!, ids[2]!])

    /*
     * The state a long lot reaches after a few chapters: the window opened by
     * the request that started it is spent. What has to hold is *where* the
     * chain stops — between two chapters, with the rest still queued and
     * nothing half-run. A chapter killed inside its own run costs a relaunch,
     * and that is the failure this budget exists to avoid.
     *
     * The first chapter is run directly rather than through the queue, because
     * starting a run through the ordinary door is what opens a fresh window:
     * an expired one means "this invocation is over", and the next request gets
     * its own. Here the run has to happen *inside* the spent window.
     */
    await runChapterInSpentWindow(ids[0]!)

    expect(await chapterStatus(ids[0]!)).toBe('published')
    expect((await queuedChapters(world.userId)).map((row) => row.number)).toEqual([2, 3])

    const status = await batchStatus(world.userId)
    expect(status.queued).toBe(2)
    expect(status.running).toBeNull()
    // Nothing is blocked: the lot is merely waiting for the next start, which
    // is what the watcher in the workshop's layout provides.
    expect(status.blocked).toBeNull()
  })

  it('stops at the chapter that kept a question, and names it', async () => {
    const ids = [await importChapter(1), await importChapter(2)]
    await enableAutoReview(world.userId, ids)
    await queueForRun(world.userId, [ids[1]!])

    // In the spent window, so the second chapter is still waiting when the
    // question is put back on the first — which is the situation being read.
    await runChapterInSpentWindow(ids[0]!)

    /*
     * The state the pipeline produces when the model raises its hand about a
     * name: the entity stays proposed and the chapter therefore does not open.
     * Reconstructed here rather than coaxed out of the synthetic provider,
     * which copies labels from the source and has no naming judgement to offer
     * — what is under test is the chain's reaction, not the model's.
     */
    const [item] = await raw<Array<{ id: string }>>`
      SELECT id FROM review_items WHERE chapter_id = ${ids[0]!} LIMIT 1`
    await raw`UPDATE review_items SET status = 'proposed' WHERE id = ${item!.id}`
    await raw`UPDATE chapters SET status = 'review', published_at = NULL
               WHERE id = ${ids[0]!}`

    const status = await batchStatus(world.userId)

    expect(status.queued).toBe(1)
    expect(status.running).toBeNull()
    expect(status.blocked?.chapterNumber).toBe(1)
    expect(status.blocked?.reason).toBe('review')
    expect(status.blocked?.runId).not.toBeNull()
  })

  it('calls a failed chapter a failure rather than a queue that stopped', async () => {
    const chapterId = await importChapter(1)
    const waiting = await importChapter(2)
    await enableAutoReview(world.userId, [chapterId, waiting])
    await queueForRun(world.userId, [waiting])

    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider, error)
      VALUES (${randomUUID()}, ${chapterId}, ${world.userId}, 'failed', '0', 'synthetic', 'boom')`

    const status = await batchStatus(world.userId)

    expect(status.blocked?.chapterNumber).toBe(1)
    expect(status.blocked?.reason).toBe('failed')
  })

  it('waits while a chapter is being processed, and never calls it blocked', async () => {
    const running = await importChapter(1)
    const waiting = await importChapter(2)
    await enableAutoReview(world.userId, [running, waiting])
    await queueForRun(world.userId, [waiting])

    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider, started_at)
      VALUES (${randomUUID()}, ${running}, ${world.userId}, 'running', '0', 'synthetic', now())`

    const status = await batchStatus(world.userId)

    expect(status.running?.chapterNumber).toBe(1)
    expect(status.running?.stalled).toBe(false)
    expect(status.blocked).toBeNull()
  })

  it('calls a run that has not moved in minutes interrupted', async () => {
    const running = await importChapter(1)
    await enableAutoReview(world.userId, [running])
    await queueForRun(world.userId, [await importChapter(2)])

    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider, started_at, created_at)
      VALUES (${randomUUID()}, ${running}, ${world.userId}, 'running', '0', 'synthetic',
              now() - interval '30 minutes', now() - interval '30 minutes')`

    const status = await batchStatus(world.userId)

    // Nothing can detect this from inside — the process that would have written
    // the failure is the one that died — so "no step has moved in longer than
    // any step takes" is the honest thing to put on screen.
    expect(status.running?.stalled).toBe(true)
  })

  it('never publishes a chapter whose run produced nothing at all', async () => {
    /*
     * Thirty-six empty chapters, in one afternoon.
     *
     * A run that extracts nothing — the model refused, or every proposal it
     * made was quarantined for evidence nobody could verify — leaves the same
     * empty queue as a review that is finished. Reading the second as the first
     * is what published them: no proposal, therefore nothing to decide,
     * therefore read to the end. And each one released the next, so the mistake
     * did not stop at one chapter, it walked the whole lot.
     *
     * The trace a real review leaves is a decided card. A chapter with none has
     * not been read, whatever its queue looks like.
     */
    const chapterId = await importChapter(1)
    const waiting = await importChapter(2)
    await enableAutoReview(world.userId, [chapterId, waiting])
    await queueForRun(world.userId, [waiting])

    const runId = await createRun(world.userId, chapterId)
    await executeRun(world.userId, chapterId, runId)
    // The state a refusal or a wholly quarantined extraction leaves behind.
    await raw`DELETE FROM review_items WHERE chapter_id = ${chapterId}`
    await raw`UPDATE chapters SET status = 'review', published_at = NULL
               WHERE id = ${chapterId}`

    const swept = await autoReview(world.userId, runId)
    expect(swept.chapterOpened).toBeNull()
    expect(await chapterStatus(chapterId)).not.toBe('published')

    // And the lot stops on it, saying which chapter and what happened, rather
    // than marching on through chapters nobody will ever see the contents of.
    const status = await batchStatus(world.userId)
    expect(status.blocked?.chapterNumber).toBe(1)
    expect(status.blocked?.reason).toBe('empty')
    expect(status.queued).toBe(1)
  })

  it('shows a run that proposed nothing instead of a 404', async () => {
    /*
     * The page that answered « cette page n'existe pas » about a run that
     * existed. It read the chapter off the run's proposals, so a run with none
     * had no chapter — and the reader went looking for a broken link instead of
     * at the quarantine reasons, which are on that very page.
     */
    const chapterId = await importChapter(1)
    const runId = await createRun(world.userId, chapterId)
    await executeRun(world.userId, chapterId, runId)
    await raw`DELETE FROM review_items WHERE chapter_id = ${chapterId}`

    const queue = await getReviewQueue(world.userId, runId)

    expect(queue).not.toBeNull()
    expect(queue?.chapterNumber).toBe(1)
    expect(queue?.items).toEqual([])
    expect(queue?.counts.pending).toBe(0)
  })

  it('never counts another reader’s lot', async () => {
    const mine = await importChapter(1)
    await enableAutoReview(world.userId, [mine])
    await raw`UPDATE chapters SET status = 'review' WHERE id = ${mine}`

    const other = await seedWorld([])

    const status = await batchStatus(other.userId)
    expect(status.queued).toBe(0)
    expect(status.blocked).toBeNull()
    expect(status.running).toBeNull()
  })
})
