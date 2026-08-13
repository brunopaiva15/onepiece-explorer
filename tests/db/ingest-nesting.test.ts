/*
 * One connection, and the code that assumed there were four.
 *
 * The ingest pool is sized to a single connection on a serverless runtime,
 * because Supabase's session-mode pooler allows fifteen clients for the whole
 * project and instances multiply on their own. That sizing is right, and it
 * exposed something that had been true all along: publishDecisions() opens an
 * ingest transaction and, inside it, calls rebuildRefTable(), which opened its
 * own. Two connections for one operation.
 *
 * With four in the pool that was invisible. With one it is a deadlock in the
 * strictest sense — the outer transaction holds the only connection and waits
 * for code that is waiting for a connection — and the symptom is « Publication…
 * » that never ends, followed by an instance whose every later page hangs too,
 * because resolving a reader's session goes through the same role.
 *
 * So these run against a pool of exactly one. Anything that needs two will not
 * be slow here; it will not return at all, which is what the per-test timeouts
 * are for.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withDestructive, withIngest } from '@/db/boundary.ts'
import { closeConnections, ingestSql } from '@/db/client.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import {
  closeDb,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/*
 * Set before anything opens the pool, which is safe because it is built on
 * first *use* rather than at import — see the comment in db/client.ts about
 * `next build` importing every route.
 */
const POOL_MAX_BEFORE = process.env.DB_INGEST_POOL_MAX
process.env.DB_INGEST_POOL_MAX = '1'

const SUMMARY = [
  'Au Partys Bar, Shanks refuse d’emmener Luffy en mer, jugeant qu’il ne sait',
  'pas nager et qu’il est bien trop jeune pour prendre le large avec eux.',
  '',
  'Plus tard, les pirates lèvent l’ancre et quittent le village de Fuchsia',
  'pour la dernière fois, sans que personne au bar ne s’en doute encore.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string

beforeAll(() => {
  // The pool really is one deep, or none of this proves anything.
  expect(ingestSql().options.max).toBe(1)
})

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 1,
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
  await closeConnections()
  await closeDb()
  if (POOL_MAX_BEFORE === undefined) delete process.env.DB_INGEST_POOL_MAX
  else process.env.DB_INGEST_POOL_MAX = POOL_MAX_BEFORE
})

describe('withIngest, nested', () => {
  it('joins the transaction already open instead of asking for a second connection', async () => {
    const seen = await withIngest(async (outer) => {
      const [before] = await outer.execute<{ id: string }>(
        sql`SELECT txid_current()::text AS id`,
      )
      const inside = await withIngest(async (nested) => {
        const [row] = await nested.execute<{ id: string }>(
          sql`SELECT txid_current()::text AS id`,
        )
        return row!.id
      })
      return { outer: before!.id, inside }
    })

    // Same transaction id, so necessarily the same connection. A second
    // connection could not have produced this number, and with a pool of one
    // it could not have been produced at all.
    expect(seen.inside).toBe(seen.outer)
  }, 10_000)

  it('sees what the enclosing transaction has written but not committed', async () => {
    const id = randomUUID()

    await withIngest(async (outer) => {
      await outer.execute(sql`
        INSERT INTO audit_log (id, user_id, action, subject_kind, subject_id)
        VALUES (${id}, ${world.userId}, 'test_nesting', 'ingestion_run', ${runId})
      `)

      const found = await withIngest(async (nested) => {
        const rows = await nested.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM audit_log WHERE id = ${id}`,
        )
        return rows[0]!.count
      })

      expect(found).toBe(1)
    })
  }, 10_000)

  it('commits the nested write with the outer transaction, and rolls it back with it', async () => {
    const id = randomUUID()

    await expect(
      withIngest(async () => {
        await withIngest(async (nested) => {
          await nested.execute(sql`
            INSERT INTO audit_log (id, user_id, action, subject_kind, subject_id)
            VALUES (${id}, ${world.userId}, 'test_nesting', 'ingestion_run', ${runId})
          `)
        })
        throw new Error('abandon')
      }),
    ).rejects.toThrow('abandon')

    const rows = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM audit_log WHERE id = ${id}`
    expect(rows[0]!.count).toBe(0)
  }, 10_000)
})

describe('withDestructive, nested', () => {
  it('refuses rather than turning deletion on for someone else’s transaction', async () => {
    await expect(
      withIngest(async () => {
        await withDestructive('un test', async () => undefined)
      }),
    ).rejects.toThrow(/imbriqué/)
  }, 10_000)
})

describe('publishing a chapter', () => {
  /*
   * The failure as it was actually met: the button on /review, on a deployment
   * whose pool is one deep. publishDecisions() rebuilds the ref table from
   * inside its own transaction — every publication from the review screen does,
   * since the caller has no table to pass — so this is the real path and not a
   * reconstruction of it.
   */
  it('returns, with a pool of one connection', async () => {
    const itemId = randomUUID()
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${itemId}, ${runId}, ${chapterId}, ${world.userId}, 'entity', 50,
        ${raw.json({
          evidence: [{ kind: 'text', ref: 'b1', excerpt: 'Shanks' }],
          confidence: 0.9,
          local_id: 'e1',
          node_type: 'character',
          label: 'Shanks',
          label_kind: 'true_name',
          source_term: null,
          naming_confident: true,
        })},
        ${randomUUID()}, false, 0.9, 'proposed'
      )
    `

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.entitiesCreated).toBe(1)
  }, 20_000)
})
