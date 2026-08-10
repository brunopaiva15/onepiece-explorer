import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { importChapter } from '@/domains/ingestion/import.ts'
import { reorderPages } from '@/domains/ingestion/persist.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { LocalFsStorage } from '@/domains/storage/local-storage.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * Import, end to end, against a real database and a real storage driver.
 *
 * The unit tests around this one prove that each step handles its own input
 * correctly. This one proves the steps compose: that a PDF on disk becomes
 * rows a reader can page through, that re-importing does not duplicate
 * anything, and that reordering survives the unique constraint on page index.
 *
 * It uses the synthetic fixtures rather than a real chapter for the reason
 * stated in the README — no manga page belongs in this repository — and the
 * fixtures were built with a known geometry so the assertions can be exact
 * rather than "some pages appeared".
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

let storageRoot: string
let adapter: LocalFsStorage

async function fixture(name: string): Promise<Uint8Array> {
  const file = path.join(FIXTURES, name)
  try {
    return new Uint8Array(await readFile(file))
  } catch {
    throw new Error(
      `Fixture manquante : ${file}\nLancez « pnpm fixtures:generate » d'abord.`,
    )
  }
}

beforeEach(async () => {
  await resetDatabase()
  storageRoot = await mkdtemp(path.join(tmpdir(), 'ope-import-'))
  adapter = new LocalFsStorage({
    root: storageRoot,
    secret: 'test-secret',
    defaultTtl: 60,
  })
})

afterAll(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await closeDb()
})

describe('importing a chapter from a PDF', () => {
  it('produces pages, derivatives and a text layer', async () => {
    const world = await seedWorld([])
    const bytes = await fixture('chapitre-01.pdf')

    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      title: 'Chapitre 1',
      file: { filename: 'chapitre-01.pdf', bytes },
      limits,
      adapter,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.replaced).toBe(false)

    // The fixture PDF is generated with real PDF text, so this must be the
    // free, exact path — not OCR. If this flips to false the pipeline silently
    // starts paying a model to re-read text it was handed.
    expect(result.hasTextLayer).toBe(true)
    expect(result.pages.every((p) => p.textBlockCount > 0)).toBe(true)

    const rows = await raw<
      Array<{
        index: number
        width: number
        height: number
        chapter_number: number
        storage_key_display: string
        storage_key_thumb: string
        phash: string
      }>
    >`
      SELECT index, width, height, chapter_number,
             storage_key_display, storage_key_thumb, phash
      FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `

    expect(rows.map((r) => r.index)).toEqual([0, 1])

    // Denormalised from chapters.number by a trigger; the RLS predicate reads
    // it, so a page whose chapter_number drifted would be filtered wrongly.
    expect(rows.every((r) => r.chapter_number === 1)).toBe(true)
    expect(rows.every((r) => /^[0-9a-f]{16}$/.test(r.phash))).toBe(true)

    // Every key must resolve to a real object. A page row pointing at nothing
    // is a chapter that renders as broken images.
    for (const row of rows) {
      expect(await adapter.exists(row.storage_key_display)).toBe(true)
      expect(await adapter.exists(row.storage_key_thumb)).toBe(true)
    }
  })

  it('keeps the uploaded file so a reprocess never needs the user again', async () => {
    const world = await seedWorld([])
    const bytes = await fixture('chapitre-01.pdf')

    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes },
      limits,
      adapter,
    })

    const [doc] = await raw<Array<{ storage_key: string; sha256: string; has_text_layer: boolean }>>`
      SELECT storage_key, sha256, has_text_layer FROM documents WHERE id = ${result.documentId}
    `
    expect(doc).toBeDefined()
    expect(doc!.has_text_layer).toBe(true)

    const stored = await adapter.get(doc!.storage_key)
    expect(stored.byteLength).toBe(bytes.byteLength)
  })

  it('anchors text blocks to text that is really on the page', async () => {
    const world = await seedWorld([])
    const bytes = await fixture('chapitre-01.pdf')

    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes },
      limits,
      adapter,
    })

    const blocks = await raw<Array<{ text: string; normalized_text: string; source: string }>>`
      SELECT text, normalized_text, source
      FROM text_blocks WHERE chapter_id = ${result.chapterId}
    `

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.source === 'pdf_text')).toBe(true)
    expect(blocks.every((b) => b.normalized_text.length > 0)).toBe(true)

    /*
     * The database must accept as anchored anything the application computed.
     * This is the same property migration 0008 exists to guarantee, checked
     * here on real extracted text rather than on constructed strings.
     */
    for (const block of blocks.slice(0, 5)) {
      const [row] = await raw<Array<{ ok: boolean }>>`
        SELECT position(app.normalize_text(${block.text}) IN ${block.normalized_text}) > 0 AS ok
      `
      expect(row?.ok, `Bloc non ancrable : ${block.text}`).toBe(true)
    }
  })
})

