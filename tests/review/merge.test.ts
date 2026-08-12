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
 * « Zoro » au chapitre 3 est Roronoa Zoro, tranché au chapitre 2.
 *
 * A chapter names again someone the graph already knows, under a shorter name
 * or an epithet, and the resolution step raises a rapprochement. Accepting it
 * used to be impossible: publication answered « pas encore implémenté », which
 * left one bad choice and one worse. Accept the entity, and the graph gets a
 * second Zoro that nothing will ever join back — the resolution step compares
 * candidates against published entities, never proposals against each other, so
 * no later run repairs it. Defer it, and the chapter's facts about him are lost
 * with it: every relation naming him fails on a subject that does not exist.
 *
 * So an accepted rapprochement is a merge — the proposal becomes another
 * appearance of the entity you already have. What these tests pin is that it
 * creates nothing, that the chapter's facts land on the existing character, and
 * that it does not quietly rename him.
 */

const SUMMARY = [
  'Out at sea, Koby and Luffy are discussing Luffy’s decision to recruit Zoro.',
  '',
  'Sometime later, they arrive at the Marine base Zoro is being held at.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string
let existingId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  // Roronoa Zoro, settled at chapter 2 and in the graph.
  existingId = await createEntity(world, 'character', 2)
  await addLabel(world, existingId, 'Roronoa Zoro', 'true_name', 2, 100)

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 3,
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

const EVIDENCE = [
  { kind: 'text', ref: 'b1', excerpt: 'Luffy’s decision to recruit Zoro' },
]

async function propose(
  category: string,
  payload: Record<string, unknown>,
  fingerprint = randomUUID(),
): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, ${category}, 50,
      ${raw.json({ evidence: EVIDENCE, confidence: 0.9, ...payload })},
      ${fingerprint}, true, 0.9, 'proposed'
    )
  `
  return { id, fingerprint }
}

async function proposeZoroAgain(): Promise<{
  entity: string
  resolution: string
  relation: string
}> {
  const entity = await propose('entity', {
    local_id: 'e1',
    node_type: 'character',
    label: 'Zoro',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })

  const resolution = await propose('resolution', {
    candidateLabel: 'Zoro',
    candidateFingerprint: entity.fingerprint,
    existingEntityId: existingId,
    score: 0.7,
    suggestion: 'likely_same',
    signals: [],
    modelVerdict: null,
    modelReasoning: null,
  })

  const relation = await propose('assertion', {
    subject: 'e1',
    predicate: 'travels_from',
    object: null,
    object_value: 'la base de la Marine',
    epistemic_status: 'explicit',
  })

  return { entity: entity.id, resolution: resolution.id, relation: relation.id }
}

describe('accepting a rapprochement', () => {
  it('adds no entity and hangs the chapter’s facts on the existing one', async () => {
    const items = await proposeZoroAgain()

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.resolution, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.entitiesCreated).toBe(0)
    expect(result.entitiesMerged).toBe(1)

    const entities = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE user_id = ${world.userId}`
    expect(entities[0]!.count).toBe(1)

    // The whole point: the relation names the character the reader knows.
    const facts = await raw<Array<{ subject_entity_id: string }>>`
      SELECT subject_entity_id FROM assertions WHERE user_id = ${world.userId}`
    expect(facts).toHaveLength(1)
    expect(facts[0]!.subject_entity_id).toBe(existingId)
  })

  it('records the new name without renaming the character', async () => {
    const items = await proposeZoroAgain()

    await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.resolution, decision: 'accept' },
    ])

    const labels = await raw<
      Array<{ label: string; precedence: number; revealed_in_chapter: number }>
    >`SELECT label, precedence, revealed_in_chapter FROM entity_labels
        WHERE entity_id = ${existingId} ORDER BY precedence DESC`

    expect(labels.map((row) => row.label)).toEqual(['Roronoa Zoro', 'Zoro'])
    // Known from chapter 3, because that is the chapter that used it.
    expect(labels[1]!.revealed_in_chapter).toBe(3)
    // And below the settled name, so the display does not move under the
    // reviewer who chose it.
    expect(labels[1]!.precedence).toBeLessThan(labels[0]!.precedence)
  })

  it('does not need the entity card to be decided as well', async () => {
    // The two cards can be forty apart in a queue of eighty; answering « oui,
    // c’est bien lui » once is answering.
    const items = await proposeZoroAgain()

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.resolution, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.entitiesMerged).toBe(1)
    expect(result.failures).toEqual([])

    const [entity] = await raw<Array<{ status: string }>>`
      SELECT status FROM review_items WHERE id = ${items.entity}`
    expect(entity!.status).toBe('accepted')
  })

  it('creates a separate entity when the rapprochement is refused', async () => {
    const items = await proposeZoroAgain()

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
      { reviewItemId: items.resolution, decision: 'reject' },
    ])

    expect(result.entitiesCreated).toBe(1)
    expect(result.entitiesMerged).toBe(0)
    expect(result.rejected).toBe(1)

    const entities = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE user_id = ${world.userId}`
    expect(entities[0]!.count).toBe(2)
  })

  it('says so when the proposal was already published on its own', async () => {
    // Nothing can be un-published, and a merge that cannot run must not report
    // success — the reviewer would be left believing the two are one.
    const items = await proposeZoroAgain()

    await publishDecisions(world.userId, runId, [
      { reviewItemId: items.entity, decision: 'accept' },
    ])

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.resolution, decision: 'accept' },
    ])

    expect(result.entitiesMerged).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toContain('déjà été décidée')
  })
})
