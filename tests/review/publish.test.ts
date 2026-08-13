import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importChapter } from '@/domains/ingestion/import.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions, type Decision } from '@/domains/review/publish.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { LocalFsStorage } from '@/domains/storage/local-storage.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * Publication: the only door into the graph.
 *
 * Four properties have to hold, and each prevents a specific failure. Atomicity,
 * because half a delta is a graph with dangling references and no way to tell
 * which half ran. Idempotency, because a double-clicked button must not double
 * the graph. Dating by revelation rather than by import, because otherwise the
 * boundary slider shows the wrong past. And recording every decision, because
 * that is what makes it survive a re-import.
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

let storageRoot: string
let adapter: LocalFsStorage

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)))
}

interface Prepared {
  userId: string
  workId: string
  chapterId: string
  runId: string
}

async function prepare(chapterNumber = 1): Promise<Prepared> {
  const world = await seedWorld([])
  const imported = await importChapter({
    userId: world.userId,
    workId: world.workId,
    chapterNumber,
    file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
    limits,
    adapter,
  })
  const runId = await createRun(world.userId, imported.chapterId)
  await executeRun(world.userId, imported.chapterId, runId)
  return {
    userId: world.userId,
    workId: world.workId,
    chapterId: imported.chapterId,
    runId,
  }
}

beforeEach(async () => {
  await resetDatabase()
  storageRoot = await mkdtemp(path.join(tmpdir(), 'ope-publish-'))
  adapter = new LocalFsStorage({ root: storageRoot, secret: 'test', defaultTtl: 60 })
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_ROOT = storageRoot
  process.env.MODEL_PROVIDER = 'synthetic'

  const { resetStorageCache } = await import('@/domains/storage/index.ts')
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetStorageCache()
  resetModelProvider()
})

afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await closeDb()
})

describe('the review queue', () => {
  it('shows every proposal with the evidence it came from', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    expect(queue).not.toBeNull()
    expect(queue!.items.length).toBeGreaterThan(0)

    /*
     * The property that makes review possible rather than an act of faith. A
     * proposal shown without its source turns "is this right" into "do I trust
     * the model today".
     */
    for (const item of queue!.items) {
      expect(item.evidence.length).toBeGreaterThan(0)
      expect(item.evidence.every((e) => e.excerpt.length > 0)).toBe(true)
      // At least one citation resolves to something the reviewer can look at.
      expect(
        item.evidence.some((e) => e.blockText !== null || e.panelImageUrl !== null),
      ).toBe(true)
    }
  })

  it('puts the proposals that cannot be undone first', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    const priorities = queue!.items.map((item) => item.priority)
    // Descending: a queue in insertion order buries identity behind forty easy
    // relations and gets them approved by momentum.
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a))
  })
})

