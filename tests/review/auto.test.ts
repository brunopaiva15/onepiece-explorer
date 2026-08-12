import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { autoReview } from '@/domains/review/auto.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * Reviewing only the names.
 *
 * The library's owner decided that a chapter of eighty-six cards, times a
 * thousand chapters, is not a review anyone performs — it is a reflex, and a
 * reflex dressed as review is worse than an honest automatic pass. So the run
 * accepts what it can and stops at the one question a model cannot answer from
 * the text: what a thing is called in French.
 *
 * These tests pin the two things that make that safe to run unattended. A name
 * left unanswered holds back the relations that need it, rather than publishing
 * them against an entity that does not exist. And a category publication cannot
 * apply is parked rather than accepted, because an item accepted into nothing
 * stays proposed for ever — and a chapter with a proposal left is a chapter that
 * never opens.
 */

const SUMMARY = [
  'The chapter opens on Fuchsia Village. A boy named Luffy begs a red-haired',
  'pirate to take him out to sea, and is refused with a laugh.',
  '',
  'Later the crew of the Red-Haired Pirates drinks in the tavern while a mountain',
  'bandit walks in looking for trouble, and Shanks lets himself be humiliated.',
].join('\n')

async function run(): Promise<{ userId: string; chapterId: string; runId: string }> {
  const world = await seedWorld([])
  const { chapterId } = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 1,
    language: 'en',
    text: SUMMARY,
  })
  const runId = await createRun(world.userId, chapterId)
  await executeRun(world.userId, chapterId, runId)
  return { userId: world.userId, chapterId, runId }
}

async function statuses(runId: string): Promise<Record<string, number>> {
  const rows = await raw<Array<{ status: string; count: number }>>`
    SELECT status, count(*)::int AS count FROM review_items
      WHERE run_id = ${runId} GROUP BY status`
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]))
}

beforeEach(async () => {
  await resetDatabase()
  // The mode under test. Off everywhere else, which is what keeps the blocking
  // anti-spoiler scenarios exercising the manual path they were written for.
  process.env.AUTO_REVIEW_NAMES_ONLY = '1'
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
})

afterAll(async () => {
  delete process.env.AUTO_REVIEW_NAMES_ONLY
  await closeDb()
})

describe('the automatic pass', () => {
  it('leaves nothing proposed and opens the chapter when no name is in question', async () => {
    const prepared = await run()

    // The run's own last step already did this; calling it again must find
    // nothing left, which is also the idempotency check.
    const again = await autoReview(prepared.userId, prepared.runId)
    expect(again.accepted).toBe(0)

    expect((await statuses(prepared.runId)).proposed ?? 0).toBe(0)

    const [chapter] = await raw<Array<{ status: string }>>`
      SELECT status FROM chapters WHERE id = ${prepared.chapterId}`
    expect(chapter!.status).toBe('published')

    const [entities] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE user_id = ${prepared.userId}`
    expect(entities!.count).toBeGreaterThan(0)
  })

  it('holds a naming question and the relations that depend on it', async () => {
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      language: 'en',
      text: SUMMARY,
    })
    const runId = await createRun(world.userId, chapterId)

    /*
     * The synthetic provider copies labels out of the source and has no naming
     * judgement to offer, so the flag is set here. What is under test is not
     * whether a model raises its hand but what happens to the queue when it
     * does.
     */
    await executeRun(world.userId, chapterId, runId)

    // Undo the run's automatic pass for one entity, then flag it and re-run the
    // pass: the state the pipeline would have produced had the model hesitated.
    const [entity] = await raw<Array<{ id: string; payload: Record<string, unknown> }>>`
      SELECT id, payload FROM review_items
        WHERE run_id = ${runId} AND category = 'entity' LIMIT 1`
    const localId = String(entity!.payload.local_id)

    const dependants = await raw<Array<{ id: string }>>`
      SELECT id FROM review_items
        WHERE run_id = ${runId} AND category = 'assertion'
          AND (payload->>'subject' = ${localId} OR payload->>'object' = ${localId})`

    await raw`
      UPDATE review_items
         SET status = 'proposed',
             payload = ${raw.json({ ...entity!.payload, naming_confident: false })}
       WHERE id = ${entity!.id}`
    if (dependants.length > 0) {
      await raw`
        UPDATE review_items SET status = 'proposed'
         WHERE id IN ${raw(dependants.map((row) => row.id))}`
    }

    const result = await autoReview(world.userId, runId)

    expect(result.heldForNaming).toBe(1)
    expect(result.heldByName).toBe(dependants.length)

    // Still open, and the chapter with it: a name is a question, and a chapter
    // with a question left is not read.
    const [held] = await raw<Array<{ status: string }>>`
      SELECT status FROM review_items WHERE id = ${entity!.id}`
    expect(held!.status).toBe('proposed')

    // Answering it releases the rest, exactly as the review action does.
    await publishDecisions(world.userId, runId, [
      { reviewItemId: entity!.id, decision: 'accept' },
    ])
    const swept = await autoReview(world.userId, runId)
    expect(swept.accepted).toBe(dependants.length)
    expect((await statuses(runId)).proposed ?? 0).toBe(0)
  })

  it('parks a category publication cannot apply instead of accepting it', async () => {
    const prepared = await run()

    // A rapprochement has no publication path: accepting it would leave it
    // proposed for ever, and a chapter with a proposal left never opens.
    await raw`
      INSERT INTO review_items
        (run_id, chapter_id, user_id, category, priority, payload,
         proposal_fingerprint, requires_explicit_review, confidence, status)
      SELECT ${prepared.runId}, ${prepared.chapterId}, ${prepared.userId}, 'resolution', 95,
             ${raw.json({ candidateLabel: 'Shanks', existingEntityId: 'x', signals: [] })},
             'fp-resolution', true, 0.5, 'proposed'`

    const result = await autoReview(prepared.userId, prepared.runId)

    expect(result.deferred).toBe(1)
    expect(result.accepted).toBe(0)
    expect((await statuses(prepared.runId)).proposed ?? 0).toBe(0)
  })
})
