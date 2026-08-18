import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PASSAGE_CHARS,
  detectLanguage,
  splitPassages,
} from '@/domains/ingestion/passages.ts'
import { chapterPassages, importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun, getRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
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
    expect(detectLanguage(SUMMARY)).toMatchObject({ language: 'fr', confident: true })
    expect(
      detectLanguage(
        'The chapter opens on Fuchsia Village. A boy called Luffy begs the ' +
          'red-haired man to take him out to sea, and the man refuses with a laugh. ' +
          'Later the crew of the red-haired pirates drinks in the tavern with him.',
      ),
    ).toMatchObject({ language: 'en', confident: true })
  })

  it('admits when it cannot tell', () => {
    // Almost nothing but proper nouns: no function words to count, so no
    // grounds for an answer. Reporting one anyway is how an English chapter
    // ends up stored as French with nothing on screen to reveal it.
    expect(detectLanguage('Luffy. Shanks. Fuchsia. Higuma. Makino.').confident).toBe(false)
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

  it('asks rather than guessing when the language is unclear', async () => {
    const world = await seedWorld([])
    // Long enough to import, but almost entirely proper nouns and punctuation:
    // nothing to count. Choosing anyway would store a language that no later
    // screen contradicts — so it refuses and hands the question back.
    await expect(
      importSummary({
        userId: world.userId,
        workId: world.workId,
        chapterNumber: 1,
        text:
          'Luffy. Shanks. Higuma. Makino. Fuchsia. Windmill. Gol D. Roger. ' +
          'Dadan. Garp. Ace. Sabo. Zoro. Nami. Usopp. Sanji. Chopper. Robin. ' +
          'Franky. Brook. Jinbe. Merry. Sunny. Grand Line. Raftel.',
      }),
    ).rejects.toThrow(/français ou en anglais/)

    // The same text with the answer supplied goes through: the refusal is a
    // question, not a wall.
    const result = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      language: 'fr',
      text:
        'Luffy. Shanks. Higuma. Makino. Fuchsia. Windmill. Gol D. Roger. ' +
        'Dadan. Garp. Ace. Sabo. Zoro. Nami. Usopp. Sanji. Chopper. Robin. ' +
        'Franky. Brook. Jinbe. Merry. Sunny. Grand Line. Raftel.',
    })
    expect(result.language).toBe('fr')
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
     * Six steps, not ten.
     *
     * Panel detection, text detection, OCR and panel description are not
     * "skipped" on a written chapter — they do not exist for it. Recording them
     * as skipped rows would leave a permanent line of noise on every run of a
     * product that no longer reads images.
     *
     * The last two are the exceptions that earn their skipped row: both exist
     * for every chapter and both do nothing here. Publication waits for an
     * instance set to review only the names, and arbitration waits for a model
     * that actually reads — this suite runs on recorded and synthetic answers,
     * which compare words and never reach the wiki. « Ignorée : revue
     * manuelle » and « ignorée : ce fournisseur ne lit pas la page » are both
     * answers to a question someone will ask.
     */
    const view = await getRun(world.userId, runId)
    expect(view!.steps.map((step) => step.key)).toEqual([
      'extract_candidates',
      'resolve_entities',
      'detect_conflicts',
      'embed',
      'arbitrate',
      'auto_publish',
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

/**
 * The same chapter, twice, in two languages.
 *
 * The glossary (0016) stops the model re-inventing a French name every chapter,
 * but it starts empty and the first chapters are decided with one side of the
 * evidence: nothing in an English summary says whether French readers translate
 * « Straw Hat Pirates ». Both versions side by side contain that answer, so the
 * model reads it instead of guessing.
 *
 * What must hold is the boundary around that gain. The second text is not a
 * source: it has no passages, no refs, and therefore nothing that can be cited.
 * A fact it alone states does not enter the graph — which is the price of not
 * having two citable texts, and it is the right price.
 */
const SUMMARY_EN = [
  'The chapter opens on Fuchsia Village. A boy called Luffy begs a red-haired',
  'man named Shanks to take him out to sea. Shanks refuses with a laugh: the sea',
  'is far too dangerous for a child.',
  '',
  'A bandit walks into the tavern and humiliates Shanks in front of everyone.',
  'Luffy is outraged that Shanks does not answer him.',
  '',
  'Left alone, Luffy swallows a strange fruit he finds in a chest. Shanks tells',
  'him that he has eaten a devil fruit and will never be able to swim again.',
].join('\n')

describe('the same chapter in the other language', () => {
  it('stores it beside the passages, marked as the other language', async () => {
    const world = await seedWorld([])
    const result = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN,
    })

    expect(result.language).toBe('fr')
    expect(result.parallelLanguage).toBe('en')

    const rows = await raw<Array<{ parallel_text: string; parallel_language: string }>>`
      SELECT parallel_text, parallel_language FROM chapters WHERE id = ${result.chapterId}`
    expect(rows[0]!.parallel_language).toBe('en')
    expect(rows[0]!.parallel_text).toContain('Fuchsia Village')

    // No passages of its own. Passages are what a citation points at, and this
    // text is the one thing in the chapter nothing may point at.
    const passages = await chapterPassages(world.userId, result.chapterId)
    expect(passages).toHaveLength(3)
    expect(passages.every((passage) => !passage.text.includes('Fuchsia Village'))).toBe(true)
  })

  it('refuses two texts in the same language', async () => {
    // Not a language question — a paste that went wrong. The same summary in
    // both boxes teaches nothing about names and doubles what a slice costs.
    const world = await seedWorld([])
    await expect(
      importSummary({
        userId: world.userId,
        workId: world.workId,
        chapterNumber: 1,
        text: SUMMARY,
        parallelText: SUMMARY,
      }),
    ).rejects.toThrow(/même langue|deux textes/i)
  })

  it('refuses one too short to carry any correspondence', async () => {
    const world = await seedWorld([])
    await expect(
      importSummary({
        userId: world.userId,
        workId: world.workId,
        chapterNumber: 1,
        text: SUMMARY,
        parallelText: 'Luffy meets Shanks.',
      }),
    ).rejects.toThrow(/caractères/)
  })

  it('counts a changed second text as a new source', async () => {
    const world = await seedWorld([])
    const first = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN,
    })
    expect(first.unchanged).toBe(false)

    const same = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN,
    })
    expect(same.unchanged).toBe(true)

    /*
     * Nothing cites it, and it still changes the source.
     *
     * The pipeline reads it, so a chapter processed with one translation and
     * the same chapter processed with another are not the same run — the names
     * it proposes were arrived at differently. Treating this as "unchanged"
     * would leave the graph built from a text no longer stored.
     */
    const edited = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN.replace('devil fruit', 'cursed fruit'),
    })
    expect(edited.unchanged).toBe(false)
  })

  it('removes it when the chapter is re-imported without it', async () => {
    // An import states the whole source rather than adding to it — the same
    // rule as the passages. Leaving the old translation in place would keep
    // feeding the model a version of a summary you have since rewritten.
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN,
    })

    const dropped = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })

    expect(dropped.chapterId).toBe(chapterId)
    expect(dropped.parallelLanguage).toBeNull()
    const rows = await raw<Array<{ parallel_text: string | null }>>`
      SELECT parallel_text FROM chapters WHERE id = ${chapterId}`
    expect(rows[0]!.parallel_text).toBeNull()
  })

  it('leaves a chapter without one hashing exactly as it did before', async () => {
    // The second text is appended to the fingerprint only when there is one, so
    // re-importing a chapter you have not touched is still a no-op rather than
    // a rewrite that orphans the evidence pointing at its passages.
    const world = await seedWorld([])
    await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })
    const again = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })
    expect(again.unchanged).toBe(true)
  })

  it('runs the pipeline with it and anchors every proposal to a passage', async () => {
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
      parallelText: SUMMARY_EN,
    })

    const runId = await createRun(world.userId, chapterId)
    const outcome = await executeRun(world.userId, chapterId, runId)
    expect(outcome.status).toBe('succeeded')

    const passages = await chapterPassages(world.userId, chapterId)
    const stored = passages.map((passage) => passage.text).join('\n')

    const items = await raw<Array<{ payload: { evidence?: Array<{ excerpt: string }> } }>>`
      SELECT payload FROM review_items WHERE run_id = ${runId}`
    expect(items.length).toBeGreaterThan(0)

    /*
     * Every citation lands in the citable text, and none in the translation.
     *
     * The guard is not the prompt asking nicely: the parallel passages carry no
     * refs, so they cannot be in the allowed list, and anything quoting them is
     * quarantined by the same check that catches an invented reference.
     */
    for (const item of items) {
      for (const evidence of item.payload.evidence ?? []) {
        expect(stored).toContain(evidence.excerpt)
      }
    }
  })
})