describe('publishing', () => {
  it('creates entities, their labels, and the relations that reference them', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    const decisions: Decision[] = queue!.items.map((item) => ({
      reviewItemId: item.id,
      decision: 'accept',
    }))

    const result = await publishDecisions(userId, runId, decisions)

    expect(result.entitiesCreated).toBeGreaterThan(0)
    expect(result.labelsCreated).toBe(
      result.entitiesCreated + result.eventsCreated + result.mysteriesCreated,
    )

    const [entities] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE review_status = 'accepted'
    `
    expect(entities!.count).toBe(
      result.entitiesCreated + result.eventsCreated + result.mysteriesCreated,
    )

    // Every published assertion points at a real entity. A dangling reference
    // is the failure atomicity exists to prevent.
    const [dangling] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM assertions a
      LEFT JOIN entities e ON e.id = a.subject_entity_id
      WHERE e.id IS NULL
    `
    expect(dangling!.count).toBe(0)
  })

  it('dates knowledge to the chapter that revealed it, not to the import', async () => {
    /*
     * Chapter 40, imported first. If publication stamped "now" or used an import
     * counter, the boundary slider would show chapter 40's facts as known at
     * chapter 1 — the exact leak the whole design exists to prevent.
     */
    const { userId, runId } = await prepare(40)
    const queue = await getReviewQueue(userId, runId)

    await publishDecisions(
      userId,
      runId,
      queue!.items.map((item) => ({ reviewItemId: item.id, decision: 'accept' as const })),
    )

    const rows = await raw<Array<{ knowledge_from_chapter: number }>>`
      SELECT knowledge_from_chapter FROM assertions
    `
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.knowledge_from_chapter === 40)).toBe(true)

    const labels = await raw<Array<{ revealed_in_chapter: number }>>`
      SELECT revealed_in_chapter FROM entity_labels
    `
    expect(labels.every((row) => row.revealed_in_chapter === 40)).toBe(true)
  })

  it('is idempotent: publishing the same decisions twice changes nothing', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)
    const decisions: Decision[] = queue!.items.map((item) => ({
      reviewItemId: item.id,
      decision: 'accept',
    }))

    const first = await publishDecisions(userId, runId, decisions)
    const second = await publishDecisions(userId, runId, decisions)

    expect(first.entitiesCreated).toBeGreaterThan(0)
    // A double-clicked button, a retried request: nothing new.
    expect(second.entitiesCreated).toBe(0)
    expect(second.assertionsCreated).toBe(0)

    const [entities] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities
    `
    expect(entities!.count).toBe(
      first.entitiesCreated + first.eventsCreated + first.mysteriesCreated,
    )
  })

  it('records every decision against its fingerprint', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    const first = queue!.items[0]!
    await publishDecisions(userId, runId, [
      { reviewItemId: first.id, decision: 'reject', comment: 'Faux positif.' },
    ])

    const [decision] = await raw<Array<{ decision: string; comment: string }>>`
      SELECT decision, comment FROM review_decisions
      WHERE proposal_fingerprint = ${first.fingerprint}
    `
    expect(decision?.decision).toBe('reject')
    expect(decision?.comment).toBe('Faux positif.')
  })

  it('marks a corrected assertion as the user’s own, and locks it', async () => {
    /*
     * The locked flag is what stops a later run superseding a human's own words.
     * Without it, re-importing after a correction would quietly restore the
     * model's version — which is the single most demoralising thing a review
     * tool can do.
     */
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)
    const assertion = queue!.items.find((item) => item.category === 'assertion')
    expect(assertion).toBeDefined()

    const corrected = {
      ...(assertion!.payload as Record<string, unknown>),
      epistemic_status: 'explicit',
    }

    // The entities the relation names have to be accepted in the same batch —
    // that is why decisions are published together rather than per click.
    const entityDecisions: Decision[] = queue!.items
      .filter((item) => item.category === 'entity')
      .map((item) => ({ reviewItemId: item.id, decision: 'accept' as const }))

    const published = await publishDecisions(userId, runId, [
      ...entityDecisions,
      { reviewItemId: assertion!.id, decision: 'correct', correctedPayload: corrected },
    ])
    expect(published.failures).toEqual([])

    const [row] = await raw<
      Array<{ proposed_by: string; locked: boolean; epistemic_status: string }>
    >`
      SELECT proposed_by, locked, epistemic_status FROM assertions
      WHERE proposal_fingerprint = ${assertion!.fingerprint}
    `
    expect(row?.proposed_by).toBe('user')
    expect(row?.locked).toBe(true)
    expect(row?.epistemic_status).toBe('user_validated')
  })

  it('refuses an assertion whose subject was rejected, and says why', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    const entity = queue!.items.find((item) => item.category === 'entity')
    const assertion = queue!.items.find((item) => item.category === 'assertion')
    expect(entity).toBeDefined()
    expect(assertion).toBeDefined()

    // Reject the entity, accept a relation that names it.
    const result = await publishDecisions(userId, runId, [
      { reviewItemId: entity!.id, decision: 'reject' },
      { reviewItemId: assertion!.id, decision: 'accept' },
    ])

    const payload = assertion!.payload as { subject: string }
    if (payload.subject === (entity!.payload as { local_id: string }).local_id) {
      // Silently dropping it would leave the user wondering; the message names
      // the missing entity and what to do about it.
      expect(result.failures.length).toBeGreaterThan(0)
      expect(result.failures[0]!.reason).toMatch(/n'existe pas dans le graphe/)
    }
  })

  it('writes an audit entry for the publication', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    await publishDecisions(userId, runId, [
      { reviewItemId: queue!.items[0]!.id, decision: 'accept' },
    ])

    const [entry] = await raw<Array<{ action: string; subject_id: string }>>`
      SELECT action, subject_id FROM audit_log WHERE user_id = ${userId}
    `
    expect(entry?.action).toBe('publish_delta')
    expect(entry?.subject_id).toBe(runId)
  })

  it('leaves deferred items in the queue rather than deciding them', async () => {
    const { userId, runId } = await prepare()
    const queue = await getReviewQueue(userId, runId)

    await publishDecisions(userId, runId, [
      { reviewItemId: queue!.items[0]!.id, decision: 'defer' },
    ])

    const [row] = await raw<Array<{ status: string }>>`
      SELECT status FROM review_items WHERE id = ${queue!.items[0]!.id}
    `
    expect(row?.status).toBe('deferred')

    // And no decision is recorded: deferring is explicitly not an answer, so
    // recording one would suppress the question on the next import.
    const [decision] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM review_decisions
      WHERE proposal_fingerprint = ${queue!.items[0]!.fingerprint}
    `
    expect(decision!.count).toBe(0)
  })
})

