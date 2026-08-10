import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importChapter } from '@/domains/ingestion/import.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { getNarrativeDelta } from '@/domains/temporal/timeline.ts'
import { LocalFsStorage } from '@/domains/storage/local-storage.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * The whole journey, once, against a real database.
 *
 * Every stage has its own tests. This one asks the question none of them can:
 * does the boundary still hold after the data has been through all of them? A
 * leak introduced by the *composition* of correct parts is exactly the kind
 * that unit tests miss and that nobody notices until it has spoiled something.
 *
 * Two chapters, imported and published in order, then the slider moved back.
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

let storageRoot: string
let adapter: LocalFsStorage

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)))
}

beforeEach(async () => {
  await resetDatabase()
  storageRoot = await mkdtemp(path.join(tmpdir(), 'ope-e2e-'))
  adapter = new LocalFsStorage({ root: storageRoot, secret: 'test', defaultTtl: 60 })
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_ROOT = storageRoot
  process.env.MODEL_PROVIDER = 'synthetic'

  const { resetStorageCache } = await import('@/domains/storage/index.ts')
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetStorageCache()
  resetModelProvider()
})

afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await closeDb()
})

/** Import, process and publish everything a chapter proposed. */
async function walkChapter(
  userId: string,
  workId: string,
  chapterNumber: number,
  file: string,
): Promise<{ chapterId: string; published: number }> {
  const imported = await importChapter({
    userId,
    workId,
    chapterNumber,
    file: { filename: file, bytes: await fixture(file) },
    limits,
    adapter,
  })

  const runId = await createRun(userId, imported.chapterId)
  const run = await executeRun(userId, imported.chapterId, runId)
  expect(run.status, run.error ?? '').toBe('succeeded')

  const queue = await getReviewQueue(userId, runId)
  const result = await publishDecisions(
    userId,
    runId,
    (queue?.items ?? []).map((item) => ({
      reviewItemId: item.id,
      decision: 'accept' as const,
    })),
  )

  await raw`UPDATE chapters SET status = 'published', published_at = now()
            WHERE id = ${imported.chapterId}`

  return {
    chapterId: imported.chapterId,
    published: result.entitiesCreated + result.assertionsCreated,
  }
}

describe('the boundary holds across the whole journey', () => {
  it('shows chapter 1 knowledge at chapter 1 and more at chapter 2', async () => {
    const world = await seedWorld([])

    const first = await walkChapter(world.userId, world.workId, 1, 'chapitre-01.pdf')
    expect(first.published).toBeGreaterThan(0)

    const second = await walkChapter(world.userId, world.workId, 2, 'chapitre-02.pdf')
    expect(second.published).toBeGreaterThan(0)

    const atOne = await projectGraph(world.userId, 1)
    const atTwo = await projectGraph(world.userId, 2)

    // Chapter 2 can only add. A graph that shrank as the reader advanced would
    // mean something was being overwritten rather than accumulated.
    expect(atTwo.nodes.length).toBeGreaterThanOrEqual(atOne.nodes.length)

    /*
     * The property that matters: nothing chapter 2 introduced is visible at
     * chapter 1. Checked by id rather than by count, because equal counts would
     * pass while the contents differed.
     */
    const atOneIds = new Set(atOne.nodes.map((node) => node.id))
    const introducedByTwo = atTwo.nodes.filter((node) => node.firstSeenChapter === 2)
    for (const node of introducedByTwo) {
      expect(
        atOneIds.has(node.id),
        `« ${node.label} » apparaît au chapitre 2 mais est visible au chapitre 1`,
      ).toBe(false)
    }
  })

  it('shows nothing at chapter 0, before anything was read', async () => {
    const world = await seedWorld([])
    await walkChapter(world.userId, world.workId, 1, 'chapitre-01.pdf')

    const atZero = await projectGraph(world.userId, 0)
    expect(atZero.nodes).toEqual([])
    expect(atZero.edges).toEqual([])
  })

  it('never shows a proposal that was rejected', async () => {
    const world = await seedWorld([])

    const imported = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })
    const runId = await createRun(world.userId, imported.chapterId)
    await executeRun(world.userId, imported.chapterId, runId)

    const queue = await getReviewQueue(world.userId, runId)
    await publishDecisions(
      world.userId,
      runId,
      (queue?.items ?? []).map((item) => ({
        reviewItemId: item.id,
        decision: 'reject' as const,
      })),
    )

    const graph = await projectGraph(world.userId, 1)
    expect(graph.nodes).toEqual([])
  })

  it('reports the delta of a chapter without leaking the next one', async () => {
    const world = await seedWorld([])
    await walkChapter(world.userId, world.workId, 1, 'chapitre-01.pdf')
    await walkChapter(world.userId, world.workId, 2, 'chapitre-02.pdf')

    const delta = await getNarrativeDelta(world.userId, 1)
    expect(delta).not.toBeNull()

    // Everything in chapter 1's delta was revealed by chapter 1. A delta that
    // reached forward would be a spoiler delivered by the feature meant to
    // summarise what you just read.
    const atOne = await projectGraph(world.userId, 1)
    const visibleAtOne = new Set(atOne.nodes.flatMap((node) => node.memberIds))
    for (const entity of delta!.newEntities) {
      expect(
        visibleAtOne.has(entity.id),
        `« ${entity.label} » figure dans le delta du chapitre 1 sans y être visible`,
      ).toBe(true)
    }
  })

  it('keeps one reader’s graph invisible to another', async () => {
    const mine = await seedWorld([])
    await walkChapter(mine.userId, mine.workId, 1, 'chapitre-01.pdf')

    const theirs = await seedWorld([])
    const graph = await projectGraph(theirs.userId, 999)
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })
})
