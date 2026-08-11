import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  countIsolatedEntities,
  deleteChapter,
  listOrphanedAssertions,
  previewDeletion,
} from '@/domains/chapters/delete.ts'
import { exportEverything, purgeReader } from '@/domains/observability/export.ts'
import { costSummary } from '@/domains/observability/costs.ts'
import { importChapter } from '@/domains/ingestion/import.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { LocalFsStorage } from '@/domains/storage/local-storage.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * Deletion and export: the two halves of the retention promise.
 *
 * The README says pages are deletable and that nothing is held hostage. Neither
 * claim is kept unless it genuinely works, and both are the kind of feature that
 * is written once, never exercised, and quietly broken.
 *
 * The interesting question is not whether deletion removes rows. It is what
 * happens to the *knowledge* — a fact learned from a chapter whose files are
 * gone. It must not silently vanish, and it must not silently keep looking
 * checkable.
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

let storageRoot: string
let adapter: LocalFsStorage

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)))
}

interface Walked {
  userId: string
  workId: string
  chapterId: string
  runId: string
}

async function walkChapter(
  world: { userId: string; workId: string },
  chapterNumber: number,
  file: string,
): Promise<Walked> {
  const imported = await importChapter({
    userId: world.userId,
    workId: world.workId,
    chapterNumber,
    file: { filename: file, bytes: await fixture(file) },
    limits,
    adapter,
  })

  const runId = await createRun(world.userId, imported.chapterId)
  await executeRun(world.userId, imported.chapterId, runId)

  const queue = await getReviewQueue(world.userId, runId)
  await publishDecisions(
    world.userId,
    runId,
    (queue?.items ?? []).map((item) => ({
      reviewItemId: item.id,
      decision: 'accept' as const,
    })),
  )

  await raw`UPDATE chapters SET status = 'published', published_at = now()
            WHERE id = ${imported.chapterId}`

  return { ...world, chapterId: imported.chapterId, runId }
}

beforeEach(async () => {
  await resetDatabase()
  storageRoot = await mkdtemp(path.join(tmpdir(), 'ope-life-'))
  adapter = new LocalFsStorage({ root: storageRoot, secret: 'test', defaultTtl: 60 })
  process.env.STORAGE_DRIVER = 'local'
  process.env.LOCAL_STORAGE_ROOT = storageRoot
  process.env.MODEL_PROVIDER = 'synthetic'

  const { resetStorageCache } = await import('@/domains/storage/index.ts')
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  const { resetVectorStore } = await import('@/domains/search/index.ts')
  resetStorageCache()
  resetModelProvider()
  resetVectorStore()
})

afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await closeDb()
})

describe('previewing a deletion', () => {
  it('states the consequences in countable terms', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    const preview = await previewDeletion(world.userId, walked.chapterId)

    expect(preview).not.toBeNull()
    expect(preview!.pageCount).toBe(2)
    expect(preview!.panelCount).toBeGreaterThan(0)
    // "Delete chapter 1?" is not enough information to answer when the answer
    // involves facts becoming uncheckable.
    expect(preview!.assertionsRevealed).toBeGreaterThan(0)
    expect(preview!.evidenceAffected).toBeGreaterThan(0)
    expect(preview!.storageKeys).toBeGreaterThan(preview!.pageCount)
  })

  it('returns null for a chapter that is not the reader’s', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')
    const stranger = await seedWorld([])

    expect(await previewDeletion(stranger.userId, walked.chapterId)).toBeNull()
  })
})

