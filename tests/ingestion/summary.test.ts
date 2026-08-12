import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PASSAGE_CHARS,
  detectLanguage,
  splitPassages,
} from '@/domains/ingestion/passages.ts'
import { chapterPassages, importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun, getRun } from '@/domains/pipeline/runs.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * A chapter you wrote, from paste to proposals.
 *
 * The property under test is the one the whole change rests on: a written
 * chapter must be *citable*. Passages go in, and every proposal that comes out
 * quotes one of them word for word — checked by the same anchoring guard that
 * checked OCR, and by the database trigger underneath it.
 *
 * The splitter is tested as a pure function beside it, because it decides what
 * a citation can even point at. A splitter that cut mid-sentence would let a
 * legitimate quote fall across two passages and match neither, and the failure
 * would surface as an unexplained quarantine three steps later.
 */

const SUMMARY = [
  "Le chapitre s'ouvre sur le village de Fuchsia. Un jeune garçon nommé Luffy",
  "supplie un homme roux appelé Shanks de l'emmener en mer. Shanks refuse en",
  'riant : la mer est trop dangereuse pour un enfant.',
  '',
  "Un bandit entre dans la taverne et humilie Shanks devant tout le monde.",
  "Luffy s'indigne que Shanks ne réponde pas.",
  '',
  "Resté seul, Luffy avale un fruit étrange trouvé dans un coffre. Shanks lui",
  "explique qu'il vient de manger un fruit du démon et qu'il ne pourra plus",
  'jamais nager.',
].join('\n')

beforeEach(async () => {
  await resetDatabase()
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
})

afterAll(async () => {
  await closeDb()
})

describe('cutting a written chapter into citable passages', () => {
  it('keeps paragraphs as they were written', () => {
    const passages = splitPassages(SUMMARY)
    expect(passages).toHaveLength(3)
    expect(passages[0]).toContain('Fuchsia')
    expect(passages[2]).toContain('fruit du démon')
  })

  it('never cuts inside a sentence', () => {
    // One paragraph, far over budget: it has to be split, and every piece has
    // to be a whole number of sentences. A quote is the natural evidence for a
    // fact, and a quote spanning a mid-sentence cut would match no passage.
    const long = Array.from(
      { length: 40 },
      (_, i) => `Le personnage numéro ${i} traverse la place et salue la foule rassemblée.`,
    ).join(' ')

    const passages = splitPassages(long)
    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) {
      expect(passage.endsWith('.')).toBe(true)
      expect(passage.startsWith('Le personnage')).toBe(true)
    }
    // Nothing is lost, and nothing is invented.
    expect(passages.join(' ')).toBe(long)
  })

  it('splits a text that has no blank lines at all', () => {
    const oneBlock = Array.from(
      { length: 30 },
      (_, i) => `Ligne ${i} : il se passe quelque chose de suffisamment long pour compter.`,
    ).join('\n')

    const passages = splitPassages(oneBlock)
    expect(passages.length).toBeGreaterThan(1)
    for (const passage of passages) {
      expect(passage.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS)
    }
  })

  it('folds a bare heading into the passage it introduces', () => {
    const passages = splitPassages(
      '## Scène 1\n\nLuffy arrive au village et cherche Shanks dans la taverne du port.',
    )
    expect(passages).toHaveLength(1)
    expect(passages[0]).toContain('## Scène 1')
    expect(passages[0]).toContain('taverne')
  })

  it('tells French from English by its function words', () => {
    expect(detectLanguage(SUMMARY)).toBe('fr')
    expect(
      detectLanguage(
        'The chapter opens on Fuchsia Village. A boy called Luffy begs the ' +
          'red-haired man to take him out to sea, and the man refuses with a laugh.',
      ),
    ).toBe('en')
  })
})

