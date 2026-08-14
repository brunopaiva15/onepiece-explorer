import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { getTimeline } from '@/domains/temporal/timeline.ts'
import {
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * A question the story answers stops being an open question.
 *
 * `résout le mystère` has been in the ontology since it was written and was
 * published like any other edge — into `assertions`, and no further. The
 * question's own row kept `state = 'open'` and `resolved_in_chapter` null for
 * ever, so /mysteres, which decides open-or-closed by reading that column,
 * could only ever show « Ouverte ». Seventy-one questions across fifty-nine
 * chapters, including ones answered on the next page.
 *
 * What is asserted here is the join between the two halves — the edge and the
 * state — and the dates, which are the part that is easy to get subtly wrong:
 * the earliest answer is the one the reader met, and re-opening only undoes a
 * resolution it actually invalidates.
 */

const SUMMARY = [
  'Zoro esquive les attaques de Cabaji et l’éjecte de son monocycle.',
  '',
  'Il l’achève avec son attaque Oni Giri, puis s’effondre d’épuisement.',
].join('\n')

/** An excerpt of the passage above, so the anchoring trigger accepts it. */
const EVIDENCE = [{ kind: 'text', ref: 'b2', excerpt: 'Il l’achève avec son attaque Oni Giri' }]

let world: SeededWorld
let mysteryId: string
let zoroId: string

/** Runs keyed by chapter number, so a test can publish into either. */
const runs = new Map<number, { runId: string; chapterId: string }>()

async function chapterRun(number: number): Promise<{ runId: string; chapterId: string }> {
  const existing = runs.get(number)
  if (existing) return existing

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: number,
    language: 'fr',
    text: SUMMARY,
  })
  const runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${imported.chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
  const run = { runId, chapterId: imported.chapterId }
  runs.set(number, run)
  return run
}

/** A `résout le mystère` card, waiting on a decision like any other. */
async function proposeVerdict(
  predicate: 'resolves_mystery' | 'reopens_mystery',
  chapterNumber: number,
): Promise<{ itemId: string; runId: string }> {
  const { runId, chapterId } = await chapterRun(chapterNumber)
  const itemId = randomUUID()

  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${itemId}, ${runId}, ${chapterId}, ${world.userId}, 'assertion', 80,
      ${raw.json({
        subject: zoroId,
        predicate,
        object: mysteryId,
        object_value: null,
        epistemic_status: 'explicit',
        evidence: EVIDENCE,
        confidence: 0.95,
      })},
      ${randomUUID()}, true, 0.95, 'proposed'
    )
  `

  return { itemId, runId }
}

async function storedMystery(): Promise<{ state: string; resolvedIn: number | null }> {
  const [row] = await raw`
    SELECT state, resolved_in_chapter FROM mysteries WHERE entity_id = ${mysteryId}
  `
  return { state: row!.state as string, resolvedIn: row!.resolved_in_chapter as number | null }
}

beforeEach(async () => {
  await resetDatabase()
  runs.clear()
  world = await seedWorld([])

  zoroId = await createEntity(world, 'character', 16)
  await addLabel(world, zoroId, 'Roronoa Zoro', 'true_name', 16, 100)

  mysteryId = await createEntity(world, 'mystery', 16)
  await addLabel(
    world,
    mysteryId,
    'Zoro parviendra-t-il à vaincre Cabaji malgré sa blessure aggravée ?',
    'alias',
    16,
    10,
  )
  await addMystery(world, mysteryId, {
    question: 'Zoro parviendra-t-il à vaincre Cabaji malgré sa blessure aggravée ?',
    openedIn: 16,
  })
})

afterAll(async () => {
  await closeDb()
})

describe('accepting « résout le mystère »', () => {
  it('closes the question at the chapter that answered it', async () => {
    const { itemId, runId } = await proposeVerdict('resolves_mystery', 17)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    expect(result.assertionsCreated).toBe(1)
    expect(result.mysteriesResolved).toBe(1)
    expect(await storedMystery()).toEqual({ state: 'resolved', resolvedIn: 17 })
  })

  it('shows the question as closed to a reader past that chapter, and open before it', async () => {
    const { itemId, runId } = await proposeVerdict('resolves_mystery', 17)
    await publishDecisions(world.userId, runId, [{ reviewItemId: itemId, decision: 'accept' }])

    const before = await getTimeline(world.userId, 16)
    const after = await getTimeline(world.userId, 17)

    /*
     * The anti-spoiler property, restated where it now has something to protect.
     * A resolution beyond the reader's boundary is nulled by the projection, so
     * /mysteres asks « refermée pour vous » rather than « refermée quelque part ».
     * Before this change the question could not be closed at all, which made
     * that guarantee vacuous.
     */
    expect(before.byRevelation.find((e) => e.entityId === mysteryId)?.resolvedInChapter).toBeNull()
    expect(after.byRevelation.find((e) => e.entityId === mysteryId)?.resolvedInChapter).toBe(17)
  })

  it('keeps the earliest answer when a later chapter says it again', async () => {
    const first = await proposeVerdict('resolves_mystery', 17)
    await publishDecisions(world.userId, first.runId, [
      { reviewItemId: first.itemId, decision: 'accept' },
    ])

    const second = await proposeVerdict('resolves_mystery', 30)
    const result = await publishDecisions(world.userId, second.runId, [
      { reviewItemId: second.itemId, decision: 'accept' },
    ])

    // The relation is still recorded — chapter 30 does say it — but the reader
    // learned the answer at 17, and that is the date the question carries.
    expect(result.assertionsCreated).toBe(1)
    expect(result.mysteriesResolved).toBe(0)
    expect(await storedMystery()).toEqual({ state: 'resolved', resolvedIn: 17 })
  })

  it('leaves the question open when the relation is rejected', async () => {
    const { itemId, runId } = await proposeVerdict('resolves_mystery', 17)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'reject' },
    ])

    expect(result.rejected).toBe(1)
    expect(result.mysteriesResolved).toBe(0)
    expect(await storedMystery()).toEqual({ state: 'open', resolvedIn: null })
  })
})

describe('accepting « réouvre le mystère »', () => {
  it('undoes a resolution the chapter invalidates', async () => {
    const resolved = await proposeVerdict('resolves_mystery', 17)
    await publishDecisions(world.userId, resolved.runId, [
      { reviewItemId: resolved.itemId, decision: 'accept' },
    ])

    const reopened = await proposeVerdict('reopens_mystery', 30)
    const result = await publishDecisions(world.userId, reopened.runId, [
      { reviewItemId: reopened.itemId, decision: 'accept' },
    ])

    expect(result.mysteriesReopened).toBe(1)
    expect(await storedMystery()).toEqual({ state: 'reopened', resolvedIn: null })
  })

  it('leaves a later answer standing', async () => {
    const resolved = await proposeVerdict('resolves_mystery', 30)
    await publishDecisions(world.userId, resolved.runId, [
      { reviewItemId: resolved.itemId, decision: 'accept' },
    ])

    /*
     * Chapter 17 doubting an answer chapter 30 gives is not a contradiction, it
     * is the order the reader met them in — and publishing the earlier card
     * second must not lose the later answer.
     */
    const reopened = await proposeVerdict('reopens_mystery', 17)
    const result = await publishDecisions(world.userId, reopened.runId, [
      { reviewItemId: reopened.itemId, decision: 'accept' },
    ])

    expect(result.mysteriesReopened).toBe(0)
    expect(await storedMystery()).toEqual({ state: 'resolved', resolvedIn: 30 })
  })
})