describe('deleting a chapter', () => {
  it('removes the pages and the stored objects', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    const keys = await raw<Array<{ storage_key_display: string }>>`
      SELECT storage_key_display FROM pages WHERE chapter_id = ${walked.chapterId}
    `
    expect(await adapter.exists(keys[0]!.storage_key_display)).toBe(true)

    const result = await deleteChapter(world.userId, walked.chapterId)

    expect(result.pagesDeleted).toBe(2)
    expect(result.objectsDeleted).toBeGreaterThan(0)

    const [remaining] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pages WHERE chapter_id = ${walked.chapterId}
    `
    expect(remaining!.count).toBe(0)
    // Actually gone from the bucket, not merely dereferenced. A retention
    // promise that leaves the bytes behind is not one.
    expect(await adapter.exists(keys[0]!.storage_key_display)).toBe(false)
  })

  it('keeps the knowledge and reports what became uncheckable', async () => {
    /*
     * The decision this whole module turns on. A fact learned from chapter 1 is
     * still something the reader learned; deleting the files does not make it
     * untrue, and removing it would rewrite their graph behind their back.
     */
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    const [before] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM assertions WHERE user_id = ${world.userId}
    `
    expect(before!.count).toBeGreaterThan(0)

    const result = await deleteChapter(world.userId, walked.chapterId)

    const [after] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM assertions WHERE user_id = ${world.userId}
    `
    expect(after!.count).toBe(before!.count)
    expect(result.assertionsOrphaned).toBeGreaterThan(0)
  })

  it('marks orphaned facts by their missing evidence, not by a stored flag', async () => {
    /*
     * The state is derived: an assertion is orphaned exactly when no evidence
     * row remains. A stored boolean would be one more thing to keep in step
     * with reality, and the first re-import would desynchronise it.
     */
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    expect(await listOrphanedAssertions(world.userId)).toEqual([])

    await deleteChapter(world.userId, walked.chapterId)

    const orphaned = await listOrphanedAssertions(world.userId)
    expect(orphaned.length).toBeGreaterThan(0)
    expect(orphaned.every((row) => row.chapter === 1)).toBe(true)
  })

  it('heals orphaned facts when the chapter is re-imported', async () => {
    /*
     * The trap this test was written to find, and it found it.
     *
     * Replacing a bad scan is the obvious thing to do after a deletion. The
     * recorded review decisions correctly suppress the proposals — that is the
     * feature that stops a re-import re-asking fifty questions — so nothing was
     * published, no evidence was written, and the facts stayed permanently
     * uncheckable. Deleting a chapter and putting a better copy back destroyed
     * the one property this product is built on.
     *
     * Extraction now re-anchors: it finds the existing assertion by fingerprint
     * and gives it evidence again. No new assertion, no change to history — the
     * fact was always true, and it is checkable once more.
     */
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    const before = await listOrphanedAssertions(world.userId)
    expect(before).toEqual([])

    await deleteChapter(world.userId, walked.chapterId)
    const orphaned = await listOrphanedAssertions(world.userId)
    expect(orphaned.length).toBeGreaterThan(0)

    const again = await walkChapter(world, 1, 'chapitre-01.pdf')
    expect(again.chapterId).not.toBe(walked.chapterId)

    const after = await listOrphanedAssertions(world.userId)
    expect(
      after.length,
      `${after.length} fait(s) toujours orphelin(s) après réimport`,
    ).toBeLessThan(orphaned.length)

    // And the healed evidence points at the *new* pages, not the deleted ones.
    const [linked] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM evidence
      WHERE user_id = ${world.userId} AND chapter_id = ${again.chapterId}
    `
    expect(linked!.count).toBeGreaterThan(0)
  })

  it('removes the chapter from the graph without emptying it', async () => {
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')
    const second = await walkChapter(world, 2, 'chapitre-02.pdf')

    const before = await projectGraph(world.userId, 2)
    await deleteChapter(world.userId, second.chapterId)
    const after = await projectGraph(world.userId, 2)

    // Chapter 1's knowledge survives untouched; the entities introduced by
    // chapter 2 survive too, because the knowledge is kept — what is gone is
    // the ability to check them.
    expect(after.nodes.length).toBe(before.nodes.length)
  })

  it('deletes the knowledge too when explicitly asked', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    const result = await deleteChapter(world.userId, walked.chapterId, {
      keepKnowledge: false,
    })

    expect(result.assertionsOrphaned).toBeGreaterThan(0)
    const [after] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM assertions WHERE user_id = ${world.userId}
    `
    expect(after!.count).toBe(0)
  })

  it('writes an audit entry', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')
    await deleteChapter(world.userId, walked.chapterId)

    const [entry] = await raw<Array<{ action: string; subject_id: string }>>`
      SELECT action, subject_id FROM audit_log
      WHERE user_id = ${world.userId} AND action LIKE 'delete_chapter%'
    `
    expect(entry?.action).toBe('delete_chapter')
    expect(entry?.subject_id).toBe(walked.chapterId)
  })

  it('reports entities left with no relations', async () => {
    const world = await seedWorld([])
    const walked = await walkChapter(world, 1, 'chapitre-01.pdf')

    await deleteChapter(world.userId, walked.chapterId, { keepKnowledge: false })
    // With the assertions gone, whatever entities remain are isolated — worth
    // surfacing so the reader can clean up rather than accumulating debris.
    expect(await countIsolatedEntities(world.userId)).toBeGreaterThan(0)
  })
})

describe('export', () => {
  it('contains the whole library, unfiltered by any boundary', async () => {
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')
    await walkChapter(world, 2, 'chapitre-02.pdf')

    const bundle = await exportEverything(world.userId)

    expect(bundle.formatVersion).toBe(1)
    expect(bundle.counts.chapters).toBe(2)
    expect(bundle.counts.pages).toBeGreaterThan(0)
    expect(bundle.counts.assertions).toBeGreaterThan(0)
    expect(bundle.counts.evidence).toBeGreaterThan(0)
    // The reader's own decisions. Re-importing without them would ask every
    // question again.
    expect(bundle.counts.reviewDecisions).toBeGreaterThan(0)
  })

  it('is not filtered by the reader’s current position', async () => {
    /*
     * A backup filtered by the boundary would be a partial archive that looks
     * complete — the worst possible failure mode for a backup. Export runs
     * through withIngest for exactly this reason.
     */
    const world = await seedWorld([])
    await walkChapter(world, 40, 'chapitre-01.pdf')

    await raw`UPDATE profiles SET boundary_chapter = 1 WHERE id = ${world.userId}`

    const bundle = await exportEverything(world.userId)
    expect(bundle.counts.chapters).toBe(1)
    expect(bundle.counts.assertions).toBeGreaterThan(0)
  })

  it('contains no page bytes', async () => {
    // Storage keys, yes; the images themselves, never. They are the one thing
    // that is not the reader's own work, and an export the tool hands out must
    // not become a redistribution channel.
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')

    const bundle = await exportEverything(world.userId)
    const serialised = JSON.stringify(bundle)

    expect(serialised).not.toMatch(/data:image/)
    // A base64 run long enough to be a page would show up as a very long
    // alphanumeric token; nothing in the bundle should look like that.
    expect(serialised).not.toMatch(/[A-Za-z0-9+/]{2000,}/)
  })

  it('serialises to valid JSON', async () => {
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')

    const bundle = await exportEverything(world.userId)
    const round = JSON.parse(JSON.stringify(bundle)) as typeof bundle
    expect(round.counts).toEqual(bundle.counts)
  })
})

describe('purge', () => {
  it('leaves nothing behind, including the tables cascades miss', async () => {
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')

    const deleted = await purgeReader(world.userId)
    expect(deleted.works).toBe(1)
    expect(deleted.profiles).toBe(1)

    /*
     * Every table keyed by user_id, checked by name. Forgetting one is exactly
     * how a "delete my data" feature quietly leaves data behind, and a cascade
     * from `works` does not reach the ones keyed only by the reader.
     */
    for (const table of [
      'chapters',
      'pages',
      'panels',
      'text_blocks',
      'entities',
      'entity_labels',
      'assertions',
      'evidence',
      'review_decisions',
      'user_theories',
      'audit_log',
      'quarantine',
      'embeddings',
      'ingestion_runs',
    ]) {
      const [row] = await raw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM ${raw.unsafe(table)}
        WHERE user_id = ${world.userId}
      `
      expect(row!.count, `${table} contient encore des lignes`).toBe(0)
    }
  })
})

describe('cost reporting', () => {
  it('reports per step and per chapter', async () => {
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')

    const summary = await costSummary(world.userId)

    expect(summary.byStep.length).toBeGreaterThan(0)
    expect(summary.byChapter.length).toBe(1)
    expect(summary.byChapter[0]!.chapterNumber).toBe(1)
    // The synthetic provider is free, so the total is zero — and that must be
    // reported as zero rather than as missing data.
    expect(summary.totalCents).toBe(0)
  })

  it('returns null accuracy rather than a flattering 1 when nothing is comparable', async () => {
    /*
     * Averaging over runs that never recorded an estimate would pull the ratio
     * towards 1 and make a broken estimator look accurate.
     */
    const world = await seedWorld([])
    await walkChapter(world, 1, 'chapitre-01.pdf')

    const summary = await costSummary(world.userId)
    expect(summary.estimateAccuracy).toBeNull()
  })

  it('is empty rather than failing for a reader with no runs', async () => {
    const world = await seedWorld([])
    const summary = await costSummary(world.userId)

    expect(summary.totalCents).toBe(0)
    expect(summary.chaptersProcessed).toBe(0)
    expect(summary.byStep).toEqual([])
  })
})
