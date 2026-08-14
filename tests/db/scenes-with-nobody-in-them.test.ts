import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
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
 * Les scènes où il n'y avait personne.
 *
 * Publication recorded an event's cast as presence — a row saying « Nami est au
 * chapitre 14 » — and an occurrence points at a chapter, never at the event. So
 * nothing anywhere said « Nami est dans *cette* scène », and the graph drew the
 * consequence: several hundred events and combats as a halo of loose dots
 * around everything else, each of degree zero, reachable from no fiche.
 *
 * `linkCast` writes those relations now. Migration 0026 is for the chapters
 * published before it — which, in a library read up to chapter 54, is all of
 * them. Re-importing would not have healed them: publication joins an accepted
 * entity carrying the same normalised label, so a second pass finds the same
 * scene and reuses it, still joined to nobody.
 *
 * The pre-state is built by publishing normally and then removing exactly the
 * rows the new code adds, so what the migration is handed is what an old
 * library really contains rather than an approximation of it.
 */

const REPAIR = path.join(
  process.cwd(),
  'drizzle',
  '0026_a_scene_and_the_people_who_live_it.sql',
)

const SUMMARY = [
  'Buggy launches a Buggy ball that hits the mayor’s house where Zoro was sleeping.',
  '',
  'Nami has changed her mind about Luffy being a pirate.',
].join('\n')

const EVIDENCE = [{ kind: 'text', ref: 'b1', excerpt: 'Buggy launches a Buggy ball' }]

let world: SeededWorld
let chapterId: string
let runId: string
let zoroId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  zoroId = await createEntity(world, 'character', 1)
  await addLabel(world, zoroId, 'Roronoa Zoro', 'true_name', 1, 100)

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 14,
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
      ${randomUUID()}, false, 0.9, 'proposed'
    )
  `
  return id
}

function entity(
  localId: string,
  nodeType: string,
  label: string,
): Record<string, unknown> {
  return {
    local_id: localId,
    node_type: nodeType,
    label,
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  }
}

function scene(participants: string[]): Record<string, unknown> {
  return {
    local_id: 'ev1',
    summary: 'Baggy tire un Buggy Ball sur la maison du maire où dormait Zoro.',
    participants,
    is_flashback: false,
  }
}

async function repair(): Promise<void> {
  await raw.unsafe(await readFile(REPAIR, 'utf8')).simple()
}

interface Edge {
  subject_entity_id: string
  predicate: string
  object_entity_id: string
  knowledge_from_chapter: number
  epistemic_status: string
}

async function edges(): Promise<Edge[]> {
  return raw<Edge[]>`
    SELECT subject_entity_id, predicate, object_entity_id,
           knowledge_from_chapter, epistemic_status::text AS epistemic_status
      FROM assertions
     WHERE user_id = ${world.userId}
       AND predicate IN ('participates_in', 'located_at')`
}

/** The library as it stood before `linkCast`: scenes published, joined to nobody. */
async function unlink(): Promise<void> {
  await raw.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_destructive', 'on', true)`
    await tx`
      DELETE FROM assertions
       WHERE user_id = ${world.userId}
         AND predicate IN ('participates_in', 'located_at')`
  })
}

async function idOf(label: string): Promise<string> {
  const [row] = await raw<Array<{ id: string }>>`
    SELECT e.id FROM entities e
      JOIN entity_labels l ON l.entity_id = e.id
     WHERE e.user_id = ${world.userId} AND l.label = ${label}`
  return row!.id
}

async function sceneId(): Promise<string> {
  const [row] = await raw<Array<{ entity_id: string }>>`
    SELECT entity_id FROM events WHERE user_id = ${world.userId}`
  return row!.entity_id
}

describe('scenes published before their cast was drawn', () => {
  it('joins each one to the people the reviewer accepted with it', async () => {
    const nami = await propose('entity', entity('e1', 'character', 'Nami'))
    // Both shapes a participant identifier takes: a local id from this run, and
    // a UUID for someone already in the graph.
    const event = await propose('event', scene(['e1', zoroId]))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])
    await unlink()
    expect(await edges()).toEqual([])

    await repair()

    const target = await sceneId()
    const drawn = await edges()
    expect(drawn).toHaveLength(2)
    for (const edge of drawn) {
      expect(edge.predicate).toBe('participates_in')
      expect(edge.object_entity_id).toBe(target)
      // Dated by the chapter that stated it, never by the day of the repair.
      expect(edge.knowledge_from_chapter).toBe(14)
      expect(edge.epistemic_status).toBe('explicit')
    }
    expect(drawn.map((edge) => edge.subject_entity_id).sort()).toEqual(
      [await idOf('Nami'), zoroId].sort(),
    )
  })

  it('finds a participant whose proposal was joined to an entity already there', async () => {
    /*
     * The common case, and the one a local id alone cannot answer: a character
     * re-proposed in a chapter they already appear in is *reused* rather than
     * created, and publication records `proposal_local_id` only on a row it
     * creates. « e1 » then names a row that never carried it.
     */
    const zoro = await propose('entity', entity('e1', 'character', 'Roronoa Zoro'))
    const event = await propose('event', scene(['e1']))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: zoro, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])
    expect(result.entitiesReused).toBe(1)

    await unlink()
    await repair()

    const drawn = await edges()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.subject_entity_id).toBe(zoroId)
  })

  it('puts the scene at the place its cast names', async () => {
    const village = await propose('entity', entity('p1', 'place', 'Village d’Orange'))
    const event = await propose('event', scene(['p1']))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: village, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])
    await unlink()
    await repair()

    const drawn = await edges()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.predicate).toBe('located_at')
    expect(drawn[0]!.subject_entity_id).toBe(await sceneId())
    expect(drawn[0]!.object_entity_id).toBe(await idOf('Village d’Orange'))
  })

  it('says nothing about a participant whose own card was refused', async () => {
    const nami = await propose('entity', entity('e1', 'character', 'Nami'))
    const event = await propose('event', scene(['e1', zoroId]))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'reject' },
      { reviewItemId: event, decision: 'accept' },
    ])
    await unlink()
    await repair()

    const drawn = await edges()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.subject_entity_id).toBe(zoroId)
  })

  it('leaves a rejected scene out of the graph', async () => {
    const event = await propose('event', scene([zoroId]))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: event, decision: 'reject' },
    ])
    await repair()

    expect(await edges()).toEqual([])
  })

  it('draws nothing twice, however often it is re-run', async () => {
    /*
     * Assertions are append-only: a duplicate written by a repair could not be
     * taken back. `pnpm db:push` is re-run on every deploy, and the migration
     * ledger is not the only line of defence — this is.
     */
    const nami = await propose('entity', entity('e1', 'character', 'Nami'))
    const event = await propose('event', scene(['e1', zoroId]))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])

    // Not even once on a library that already has the relations: publication
    // wrote them a moment ago.
    await repair()
    expect(await edges()).toHaveLength(2)

    await repair()
    await repair()
    expect(await edges()).toHaveLength(2)
  })
})
