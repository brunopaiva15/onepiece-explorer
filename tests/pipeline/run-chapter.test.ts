import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importChapter } from '@/domains/ingestion/import.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun, getRun } from '@/domains/pipeline/runs.ts'
import { STEPS } from '@/domains/pipeline/registry.ts'
import { LocalFsStorage } from '@/domains/storage/local-storage.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * The pipeline, executed for real against a real database.
 *
 * Runs the executor directly rather than through pg-boss. The queue's job is to
 * deliver the call and retry it; whether the steps do the right thing is a
 * separate question, and mixing the two would make a slow test that fails for
 * two unrelated reasons.
 *
 * What this actually proves is that panels get written, that text blocks land
 * inside them, and that re-running is cheap rather than duplicative — the three
 * properties everything in phase 2 is going to build on.
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

let storageRoot: string
let adapter: LocalFsStorage

async function fixture(name: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path.join(FIXTURES, name)))
  } catch {
    throw new Error(
      `Fixture manquante : ${name}\nLancez « pnpm fixtures:generate » d'abord.`,
    )
  }
}

async function importFixtureChapter(): Promise<{
  userId: string
  chapterId: string
}> {
  const world = await seedWorld([])
  const result = await importChapter({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 1,
    file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
    limits,
    adapter,
  })
  return { userId: world.userId, chapterId: result.chapterId }
}

