import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { markChapterReviewed } from '@/domains/review/publish.ts'
import {
  closeDb,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * « J'ai bien tout traité », et le chapitre refuse de se fermer.
 *
 * A chapter can be processed more than once — a relaunch, a re-import, the batch
 * queue coming back to it — and each run leaves a review queue of its own. The
 * rule that opens a chapter counts undecided proposals across *every* run of it,
 * and it is right to: a second queue nobody has read is exactly what the reader's
 * boundary must never open over.
 *
 * The page, though, is one run. So a reviewer who emptied this run's queue was
 * shown « Rien à revoir pour ce traitement », offered « Marquer le chapitre
 * comme relu », and told in reply « Il reste des propositions à décider pour ce
 * chapitre » — true, about proposals on a page they had no way to find. The
 * queue now carries where they are.
 */

let world: SeededWorld
let chapterId: string
let thisRun: string
let otherRun: string

async function createRun(): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${id}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
  return id
}

async function propose(
  runId: string,
  status: 'proposed' | 'accepted' | 'deferred' | 'rejected',
): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, 'entity', 50,
      ${JSON.stringify({
        local_id: 'e1',
        node_type: 'character',
        label: 'Kuro',
        label_kind: 'alias',
        evidence: [{ kind: 'text', ref: 'b1', excerpt: 'Kuro' }],
        confidence: 0.9,
      })},
      ${randomUUID()}, false, 0.9, ${status}::review_status
    )
  `
  return id
}

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([38])
  chapterId = world.chapterIds.get(38)!
  await raw`UPDATE chapters SET status = 'review', published_at = NULL WHERE id = ${chapterId}`
  thisRun = await createRun()
  otherRun = await createRun()
})

afterAll(async () => {
  await closeDb()
})

describe('a chapter whose queue is empty here and open elsewhere', () => {
  it('names the run that still holds a decision, and how many', async () => {
    await propose(thisRun, 'accepted')
    await propose(thisRun, 'deferred')
    await propose(otherRun, 'proposed')
    await propose(otherRun, 'proposed')

    const queue = (await getReviewQueue(world.userId, thisRun))!

    expect(queue.items).toHaveLength(0)
    expect(queue.chapterPublished).toBe(false)
    expect(queue.pendingElsewhere).toEqual([{ runId: otherRun, count: 2 }])

    // And the rule itself is unchanged: the chapter stays closed while they are
    // there. The panel now says where, instead of offering a button that cannot
    // work.
    expect(await markChapterReviewed(world.userId, thisRun)).toBeNull()
  })

  it('says nothing when the other run has been decided', async () => {
    await propose(thisRun, 'accepted')
    // Rejected and deferred were both looked at and answered; only 'proposed'
    // is an open question.
    await propose(otherRun, 'rejected')
    await propose(otherRun, 'deferred')

    const queue = (await getReviewQueue(world.userId, thisRun))!

    expect(queue.pendingElsewhere).toEqual([])
    expect(await markChapterReviewed(world.userId, thisRun)).toBe(38)
  })

  it('does not count this run’s own open proposals as elsewhere', async () => {
    await propose(thisRun, 'proposed')

    const queue = (await getReviewQueue(world.userId, thisRun))!

    // They are the queue itself, which is where the reviewer already is.
    expect(queue.items).toHaveLength(1)
    expect(queue.pendingElsewhere).toEqual([])
  })
})
