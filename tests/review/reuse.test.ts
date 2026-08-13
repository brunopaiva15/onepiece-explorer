import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Importing a thousand chapters before reviewing any of them.
 *
 * The resolution step compares a proposal against what is *accepted*, and it
 * runs at import. Import chapter 6, 7 and 8 back to back and that comparison
 * sees nothing: each of them re-proposes the same characters, no rapprochement
 * is ever offered, and publishing them creates three Shanks that nothing will
 * join. The instruction that followed — publish between every import — is not
 * one anybody can follow eleven hundred times.
 *
 * So publication looks for the same name itself, at the one moment the accepted
 * set is current: its own. What these tests pin is that it joins on an exact
 * name and on nothing weaker, that the chapter's relations land on the entity
 * it joined, and that the join is counted rather than silent.
 */

const SUMMARY = [
  'Out at sea, Koby and Luffy are discussing the crew they mean to gather.',
  '',
  'Sometime later, they arrive at the Marine base where the swordsman is held.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string
let existingId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  existingId = await createEntity(world, 'character', 1)
  await addLabel(world, existingId, 'Monkey D. Luffy', 'true_name', 1, 100)

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 2,
    language: 'en',
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

const EVIDENCE = [{ kind: 'text', ref: 'b1', excerpt: 'Koby and Luffy' }]

async function propose(
  category: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, ${category}, 50,
      ${raw.json({ evidence: EVIDENCE, confidence: 0.9, ...payload })},
      ${randomUUID()}, true, 0.9, 'proposed'
    )
  `
  return id
}

async function proposeAgain(label: string, nodeType = 'character') {
  const entity = await propose('entity', {
    local_id: 'e1',
    node_type: nodeType,
    label,
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const relation = await propose('assertion', {
    subject: 'e1',
    predicate: 'travels_from',
    object: null,
    object_value: 'la base de la Marine',
    epistemic_status: 'explicit',
  })
  return { entity, relation }
}

async function countEntities(): Promise<number> {
  const rows = await raw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM entities WHERE user_id = ${world.userId}`
  return rows[0]!.count
}

describe('a proposal that is a character you already have', () => {
  it('joins it instead of creating a second one, with no rapprochement asked', async () => {
    const items = await proposeAgain('Monkey D. Luffy')

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.entitiesCreated).toBe(0)
    expect(result.entitiesReused).toBe(1)
    expect(await countEntities()).toBe(1)
  })

  it('hangs the chapter’s relations on the entity it joined', async () => {
    const items = await proposeAgain('Monkey D. Luffy')

    await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    // The whole reason this exists: a relation proposed by a later chapter
    // reaches the character the reader already knows.
    const facts = await raw<Array<{ subject_entity_id: string }>>`
      SELECT subject_entity_id FROM assertions WHERE user_id = ${world.userId}`
    expect(facts).toHaveLength(1)
    expect(facts[0]!.subject_entity_id).toBe(existingId)
  })

  it('says so, rather than joining quietly', async () => {
    const items = await proposeAgain('Monkey D. Luffy')

    await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    const audit = await raw<Array<{ subject_id: string; detail: { label: string } }>>`
      SELECT subject_id, detail FROM audit_log
       WHERE user_id = ${world.userId} AND action = 'entity_reused'`
    expect(audit).toHaveLength(1)
    expect(audit[0]!.subject_id).toBe(existingId)
    expect(audit[0]!.detail.label).toBe('Monkey D. Luffy')
  })
})

describe('what it refuses to join', () => {
  it('does not join a shorter name to a longer one', async () => {
    // « Luffy » really is Monkey D. Luffy, and saying so is the resolution
    // step's job — it asks. Answering it here without asking is the one thing
    // this must not start doing.
    const items = await proposeAgain('Luffy')

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.entitiesReused).toBe(0)
    expect(result.entitiesCreated).toBe(1)
    expect(await countEntities()).toBe(2)
  })

  it('does not join across node types', async () => {
    // A place called « Monkey D. Luffy » is absurd and that is the point: the
    // name alone must not be enough. Only the entity is published here — the
    // relation would be refused by the ontology trigger, for its own reasons.
    const items = await proposeAgain('Monkey D. Luffy', 'place')

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
    ])

    expect(result.entitiesReused).toBe(0)
    expect(result.entitiesCreated).toBe(1)
  })

  it('does not join an entity the reader has not met yet', async () => {
    /*
     * A character first seen at chapter 40 cannot be who chapter 2 is naming,
     * however identical the string. Without the bound, publishing an early
     * chapter after a late one would reach forward and join the two.
     */
    const later = await createEntity(world, 'character', 40)
    await addLabel(world, later, 'Kaelo Renn', 'true_name', 40, 100)
    const items = await proposeAgain('Kaelo Renn')

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.entitiesReused).toBe(0)
    expect(result.entitiesCreated).toBe(1)
  })
})
