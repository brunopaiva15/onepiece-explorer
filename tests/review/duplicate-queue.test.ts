import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { closeDb, raw, resetDatabase, seedWorld, type SeededWorld } from '../helpers/db.ts'

/**
 * What the queue tells a reviewer about copies of the same proposal.
 *
 * The failure this guards against is not a crash — it is a queue that looks
 * correct. A chapter extracted in slices proposes the same character once per
 * slice, the two cards sit forty apart, and the reviewer accepts both because
 * nothing on screen says they are the same proposal. Publication then writes two
 * entities, and `runResolve` will never join them: it only ever compares against
 * entities already in the graph, never proposals against each other.
 *
 * The copy that matters most is the one accepted in an earlier batch — it has
 * left the pending queue entirely, so a grouping computed over the displayed
 * items alone would be blind to exactly the case that costs a duplicate node.
 */

let world: SeededWorld
let chapterId: string
let runId: string

async function seedRun(): Promise<void> {
  world = await seedWorld([1])
  chapterId = world.chapterIds.get(1)!
  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
}

let anchor = 0

async function proposeEntity(
  label: string,
  status: 'proposed' | 'accepted' | 'rejected' = 'proposed',
): Promise<string> {
  const id = randomUUID()
  anchor++
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, 'entity', 50,
      ${JSON.stringify({
        local_id: `e-${id.slice(0, 4)}`,
        node_type: 'character',
        label,
        label_kind: 'alias',
        // Different anchors per copy: two slices cite different panels, which is
        // why the fingerprint cannot be what groups them.
        evidence: [{ kind: 'text', ref: `b${anchor}`, excerpt: label }],
        confidence: 0.8,
      })},
      ${randomUUID()}, false, 0.8, ${status}::review_status
    )
  `
  return id
}

describe('review queue · duplicate proposals', () => {
  beforeEach(async () => {
    await resetDatabase()
    await seedRun()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('links two pending copies of one entity and leaves a unique proposal alone', async () => {
    const first = await proposeEntity('Zoro')
    const second = await proposeEntity('zoro')
    const unique = await proposeEntity('Nami')

    const queue = await getReviewQueue(world.userId, runId)
    const byId = new Map(queue!.items.map((item) => [item.id, item]))

    expect(byId.get(first)?.duplicate?.total).toBe(2)
    expect(byId.get(second)?.duplicate?.key).toBe(byId.get(first)?.duplicate?.key)
    expect(byId.get(first)?.duplicate?.others).toEqual({
      pending: 1,
      accepted: 0,
      rejected: 0,
      deferred: 0,
    })
    expect(byId.get(unique)?.duplicate).toBeNull()
  })

  it('counts a copy accepted in an earlier batch, which the pending queue no longer shows', async () => {
    await proposeEntity('Zoro', 'accepted')
    const pending = await proposeEntity('Zoro')

    const queue = await getReviewQueue(world.userId, runId)

    // The accepted copy is not in the queue…
    expect(queue!.items.map((item) => item.id)).toEqual([pending])
    // …but the reviewer is told it exists, which is the whole point.
    expect(queue!.items[0]?.duplicate?.total).toBe(2)
    expect(queue!.items[0]?.duplicate?.others.accepted).toBe(1)
  })

  it('does not group two designations the source has not identified with each other', async () => {
    const scarf = await proposeEntity('l’homme au foulard rayé')
    await proposeEntity('l’homme au foulard')

    const queue = await getReviewQueue(world.userId, runId)
    const item = queue!.items.find((candidate) => candidate.id === scarf)

    expect(item?.duplicate).toBeNull()
  })
})