describe('finishing a review', () => {
  /**
   * Where a chapter's review ends, and why it has to end somewhere.
   *
   * The reader's boundary is the highest *published* chapter number. Import
   * leaves a chapter in `uploaded`, a successful run leaves it in `review`, and
   * publishing its decisions used to leave it there too — so the boundary stayed
   * at zero and every row publication had just written was hidden by the same
   * policies that date facts by revelation. Everything worked, and the graph was
   * empty.
   */
  async function queued(runId: string): Promise<string[]> {
    const rows = await raw<Array<{ id: string }>>`
      SELECT id FROM review_items WHERE run_id = ${runId} AND status = 'proposed'`
    return rows.map((row) => row.id)
  }

  async function statusOf(chapterId: string): Promise<string> {
    const [row] = await raw<Array<{ status: string }>>`
      SELECT status FROM chapters WHERE id = ${chapterId}`
    return row!.status
  }

  it('opens the chapter once nothing is left proposed', async () => {
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })
    const runId = await createRun(world.userId, chapterId)
    await executeRun(world.userId, chapterId, runId)

    expect(await statusOf(chapterId)).toBe('review')

    const items = await queued(runId)
    expect(items.length).toBeGreaterThan(0)

    const result = await publishDecisions(
      world.userId,
      runId,
      // Deferring rather than accepting: a decision is a decision, and this is
      // about when the review ends, not about what enters the graph.
      items.map((reviewItemId) => ({ reviewItemId, decision: 'defer' as const })),
    )

    expect(result.chapterPublished).toBe(1)
    expect(await statusOf(chapterId)).toBe('published')

    const [row] = await raw<Array<{ published_at: string | null }>>`
      SELECT published_at FROM chapters WHERE id = ${chapterId}`
    expect(row!.published_at).not.toBeNull()
  })

  it('leaves it open while one proposal is still undecided', async () => {
    const world = await seedWorld([])
    const { chapterId } = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 1,
      text: SUMMARY,
    })
    const runId = await createRun(world.userId, chapterId)
    await executeRun(world.userId, chapterId, runId)

    const items = await queued(runId)
    const result = await publishDecisions(
      world.userId,
      runId,
      // All but one: a chapter is read when every question has been answered,
      // and opening the boundary over an unread proposal is the one mistake
      // this design exists to prevent.
      items.slice(1).map((reviewItemId) => ({ reviewItemId, decision: 'defer' as const })),
    )

    expect(result.chapterPublished).toBeNull()
    expect(await statusOf(chapterId)).toBe('review')
  })
})
