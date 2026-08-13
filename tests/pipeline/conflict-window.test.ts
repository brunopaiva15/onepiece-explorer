import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ModelProvider } from '@/domains/ai/provider.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { runConflicts } from '@/domains/pipeline/steps/conflicts.ts'
import {
  addAssertion,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Which beliefs a chapter is allowed to contradict.
 *
 * Two questions decided by one `where`, and both had been answered wrongly in a
 * way no unit test could see — the shape of the collision was right, the set it
 * was computed over was not.
 *
 * The chapter under review contradicted *itself*: chapter 5 tells Zoro and
 * Kuina's pact and then Kuina's death, and with both dated to chapter 5 the
 * detector reported a dead character still acting. Nothing in the knowledge
 * window can separate them — it is chapter-grained, so a chapter's own
 * assertions are simultaneous within it.
 *
 * And the live-belief test ran backwards: `knowledge_until_chapter <=` selects
 * the beliefs a chapter has already closed, never the ones still standing,
 * which is the exact complement of what the RLS policy calls visible.
 */

const SUMMARY = [
  'Zoro et Kuina se promettent que l’un d’eux deviendra le plus grand',
  'sabreur du monde, et scellent ce pacte au dojo.',
  '',
  'Le lendemain, Kuina tombe dans les escaliers et meurt.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string
let kuina: string
let zoro: string

const CHAPTER = 5

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: CHAPTER,
    language: 'fr',
    text: SUMMARY,
  })
  chapterId = imported.chapterId

  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `

  kuina = await createEntity(world, 'character', 1)
  zoro = await createEntity(world, 'character', 1)
  await addLabel(world, kuina, 'Kuina', 'true_name', 1, 90)
  await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 1, 90)
})

afterAll(async () => {
  await closeDb()
})

/** One proposal in the queue: Kuina acting. */
async function proposeKuinaActing(): Promise<void> {
  await raw`
    INSERT INTO review_items
      (run_id, chapter_id, user_id, category, priority, payload,
       proposal_fingerprint, requires_explicit_review, confidence, status)
    VALUES (
      ${runId}, ${chapterId}, ${world.userId}, 'assertion', 50,
      ${raw.json({
        subject: kuina,
        predicate: 'promises',
        object: zoro,
        object_value: null,
        epistemic_status: 'explicit',
        evidence: [{ ref: 'b1', kind: 'text', excerpt: 'pacte' }],
        confidence: 0.9,
      })},
      ${`fp-${randomUUID()}`}, false, 0.9, 'proposed'
    )
  `
}

async function conflictsRaised(): Promise<number> {
  await runConflicts({
    userId: world.userId,
    chapterId,
    chapterNumber: CHAPTER,
    runId,
    sourceKind: 'summary',
    // Never touched: a contradiction between two stored assertions is a
    // structural fact, so this step calls no model at all.
    provider: null as unknown as ModelProvider,
  })

  const rows = await raw`
    SELECT count(*)::int AS n FROM review_items
     WHERE run_id = ${runId} AND category = 'conflict'
  `
  return Number(rows[0]?.n ?? 0)
}

describe('the chapter under review', () => {
  it('is not confronted with its own assertions', async () => {
    // Kuina dies in chapter 5 and makes her pact in chapter 5. Both are true,
    // in that order, and the order is not something this step can read.
    await addAssertion(world, {
      subject: kuina,
      predicate: 'dies_at',
      objectValue: 'dojo',
      knowledgeFrom: CHAPTER,
    })
    await proposeKuinaActing()

    expect(await conflictsRaised()).toBe(0)
  })

  it('is still confronted with what came before it', async () => {
    // The same death, learned one chapter earlier: a character acting after a
    // death the reader already knew about is the collision worth reporting.
    await addAssertion(world, {
      subject: kuina,
      predicate: 'dies_at',
      objectValue: 'dojo',
      knowledgeFrom: CHAPTER - 1,
    })
    await proposeKuinaActing()

    expect(await conflictsRaised()).toBe(1)
  })
})

describe('the knowledge window', () => {
  it('confronts a belief still held at this chapter', async () => {
    // Closed at 40, which has not happened yet at chapter 5. The reader holds
    // it, so this chapter can contradict it.
    await addAssertion(world, {
      subject: kuina,
      predicate: 'dies_at',
      objectValue: 'dojo',
      knowledgeFrom: 2,
      knowledgeUntil: 40,
    })
    await proposeKuinaActing()

    expect(await conflictsRaised()).toBe(1)
  })

  it('leaves a belief already dropped alone', async () => {
    // Closed at chapter 3. By chapter 5 nobody holds it any more, and
    // contradicting it is an argument with nobody.
    await addAssertion(world, {
      subject: kuina,
      predicate: 'dies_at',
      objectValue: 'dojo',
      knowledgeFrom: 2,
      knowledgeUntil: 3,
    })
    await proposeKuinaActing()

    expect(await conflictsRaised()).toBe(0)
  })
})
