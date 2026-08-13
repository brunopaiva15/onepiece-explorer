import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { closeDb, raw, resetDatabase, seedWorld, type SeededWorld } from '../helpers/db.ts'

/**
 * The last line of defence against one scene stored twice.
 *
 * The card carries the resemblance, and a reviewer walking a queue of eighty at
 * speed will still accept both — which is not a failure of attention so much as
 * the reason the notice is not enough on its own. Publication therefore refuses
 * the pair that is practically the same text, and only that pair.
 *
 * Refusing is a question, not a dead end: rejecting the copy is a real way out
 * and the message says so. That distinction is the whole difference between
 * this and the contradiction path, where accepting has never been able to
 * succeed at all.
 */

const SUMMARY = [
  'Luffy traîne Hermep dans la base pour trouver le sabre de Zoro.',
  '',
  'Il l’utilise comme bouclier humain face aux Marines qui les encerclent.',
].join('\n')

const EVIDENCE = [
  { kind: 'text', ref: 'b1', excerpt: 'Luffy traîne Hermep dans la base' },
]

let world: SeededWorld
let chapterId: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 5,
    language: 'fr',
    text: SUMMARY,
  })
  chapterId = imported.chapterId

  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
})

afterAll(async () => {
  await closeDb()
})

async function proposeEvent(summary: string): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, 'event', 40,
      ${raw.json({ local_id: `ev-${id}`, summary, participants: [], is_flashback: false, evidence: EVIDENCE, confidence: 0.9 })},
      ${randomUUID()}, false, 0.9, 'proposed'
    )
  `
  return id
}

function publish(itemId: string) {
  return publishDecisions(world.userId, runId, [{ reviewItemId: itemId, decision: 'accept' }])
}

async function storedEvents(): Promise<string[]> {
  const rows = await raw`
    SELECT summary FROM events WHERE user_id = ${world.userId} ORDER BY created_at
  `
  return rows.map((row) => row.summary as string)
}

const ORIGINAL =
  'Luffy traîne Hermep dans la base pour trouver le sabre de Zoro et l’utilise comme bouclier humain.'

describe('publishing an event the graph already holds', () => {
  it('refuses the copy and says how to get past it', async () => {
    await publish(await proposeEvent(ORIGINAL))

    const copy = await proposeEvent(`${ORIGINAL.slice(0, -1)} face aux Marines.`)
    const result = await publish(copy)

    expect(result.eventsCreated).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reviewItemId).toBe(copy)
    expect(result.failures[0]!.reason).toContain('Rejetez')
    expect(await storedEvents()).toHaveLength(1)
  })

  it('leaves rejecting the copy as a way out', async () => {
    await publish(await proposeEvent(ORIGINAL))
    const copy = await proposeEvent(`${ORIGINAL.slice(0, -1)} face aux Marines.`)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: copy, decision: 'reject' },
    ])

    expect(result.failures).toHaveLength(0)
    expect(result.rejected).toBe(1)

    // Nothing left proposed, so the refusal never holds the chapter hostage.
    // Asserted on the rows rather than on `chapterPublished`, which reports the
    // *transition* and is null here because the first publication already
    // opened the chapter.
    const [pending] = await raw`
      SELECT count(*)::int AS n FROM review_items
       WHERE run_id = ${runId} AND status = 'proposed'
    `
    expect(Number(pending!.n)).toBe(0)

    const [chapter] = await raw`SELECT status FROM chapters WHERE id = ${chapterId}`
    expect(chapter!.status).toBe('published')
  })

  it('still publishes a scene that merely shares its cast', async () => {
    await publish(await proposeEvent(ORIGINAL))

    const other = await proposeEvent('Zoro promet à Koby de le revoir un jour à Loguetown.')
    const result = await publish(other)

    expect(result.failures).toHaveLength(0)
    expect(result.eventsCreated).toBe(1)
    expect(await storedEvents()).toHaveLength(2)
  })
})

describe('the review card', () => {
  it('carries the resemblance before anyone clicks publish', async () => {
    await publish(await proposeEvent(ORIGINAL))
    const copy = await proposeEvent(
      'Luffy traîne Hermep dans la base pour trouver le sabre de Zoro le lendemain, ' +
        'et l’utilise comme bouclier.',
    )

    const queue = await getReviewQueue(world.userId, runId)
    const card = queue!.items.find((item) => item.id === copy)

    expect(card?.echo).not.toBeNull()
    expect(card?.echo?.label).toBe(ORIGINAL)
    expect(card?.echo?.chapterNumber).toBe(5)
  })
})