describe('importing from an archive and from loose images', () => {
  it('reads a CBZ in natural page order', async () => {
    const world = await seedWorld([])
    const bytes = await fixture('chapitre-01.cbz')

    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.cbz', bytes },
      limits,
      adapter,
    })

    expect(result.pages).toHaveLength(2)
    // No text layer in a CBZ of images; OCR will have to run.
    expect(result.hasTextLayer).toBe(false)
  })

  it('orders loose images naturally, not lexicographically', async () => {
    const world = await seedWorld([])
    const first = await fixture(path.join('chapitre-01', 'page-01.png'))
    const second = await fixture(path.join('chapitre-01', 'page-02.png'))

    // `page10` sorts before `page2` lexicographically. Getting this wrong
    // scrambles the chapter in a way that still looks plausible.
    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      images: [
        { filename: 'page10.png', bytes: second },
        { filename: 'page2.png', bytes: first },
      ],
      limits,
      adapter,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.documentId).toBeNull()

    const rows = await raw<Array<{ index: number; phash: string }>>`
      SELECT index, phash FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `

    // page2 must land at index 0. Identified by hash rather than by filename,
    // because the stored key is derived from the index — which is the thing
    // under test and cannot also be the evidence.
    const pageOne = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 2,
      images: [{ filename: 'only.png', bytes: first }],
      limits,
      adapter,
    })
    const [reference] = await raw<Array<{ phash: string }>>`
      SELECT phash FROM pages WHERE chapter_id = ${pageOne.chapterId}
    `
    expect(rows[0]!.phash).toBe(reference!.phash)
  })

  it('refuses a non-image in a loose selection', async () => {
    const world = await seedWorld([])
    const pdf = await fixture('chapitre-01.pdf')

    await expect(
      importChapter({
        userId: world.userId,
        workId: world.workId,
        chapterNumber: 1,
        images: [{ filename: 'sournois.png', bytes: pdf }],
        limits,
        adapter,
      }),
    ).rejects.toMatchObject({ code: 'unexpected_entry' })
  })
})

describe('re-importing', () => {
  it('replaces the pages instead of duplicating them', async () => {
    const world = await seedWorld([])
    const bytes = await fixture('chapitre-01.pdf')

    const request = {
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes },
      limits,
      adapter,
    }

    const first = await importChapter(request)
    const second = await importChapter(request)

    expect(second.chapterId).toBe(first.chapterId)
    expect(second.replaced).toBe(true)
    // Same bytes: the caller can tell nothing changed and skip reprocessing.
    expect(second.unchanged).toBe(true)

    const [counted] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pages WHERE chapter_id = ${first.chapterId}
    `
    expect(counted!.count).toBe(2)

    // One source document, not one per attempt.
    const [docs] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM documents WHERE chapter_id = ${first.chapterId}
    `
    expect(docs!.count).toBe(1)
  })

  it('reports a changed file as changed', async () => {
    const world = await seedWorld([])

    await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })

    const second = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-02.pdf', bytes: await fixture('chapitre-02.pdf') },
      limits,
      adapter,
    })

    expect(second.replaced).toBe(true)
    expect(second.unchanged).toBe(false)
  })
})

describe('reordering pages', () => {
  it('swaps two pages without colliding on the unique index', async () => {
    const world = await seedWorld([])
    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })

    const before = await raw<Array<{ id: string; index: number }>>`
      SELECT id, index FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `

    // A straight swap is the case a single-pass reindex gets wrong: assigning
    // page A to index 1 collides with page B, which has not moved yet.
    await reorderPages(world.userId, result.chapterId, [
      { pageId: before[0]!.id, index: 1 },
      { pageId: before[1]!.id, index: 0 },
    ])

    const after = await raw<Array<{ id: string; index: number }>>`
      SELECT id, index FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `
    expect(after[0]!.id).toBe(before[1]!.id)
    expect(after[1]!.id).toBe(before[0]!.id)
  })

  it('excludes a page without deleting it, and stops counting it', async () => {
    const world = await seedWorld([])
    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })

    const rows = await raw<Array<{ id: string }>>`
      SELECT id FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `

    await reorderPages(world.userId, result.chapterId, [
      { pageId: rows[0]!.id, index: 0, excluded: true },
      { pageId: rows[1]!.id, index: 1 },
    ])

    // Still stored: the original bytes are the one thing the pipeline cannot
    // reconstruct, and an exclusion is often a mistake.
    const [stored] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pages WHERE chapter_id = ${result.chapterId}
    `
    expect(stored!.count).toBe(2)

    const [chapter] = await raw<Array<{ page_count: number }>>`
      SELECT page_count FROM chapters WHERE id = ${result.chapterId}
    `
    expect(chapter!.page_count).toBe(1)
  })

  it('refuses a page that belongs to another chapter', async () => {
    const world = await seedWorld([])
    const mine = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })

    await expect(
      reorderPages(world.userId, mine.chapterId, [{ pageId: randomUUID(), index: 0 }]),
    ).rejects.toThrow(/n'appartient pas/)
  })

  it('refuses two pages claiming the same position', async () => {
    const world = await seedWorld([])
    const result = await importChapter({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      file: { filename: 'chapitre-01.pdf', bytes: await fixture('chapitre-01.pdf') },
      limits,
      adapter,
    })

    const rows = await raw<Array<{ id: string }>>`
      SELECT id FROM pages WHERE chapter_id = ${result.chapterId} ORDER BY index
    `

    await expect(
      reorderPages(world.userId, result.chapterId, [
        { pageId: rows[0]!.id, index: 0 },
        { pageId: rows[1]!.id, index: 0 },
      ]),
    ).rejects.toThrow(/deux fois/)
  })
})
