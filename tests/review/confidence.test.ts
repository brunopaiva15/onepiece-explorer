import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { autoAcceptThreshold, autoReview } from '@/domains/review/auto.ts'
import { AUTO_ACCEPT_CONFIDENCE, confidentEnough } from '@/domains/review/confidence.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * The line under which nothing decides itself.
 *
 * Three quarters, and the number is the whole policy: above it the model's own
 * doubt is not worth a person's attention, below it the card is precisely what
 * a review is for. Its sibling file pins what the automatic pass does with the
 * *categories* — a name, an identity, a contradiction — with the floor turned
 * off, because the synthetic extractor scores everything at a quarter and a
 * floor would hold every card there. This one pins the floor itself.
 *
 * Two things make it safe rather than merely automatic, and both are here. A
 * proposal under the line is left standing — not deferred, which would settle a
 * question nobody answered, and not rejected, which would answer it wrong — so
 * the chapter stays in review and the lot stops on it. And a relation whose
 * subject stayed behind waits with it, for the reason a naming question holds
 * its dependants: published now it would fail on an entity that does not exist,
 * and an automatic pass has nobody to show a failure to.
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

/** Everything still waiting, set to one score, as a model that sure would leave. */
async function scoreEverything(runId: string, confidence: number): Promise<number> {
  const rows = await raw<Array<{ id: string }>>`
    UPDATE review_items SET confidence = ${confidence}
      WHERE run_id = ${runId} AND status = 'proposed' RETURNING id`
  return rows.length
}

beforeEach(async () => {
  await resetDatabase()
  // The mode under test is the automatic pass; the floor is what this file is
  // about, so it is left at its real value rather than set here.
  process.env.AUTO_REVIEW_NAMES_ONLY = '1'
  delete process.env.AUTO_ACCEPT_CONFIDENCE
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
})

afterAll(async () => {
  delete process.env.AUTO_REVIEW_NAMES_ONLY
  delete process.env.AUTO_ACCEPT_CONFIDENCE
  await closeDb()
})

describe('the confidence floor', () => {
  it('holds what the model hedged on, and the chapter with it', async () => {
    /*
     * The synthetic extractor scores its proposals at a quarter, which is an
     * honest answer from something that copies proper nouns out of a page. So a
     * run of it under the real floor accepts nothing at all — and the important
     * half is what that does to the chapter: it stays in review. A chapter
     * opened over cards nobody read is the one mistake this design exists to
     * prevent, and « personne ne les a lues » covers the model as well as the
     * reader.
     */
    const prepared = await run()

    const result = await autoReview(prepared.userId, prepared.runId)
    expect(result.accepted).toBe(0)
    expect(result.heldByConfidence).toBeGreaterThan(0)

    expect((await statuses(prepared.runId)).proposed ?? 0).toBeGreaterThan(0)

    const [chapter] = await raw<Array<{ status: string }>>`
      SELECT status FROM chapters WHERE id = ${prepared.chapterId}`
    expect(chapter!.status).not.toBe('published')
  })

  it('accepts at the threshold exactly, and opens the chapter', async () => {
    const prepared = await run()
    const held = await scoreEverything(prepared.runId, AUTO_ACCEPT_CONFIDENCE)

    const result = await autoReview(prepared.userId, prepared.runId)

    // The line includes itself. A card at exactly three quarters is on the side
    // of the number the setting names; a strict comparison would turn a round
    // figure into a trap for whoever tunes it.
    expect(result.accepted).toBe(held)
    expect(result.heldByConfidence).toBe(0)
    expect((await statuses(prepared.runId)).proposed ?? 0).toBe(0)

    const [chapter] = await raw<Array<{ status: string }>>`
      SELECT status FROM chapters WHERE id = ${prepared.chapterId}`
    expect(chapter!.status).toBe('published')
  })

  it('holds a card a hair under it', async () => {
    const prepared = await run()
    const held = await scoreEverything(prepared.runId, AUTO_ACCEPT_CONFIDENCE - 0.01)

    const result = await autoReview(prepared.userId, prepared.runId)

    expect(result.accepted).toBe(0)
    expect(result.heldByConfidence).toBe(held)
    // Standing, not settled: deferring would record an answer nobody gave, and
    // rejecting would record the wrong one.
    expect((await statuses(prepared.runId)).proposed ?? 0).toBe(held)
    expect((await statuses(prepared.runId)).deferred ?? 0).toBe(0)
  })

  it('makes the relations of a hedged entity wait with it', async () => {
    /*
     * The ordering rule, which is the part a threshold gets wrong on its own.
     * Accepting « Luffy related_to Shanks » while the card proposing Shanks is
     * held publishes a relation against an entity that does not exist — it
     * fails, and in an automatic pass the failure is silent.
     */
    const prepared = await run()
    await scoreEverything(prepared.runId, 0.9)

    const [entity] = await raw<Array<{ id: string; payload: { local_id: string } }>>`
      SELECT id, payload FROM review_items
        WHERE run_id = ${prepared.runId} AND category = 'entity'
          AND status = 'proposed' LIMIT 1`
    const localId = String(entity!.payload.local_id)

    const dependants = await raw<Array<{ id: string }>>`
      SELECT id FROM review_items
        WHERE run_id = ${prepared.runId} AND category = 'assertion'
          AND status = 'proposed'
          AND (payload->>'subject' = ${localId} OR payload->>'object' = ${localId})`
    expect(dependants.length).toBeGreaterThan(0)

    await raw`UPDATE review_items SET confidence = 0.3 WHERE id = ${entity!.id}`

    const result = await autoReview(prepared.userId, prepared.runId)

    expect(result.heldByConfidence).toBe(1)
    expect(result.heldByName).toBe(dependants.length)

    const open = await raw<Array<{ id: string }>>`
      SELECT id FROM review_items
        WHERE run_id = ${prepared.runId} AND status = 'proposed'`
    expect(open.map((row) => row.id).sort()).toEqual(
      [entity!.id, ...dependants.map((row) => row.id)].sort(),
    )
  })

  it('is the environment’s to move, and refuses nonsense', () => {
    expect(autoAcceptThreshold()).toBe(AUTO_ACCEPT_CONFIDENCE)

    process.env.AUTO_ACCEPT_CONFIDENCE = '0.9'
    expect(autoAcceptThreshold()).toBe(0.9)

    // Zero is a setting, not an absence: it means "whatever the categories
    // allow", which is what the suites pinning those categories ask for.
    process.env.AUTO_ACCEPT_CONFIDENCE = '0'
    expect(autoAcceptThreshold()).toBe(0)

    // A typo in an environment file must not silently accept everything.
    for (const nonsense of ['', '  ', 'oui', '75', '-1', '1.5']) {
      process.env.AUTO_ACCEPT_CONFIDENCE = nonsense
      expect(autoAcceptThreshold()).toBe(AUTO_ACCEPT_CONFIDENCE)
    }
  })

  it('draws one line for the board and the pipeline', () => {
    // The review board pre-accepts through this helper and the automatic pass
    // decides through it, so a card that arrives ticked on screen is a card the
    // batch would have taken. Two constants would drift, and the screen would
    // be showing a rule the product no longer runs.
    expect(confidentEnough(AUTO_ACCEPT_CONFIDENCE)).toBe(true)
    expect(confidentEnough(AUTO_ACCEPT_CONFIDENCE - 0.001)).toBe(false)
    expect(confidentEnough(0.8, 0.9)).toBe(false)
    expect(confidentEnough(0.9, 0.9)).toBe(true)
  })
})