beforeEach(async () => {
  await resetDatabase()
  storageRoot = await mkdtemp(path.join(tmpdir(), 'ope-run-'))
  adapter = new LocalFsStorage({ root: storageRoot, secret: 'test', defaultTtl: 60 })
  // The pipeline resolves storage from configuration rather than taking an
  // adapter, so point the configured driver at this test's directory.
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_ROOT = storageRoot

  /*
   * Synthetic, not replay, and deliberately so.
   *
   * This file asks whether the *steps* compose — whether panels get written,
   * text lands inside them, proposals reach the queue, costs are recorded.
   * None of that is a question about what a model answered. Replay would be
   * the right provider for a test asserting on model output, and it correctly
   * refuses to run without a recording; using it here would make every one of
   * these assertions depend on a cassette that says nothing about the property
   * under test.
   */
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

describe('executing a run', () => {
  it('detects panels and attaches the text to them', async () => {
    const { userId, chapterId } = await importFixtureChapter()
    const runId = await createRun(userId, chapterId)

    const result = await executeRun(userId, chapterId, runId)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('succeeded')

    const panels = await raw<Array<{ reading_order: number; confidence: number }>>`
      SELECT reading_order, confidence FROM panels WHERE chapter_id = ${chapterId}
      ORDER BY reading_order
    `
    // The fixture's first chapter is a four-panel page and a two-panel page.
    expect(panels).toHaveLength(6)
    expect(panels.every((p) => p.confidence > 0.5)).toBe(true)

    // Reading order is per page, so each page contributes its own 0..n-1.
    const orders = await raw<Array<{ page_id: string; orders: number[] }>>`
      SELECT page_id, array_agg(reading_order ORDER BY reading_order) AS orders
      FROM panels WHERE chapter_id = ${chapterId} GROUP BY page_id
    `
    for (const page of orders) {
      expect(page.orders).toEqual([...page.orders.keys()])
    }

    /*
     * The point of the step: a quote must be attributable to a picture. A text
     * block with no panel is not a failure — page furniture is text too — but
     * most of the dialogue landing outside every box would mean the boxes are
     * wrong, and that is worth failing over before a model is paid to describe
     * them.
     */
    const [counts] = await raw<Array<{ total: number; assigned: number }>>`
      SELECT count(*)::int AS total,
             count(panel_id)::int AS assigned
      FROM text_blocks WHERE chapter_id = ${chapterId}
    `
    expect(counts!.total).toBeGreaterThan(0)
    expect(counts!.assigned / counts!.total).toBeGreaterThan(0.8)
  })

  it('records every declared step, and says why one did not run', async () => {
    const { userId, chapterId } = await importFixtureChapter()
    const runId = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, runId)

    const view = await getRun(userId, runId)
    expect(view).not.toBeNull()
    expect(view!.steps).toHaveLength(STEPS.length)

    // A pending step in a finished run reads as "something got stuck". Steps
    // that are declared but unbuilt must say so instead.
    const unbuilt = view!.steps.filter((s) => !s.implemented)
    expect(unbuilt.length).toBeGreaterThan(0)
    expect(unbuilt.every((s) => s.status === 'skipped')).toBe(true)
    expect(unbuilt.every((s) => (s.note ?? '').length > 0)).toBe(true)

    /*
     * A built step can honestly report 'skipped', and conflating that with
     * failure would be wrong in the most important case: this chapter's PDF
     * carried its own text layer, so transcription has nothing to add and
     * running it could only degrade an exact result. What must hold is that no
     * built step failed and every one explains itself.
     */
    const built = view!.steps.filter((s) => s.implemented)
    expect(built.every((s) => s.status !== 'failed' && s.status !== 'pending')).toBe(true)
    expect(built.every((s) => (s.note ?? '').length > 0)).toBe(true)

    const ocr = view!.steps.find((s) => s.key === 'ocr')
    expect(ocr?.status).toBe('skipped')
    expect(ocr?.note).toMatch(/couche texte/)
  })

  it('describes panels and queues proposals, none of them canon', async () => {
    const { userId, chapterId } = await importFixtureChapter()
    const runId = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, runId)

    const [described] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM panels
      WHERE chapter_id = ${chapterId} AND description IS NOT NULL
    `
    expect(described!.count).toBeGreaterThan(0)

    const items = await raw<
      Array<{ category: string; proposal_fingerprint: string; status: string }>
    >`
      SELECT category, proposal_fingerprint, status FROM review_items
      WHERE run_id = ${runId}
    `
    expect(items.length).toBeGreaterThan(0)

    // Everything the pipeline produces waits for a human. Nothing is accepted,
    // and nothing has reached the assertions table.
    expect(items.every((i) => i.status === 'proposed')).toBe(true)
    expect(items.every((i) => i.proposal_fingerprint.length === 64)).toBe(true)

    const [assertions] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM assertions
    `
    expect(assertions!.count).toBe(0)
  })

  it('does not re-ask about a proposal the user already decided', async () => {
    /*
     * Blocking test 6. The mechanism is the fingerprint: a decision recorded
     * against one is re-applied on the next run and the item never returns to
     * the queue. Without it, re-importing a chapter would ask the same
     * questions again — and a reviewer who has to re-answer fifty decisions
     * stops reading them.
     */
    const { userId, chapterId } = await importFixtureChapter()

    const firstRun = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, firstRun)

    const items = await raw<Array<{ proposal_fingerprint: string }>>`
      SELECT proposal_fingerprint FROM review_items WHERE run_id = ${firstRun}
    `
    expect(items.length).toBeGreaterThan(0)

    const [work] = await raw<Array<{ work_id: string }>>`
      SELECT work_id FROM chapters WHERE id = ${chapterId}
    `

    // The user rejects the first proposal.
    await raw`
      INSERT INTO review_decisions (user_id, work_id, proposal_fingerprint, decision)
      VALUES (${userId}, ${work!.work_id}, ${items[0]!.proposal_fingerprint}, 'reject')
    `

    // Force extraction to run again rather than reuse its cache.
    await raw`DELETE FROM ingestion_steps WHERE step_key = 'extract_candidates'`

    const secondRun = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, secondRun)

    const requeued = await raw<Array<{ proposal_fingerprint: string }>>`
      SELECT proposal_fingerprint FROM review_items WHERE run_id = ${secondRun}
    `
    expect(requeued.map((r) => r.proposal_fingerprint)).not.toContain(
      items[0]!.proposal_fingerprint,
    )
    // The others still come back: only the decided one is suppressed.
    expect(requeued.length).toBe(items.length - 1)

    const view = await getRun(userId, secondRun)
    const extract = view!.steps.find((s) => s.key === 'extract_candidates')
    expect(extract?.note).toMatch(/déjà décidées/)
  })

  it('reuses an unchanged step instead of recomputing it', async () => {
    const { userId, chapterId } = await importFixtureChapter()

    const firstRun = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, firstRun)

    // Nothing about the pages changed, so the second run should recognise the
    // input hash and reuse the result rather than decoding every page again.
    const secondRun = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, secondRun)

    const view = await getRun(userId, secondRun)
    const detect = view!.steps.find((s) => s.key === 'panel_detect')
    expect(detect?.status).toBe('cached')
    expect(detect?.note).toMatch(/réutilisé/)
  })

  it('is idempotent: rerunning does not double the panels', async () => {
    const { userId, chapterId } = await importFixtureChapter()

    const first = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, first)
    const [before] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM panels WHERE chapter_id = ${chapterId}
    `

    // Force a real re-execution by invalidating the cache the way a genuine
    // correction would: touch the page set.
    await raw`UPDATE pages SET rotation = 0 WHERE chapter_id = ${chapterId}`
    await raw`DELETE FROM ingestion_steps WHERE step_key = 'panel_detect'`

    const second = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, second)

    const [after] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM panels WHERE chapter_id = ${chapterId}
    `
    expect(after!.count).toBe(before!.count)
  })

  it('leaves the chapter awaiting review, never published', async () => {
    const { userId, chapterId } = await importFixtureChapter()
    const runId = await createRun(userId, chapterId)
    await executeRun(userId, chapterId, runId)

    const [chapter] = await raw<Array<{ status: string }>>`
      SELECT status FROM chapters WHERE id = ${chapterId}
    `
    // A successful pipeline produces proposals, not canon. Publishing on
    // success would make "AI proposes, human decides" a slogan rather than a
    // mechanism.
    expect(chapter!.status).toBe('review')
  })

  it('records the failure and marks the run failed when a page is unreadable', async () => {
    const { userId, chapterId } = await importFixtureChapter()

    // Point a page at a key that does not exist — the shape a storage object
    // deleted out from under the database takes.
    await raw`
      UPDATE pages SET storage_key_original = ${`${userId}/${chapterId}/original/absente.bin`}
      WHERE chapter_id = ${chapterId} AND index = 0
    `

    const runId = await createRun(userId, chapterId)
    const result = await executeRun(userId, chapterId, runId)
    expect(result.status).toBe('failed')

    const view = await getRun(userId, runId)
    expect(view!.run.status).toBe('failed')
    expect(view!.run.error).toBeTruthy()

    const detect = view!.steps.find((s) => s.key === 'panel_detect')
    expect(detect?.status).toBe('failed')
    expect(detect?.error).toBeTruthy()

    // The run stops at the first failure: every later step consumes an earlier
    // one's output, so continuing would describe boxes that are wrong.
    const textDetect = view!.steps.find((s) => s.key === 'text_detect')
    expect(textDetect?.status).toBe('pending')
  })
})

