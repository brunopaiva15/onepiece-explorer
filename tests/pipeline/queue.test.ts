import { afterAll, describe, expect, it } from 'vitest'
import { boss, CHAPTER_QUEUE, enqueueChapter, stopQueue } from '@/domains/pipeline/queue.ts'
import { raw } from '../helpers/db.ts'

/**
 * The queue itself, against a real Postgres.
 *
 * Not a test of the pipeline — that is run-chapter.test.ts. This exists because
 * pg-boss owns its own schema and performs a migration on first start, and both
 * of those are the kind of thing that works on the developer's machine and
 * fails on a fresh database. Finding out here beats finding out from an import
 * that sits at "pending" forever with no explanation.
 */

afterAll(async () => {
  await stopQueue()
  // pg-boss installs its own schema. Drop it so the next run exercises the
  // first-start migration rather than an already-migrated database.
  await raw.unsafe('DROP SCHEMA IF EXISTS pgboss CASCADE')
  await raw.end({ timeout: 5 })
})

describe('the job queue', () => {
  it('installs its schema and accepts a job', async () => {
    const queue = await boss()
    expect(await queue.isInstalled()).toBe(true)

    const id = await enqueueChapter({
      runId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      chapterId: '00000000-0000-4000-8000-000000000003',
    })
    expect(id).toBeTruthy()

    const jobs = await queue.fetch<{ runId: string }>(CHAPTER_QUEUE, { batchSize: 5 })
    expect(jobs.map((job) => job.id)).toContain(id)
    expect(jobs.find((job) => job.id === id)?.data.runId).toBe(
      '00000000-0000-4000-8000-000000000001',
    )
  })

  it('serialises jobs for the same queue rather than running them together', async () => {
    // The queue policy is what stops two runs over the same chapter from each
    // deleting the other's panels. Asserting the configured policy rather than
    // racing two workers keeps the test deterministic.
    const queue = await boss()
    const configured = await queue.getQueue(CHAPTER_QUEUE)
    expect(configured?.policy).toBe('stately')
  })
})