/**
 * Which sort of node a scene becomes.
 *
 * « Combat » was in the ontology, on the graph's filter bar and in the
 * palette, and this line decided that nothing would ever be one: publication
 * read the review item's *category*, which is `event` for every extracted
 * scene, and wrote `event` as the node type. Ten chapters in, the filter was
 * empty and the only available reading was that combats went undetected.
 */
describe('an event and the sort of scene it is', () => {
  /*
   * The event is queued directly rather than extracted.
   *
   * The synthetic provider proposes entities and relations and no events at
   * all, and what is under test here is the one line publication runs on a
   * scene — not the extraction that produced it. Writing the review item is
   * also the only way to reproduce the case that matters most: a payload with
   * no `kind` at all, which is every proposal queued before this version.
   */
  async function publishEvent(payload: Record<string, unknown>): Promise<string | undefined> {
    const { userId, chapterId, runId } = await prepare()

    const [row] = await raw<Array<{ id: string }>>`
      INSERT INTO review_items
        (run_id, chapter_id, user_id, category, priority, payload,
         proposal_fingerprint, requires_explicit_review, confidence)
      VALUES
        (${runId}, ${chapterId}, ${userId}, 'event', 40,
         ${JSON.stringify({
           local_id: 'ev1',
           participants: [],
           is_flashback: false,
           evidence: [{ ref: 'block:1', kind: 'text', excerpt: 'x' }],
           confidence: 0.9,
           ...payload,
         })}::jsonb,
         ${`test:${String(payload.summary)}`}, false, 0.9)
      RETURNING id
    `

    await publishDecisions(userId, runId, [
      { reviewItemId: row!.id, decision: 'accept' },
    ])

    const found = await raw<Array<{ node_type: string }>>`
      SELECT e.node_type FROM entities e
      JOIN events ev ON ev.entity_id = e.id
      WHERE ev.summary = ${String(payload.summary)}
    `
    return found[0]?.node_type
  }

  it('is published as a combat when the extraction says so', async () => {
    expect(
      await publishEvent({ kind: 'battle', summary: 'Zoro affronte Baggy en duel.' }),
    ).toBe('battle')
  })

  it('is published as a voyage when the extraction says so', async () => {
    expect(
      await publishEvent({ kind: 'voyage', summary: 'Luffy prend la mer pour le Grand Line.' }),
    ).toBe('voyage')
  })

  /*
   * What the model said wins, even against the words it wrote. The summary
   * here reads as a fight and the classification says otherwise; only one of
   * the two actually read the passage.
   */
  it('believes the stated kind over the summary’s vocabulary', async () => {
    expect(
      await publishEvent({
        kind: 'event',
        summary: 'Koby raconte comment Alvida a vaincu son équipage.',
      }),
    ).toBe('event')
  })

  /*
   * A proposal queued before the extraction learnt to state `kind` — imported
   * yesterday, reviewed tomorrow — reaches this line with nothing to read.
   * Left to default it would keep minting unreachable combats for as long as
   * the queue holds one, so it falls back to the same reading of the summary
   * that migration 0022 applies to what is already in the graph.
   */
  it('reads the summary when the proposal predates the field', async () => {
    expect(await publishEvent({ summary: 'Beckman neutralise seul la bande de Higuma.' })).toBe(
      'battle',
    )
  })

  it('leaves a quiet scene an ordinary event', async () => {
    expect(
      await publishEvent({ summary: 'Luffy raconte à Nami l’histoire de son chapeau.' }),
    ).toBe('event')
  })
})

describe('what publication must never do', () => {
  it('publishes nothing when given no decisions', async () => {
    const { userId, runId } = await prepare()
    const result = await publishDecisions(userId, runId, [])

    expect(result.entitiesCreated).toBe(0)
    const [entities] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities
    `
    expect(entities!.count).toBe(0)
  })

  it('does not touch another user’s run', async () => {
    const { runId } = await prepare()
    const stranger = await seedWorld([])

    await expect(
      publishDecisions(stranger.userId, runId, [
        { reviewItemId: '00000000-0000-4000-8000-000000000001', decision: 'accept' },
      ]),
    ).rejects.toThrow(/Aucune proposition/)
  })
})