describe('importing a chapter written as text', () => {
  it('stores passages that belong to no page', async () => {
    const world = await seedWorld([])
    const result = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      title: 'À l’aube d’une aventure',
      text: SUMMARY,
    })

    expect(result.passageCount).toBe(3)
    expect(result.language).toBe('fr')

    const rows = await raw<Array<{ source_kind: string; page_count: number }>>`
      SELECT source_kind, page_count FROM chapters WHERE id = ${result.chapterId}`
    expect(rows[0]).toMatchObject({ source_kind: 'summary', page_count: 0 })

    // Null page_id and null bbox are the point of migration 0015: prose has no
    // geometry, and a synthetic page row would be a lie told to a NOT NULL.
    const blocks = await raw<
      Array<{
        page_id: string | null
        bbox: unknown
        source: string
        chapter_number: number
      }>
    >`SELECT page_id, bbox, source, reading_order, chapter_number
        FROM text_blocks WHERE chapter_id = ${result.chapterId} ORDER BY reading_order`
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      expect(block.page_id).toBeNull()
      expect(block.bbox).toBeNull()
      expect(block.source).toBe('manual')
      expect(block.chapter_number).toBe(1)
    }
  })

  it('does not rewrite an identical paste', async () => {
    const world = await seedWorld([])
    const first = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })
    const before = await chapterPassages(world.userId, first.chapterId)

    // Same text, extra blank lines: the same source, so the same passages.
    // Rewriting them would delete the rows existing evidence points at, and
    // orphan every fact citing them, to arrive at identical content.
    const again = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: `${SUMMARY}\n\n\n`,
    })

    expect(again.unchanged).toBe(true)
    expect(again.chapterId).toBe(first.chapterId)
    const after = await chapterPassages(world.userId, first.chapterId)
    expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id))
  })

  it('replaces the passages when the text really changed', async () => {
    const world = await seedWorld([])
    await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })

    const corrected = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: `${SUMMARY}\n\nShanks perd un bras en sauvant Luffy d'un monstre marin.`,
    })

    expect(corrected.unchanged).toBe(false)
    expect(corrected.replaced).toBe(true)
    const passages = await chapterPassages(world.userId, corrected.chapterId)
    expect(passages).toHaveLength(4)
    expect(passages.at(-1)!.text).toContain('perd un bras')
  })

  it('refuses a paste too short to prove anything', async () => {
    const world = await seedWorld([])
    await expect(
      importSummary({
        userId: world.userId,
        workId: world.workId,
        chapterNumber: 1,
        text: 'Luffy rencontre Shanks.',
      }),
    ).rejects.toThrow(/caractères/)
  })

  it('keeps an English source in English, and records that it is', async () => {
    const world = await seedWorld([])
    const result = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 7,
      text:
        'The chapter opens on Fuchsia Village, where a boy called Luffy begs a ' +
        'red-haired pirate to take him out to sea. The pirate refuses with a ' +
        'laugh, saying the sea is no place for a child.\n\n' +
        'Later, alone in the tavern, Luffy swallows a strange fruit he finds in ' +
        'a chest, and is told he will never be able to swim again.',
    })

    expect(result.language).toBe('en')
    const blocks = await raw<Array<{ lang: string; text: string }>>`
      SELECT lang, text FROM text_blocks
        WHERE chapter_id = ${result.chapterId} ORDER BY reading_order`
    // Stored verbatim. An excerpt is checked against this text character by
    // character, so translating it here would make every English citation
    // unverifiable.
    expect(blocks[0]!.lang).toBe('en')
    expect(blocks[0]!.text).toContain('Fuchsia Village')
  })
})

describe('running the pipeline on a written chapter', () => {
  it('skips the image steps entirely and anchors every proposal to a passage', async () => {
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })

    const runId = await createRun(world.userId, chapterId)
    const outcome = await executeRun(world.userId, chapterId, runId)
    expect(outcome.status).toBe('succeeded')

    /*
     * Four steps, not nine.
     *
     * Panel detection, text detection, OCR and panel description are not
     * "skipped" on a written chapter — they do not exist for it. Recording them
     * as skipped rows would leave a permanent line of noise on every run of a
     * product that no longer reads images.
     */
    const view = await getRun(world.userId, runId)
    expect(view!.steps.map((step) => step.key)).toEqual([
      'extract_candidates',
      'resolve_entities',
      'detect_conflicts',
      'embed',
    ])

    const items = await raw<Array<{ payload: unknown }>>`
      SELECT payload FROM review_items
        WHERE run_id = ${runId} AND category = 'entity'`
    expect(items.length).toBeGreaterThan(0)

    // The guarantee, stated as an assertion: every excerpt occurs in a passage
    // of the text that was actually written. Checked against the stored
    // passages rather than against the model's own answer, which is the whole
    // difference between a promise and an enforcement.
    const passages = await chapterPassages(world.userId, chapterId)
    const sources = passages.map((passage) => passage.text)

    for (const item of items) {
      const payload = item.payload as { evidence: Array<{ excerpt: string }> }
      for (const evidence of payload.evidence) {
        expect(sources.some((source) => source.includes(evidence.excerpt))).toBe(true)
      }
    }
  })
})
