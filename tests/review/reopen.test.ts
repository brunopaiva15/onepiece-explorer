import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { reopenItems } from '@/domains/review/reopen.ts'
import {
  closeDb,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Taking back a decision.
 *
 * A rejection closed the item *and* recorded the verdict against its
 * fingerprint, so a re-import skipped the proposal rather than asking again.
 * Right for a correction that should survive; fatal for a mistake, which had no
 * way back and took the chapter's relations with it — « le sujet e5 n'existe
 * pas dans le graphe : son entité a été rejetée. Acceptez-la d'abord » named an
 * operation the interface did not have.
 */

const SUMMARY = [
  'Out at sea, Koby and Luffy are discussing the crew they mean to gather.',
  '',
  'Sometime later, they arrive at the Marine base where the swordsman is held.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

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

async function proposeEntity(): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, 'entity', 50,
      ${raw.json({
        local_id: 'e5',
        node_type: 'character',
        label: 'Koby',
        label_kind: 'true_name',
        source_term: null,
        naming_confident: true,
        evidence: [{ kind: 'text', ref: 'b1', excerpt: 'Koby and Luffy' }],
        confidence: 0.9,
      })},
      ${randomUUID()}, true, 0.9, 'proposed'
    )
  `
  return id
}

async function statusOf(id: string): Promise<string> {
  const rows = await raw<Array<{ status: string }>>`
    SELECT status FROM review_items WHERE id = ${id}`
  return rows[0]!.status
}

async function decisionCount(): Promise<number> {
  const rows = await raw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM review_decisions WHERE user_id = ${world.userId}`
  return rows[0]!.count
}

describe('reopening a rejected proposal', () => {
  it('puts it back in the queue', async () => {
    const item = await proposeEntity()
    await publishDecisions(world.userId, runId, [
      { reviewItemId: item, decision: 'reject' },
    ])
    expect(await statusOf(item)).toBe('rejected')

    const result = await reopenItems(world.userId, runId, [item])

    expect(result.reopened).toBe(1)
    expect(await statusOf(item)).toBe('proposed')
  })

  it('erases the recorded verdict, so a re-import asks again', async () => {
    /*
     * Without this the item comes back and the next re-import answers it
     * silently with the answer that was just withdrawn — extraction skips any
     * fingerprint it finds in review_decisions.
     */
    const item = await proposeEntity()
    await publishDecisions(world.userId, runId, [
      { reviewItemId: item, decision: 'reject' },
    ])
    expect(await decisionCount()).toBe(1)

    await reopenItems(world.userId, runId, [item])

    expect(await decisionCount()).toBe(0)
  })

  it('reopens a deferred one too', async () => {
    const item = await proposeEntity()
    await publishDecisions(world.userId, runId, [
      { reviewItemId: item, decision: 'defer' },
    ])
    expect(await statusOf(item)).toBe('deferred')

    expect((await reopenItems(world.userId, runId, [item])).reopened).toBe(1)
    expect(await statusOf(item)).toBe('proposed')
  })

  it('refuses to reopen something already in the graph', async () => {
    /*
     * An accepted proposal is a row in the graph, and taking it back is a
     * different operation with different consequences — chapter deletion, which
     * exists and says what it destroys.
     */
    const item = await proposeEntity()
    await publishDecisions(world.userId, runId, [
      { reviewItemId: item, decision: 'accept' },
    ])
    expect(await statusOf(item)).toBe('accepted')

    expect((await reopenItems(world.userId, runId, [item])).reopened).toBe(0)
    expect(await statusOf(item)).toBe('accepted')
  })

  it('does not reopen another reader’s items', async () => {
    const item = await proposeEntity()
    await publishDecisions(world.userId, runId, [
      { reviewItemId: item, decision: 'reject' },
    ])

    const stranger = await seedWorld([])
    const result = await reopenItems(stranger.userId, runId, [item])

    expect(result.reopened).toBe(0)
    expect(await statusOf(item)).toBe('rejected')
  })
})

/**
 * One nonsensical edge must not take the batch with it.
 *
 * The ontology is enforced by a trigger — « destroys » takes an object, a place
 * or a group, never a character — and that is where it belongs. What did not
 * belong was the consequence: the exception escaped the whole publication, so
 * one bad relation out of eighty discarded the seventy-nine good ones and put a
 * raw INSERT statement on the reader's screen.
 */
describe('a relation the ontology refuses', () => {
  it('is reported, and the rest of the chapter is published', async () => {
    const luffy = randomUUID()
    const koby = randomUUID()
    for (const id of [luffy, koby]) {
      await raw`
        INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
        VALUES (${id}, ${world.workId}, ${world.userId}, 'character', 1, 'accepted')`
    }

    const evidence = [{ kind: 'text', ref: 'b1', excerpt: 'Koby and Luffy' }]
    const propose = async (payload: Record<string, unknown>) => {
      const id = randomUUID()
      await raw`
        INSERT INTO review_items (
          id, run_id, chapter_id, user_id, category, priority, payload,
          proposal_fingerprint, requires_explicit_review, confidence, status
        ) VALUES (
          ${id}, ${runId}, ${chapterId}, ${world.userId}, 'assertion', 50,
          ${raw.json({ evidence, confidence: 0.9, ...payload })},
          ${randomUUID()}, false, 0.9, 'proposed'
        )`
      return id
    }

    // « détruit » un personnage : refusé par l'ontologie.
    const bad = await propose({
      subject: luffy,
      predicate: 'destroys',
      object: koby,
      object_value: null,
      epistemic_status: 'explicit',
    })
    // « rencontre » deux personnages : parfaitement valide.
    const good = await propose({
      subject: luffy,
      predicate: 'meets',
      object: koby,
      object_value: null,
      epistemic_status: 'explicit',
    })

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: bad, decision: 'accept' },
      { reviewItemId: good, decision: 'accept' },
    ])

    expect(result.assertionsCreated).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toContain('destroys')
    // The message is the database's own, not a dump of the statement.
    expect(result.failures[0]!.reason).not.toContain('insert into')

    const rows = await raw<Array<{ predicate: string }>>`
      SELECT predicate FROM assertions WHERE user_id = ${world.userId}`
    expect(rows.map((row) => row.predicate)).toEqual(['meets'])
  })
})