describe('recording what a step cost', () => {
  it('stores a fractional cost instead of failing on it', async () => {
    /*
     * A step's cost is token counts times a per-million-token price, so it is
     * fractional by construction. The column was `integer`, and the first real
     * invoice — an OCR step at 50.156 cents — failed the insert and took the
     * whole run down with it: nine minutes of transcription, already paid for,
     * discarded at the moment of writing down what it had cost.
     */
    const { recordStep } = await import('@/domains/pipeline/runs.ts')
    const { userId, chapterId } = await importFixtureChapter()
    const runId = await createRun(userId, chapterId)

    await recordStep(runId, userId, 'ocr', 'hash', {
      status: 'succeeded',
      note: '238 blocs transcrits',
      durationMs: 568_314,
      costCents: 50.156_000_000_000_006,
      modelId: 'claude-sonnet-5',
    })

    const [row] = await raw<Array<{ cost_cents: string }>>`
      SELECT cost_cents FROM ingestion_steps
      WHERE run_id = ${runId}::uuid AND step_key = 'ocr'
      ORDER BY attempt DESC LIMIT 1
    `

    // Six decimals, so the sub-cent steps that make up most of a chapter are
    // not each rounded away.
    expect(Number(row?.cost_cents)).toBeCloseTo(50.156, 5)
  })
})
