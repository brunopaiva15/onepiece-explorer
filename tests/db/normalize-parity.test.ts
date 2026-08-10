import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'
import {
  anchorMatch,
  isAnchoredIn,
  normalizeText,
} from '@/domains/knowledge/normalize.ts'

/**
 * The contract between the application's anchoring check and the database's.
 *
 * Not string equality — the two normalisations deliberately differ, because
 * PostgreSQL's unaccent() reads a rules file whose contents vary between
 * installations (it folds ß→ss, …→…, «→<<, full-width→ASCII; Unicode NFD does
 * not). Requiring them to agree character for character would make imports
 * fail depending on which PostgreSQL you happen to be running.
 *
 * What must hold is the property: **anything the application accepts, the
 * database accepts too.** Since 0008 the trigger normalises both the excerpt
 * and the stored text with the same function, so extra folding cancels out.
 * This suite proves it end to end, by actually inserting.
 */

const world = { current: null as Awaited<ReturnType<typeof seedWorld>> | null }
const ids = {
  chapterId: '',
  pageId: '',
  assertionId: '',
}

/** Lines that exercise the characters where the two normalisations disagree. */
const BLOCKS = [
  'Je serai le Roi des Pirates !',
  'L’homme au chapeau de paille — celui de Shanks',
  'Straße, Ångström, Ñoño',
  'Cœur et sœur, Æther',
  'Ponctuation : virgules, points… tirets — et « guillemets »',
  'ｆｕｌｌｗｉｄｔｈ et demi-largeur',
  'ÉÈÊË àâä ÎÏ ôö ùûü ç',
]

beforeAll(async () => {
  await resetDatabase()
  const w = await seedWorld([1])
  world.current = w
  ids.chapterId = w.chapterIds.get(1)!

  const documentId = randomUUID()
  ids.pageId = randomUUID()
  await raw`
    INSERT INTO documents (id, chapter_id, user_id, kind, original_filename,
                           byte_size, sha256, mime, storage_key)
    VALUES (${documentId}, ${ids.chapterId}, ${w.userId}, 'pdf', 'ch1.pdf',
            1, 'hash', 'application/pdf', 'key')
  `
  await raw`
    INSERT INTO pages (id, chapter_id, document_id, user_id, index,
                       width, height, storage_key_original, chapter_number)
    VALUES (${ids.pageId}, ${ids.chapterId}, ${documentId}, ${w.userId}, 0,
            800, 1200, 'key', 1)
  `

  const entityId = randomUUID()
  await raw`
    INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
    VALUES (${entityId}, ${w.workId}, ${w.userId}, 'character', 1, 'accepted')
  `
  ids.assertionId = randomUUID()
  await raw`
    INSERT INTO assertions (id, work_id, user_id, subject_entity_id, predicate,
                            object_value, knowledge_from_chapter,
                            observed_in_chapter, epistemic_status,
                            review_status, proposed_by)
    VALUES (${ids.assertionId}, ${w.workId}, ${w.userId}, ${entityId},
            'appears_in', '{"chapter":1}'::jsonb, 1, 1, 'explicit',
            'accepted', 'ai')
  `
})

afterAll(async () => {
  await closeDb()
})

/** Store a block the way the ingestion pipeline does, then try to cite it. */
async function insertBlockAndCite(
  blockText: string,
  excerpt: string,
): Promise<{ accepted: boolean; error?: string }> {
  const w = world.current!
  const blockId = randomUUID()

  await raw`
    INSERT INTO text_blocks (id, page_id, chapter_id, user_id, bbox, text,
                             normalized_text, source, chapter_number)
    VALUES (${blockId}, ${ids.pageId}, ${ids.chapterId}, ${w.userId},
            '{"x":0,"y":0,"w":1,"h":1}'::jsonb, ${blockText},
            ${normalizeText(blockText)}, 'pdf_text', 1)
  `

  try {
    await raw`
      INSERT INTO evidence (assertion_id, user_id, chapter_id, page_id,
                            text_block_id, kind, excerpt)
      VALUES (${ids.assertionId}, ${w.userId}, ${ids.chapterId}, ${ids.pageId},
              ${blockId}, 'dialogue', ${excerpt})
    `
    return { accepted: true }
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

describe('anchoring contract: what the application accepts, the database accepts', () => {
  it('accepts every exact quote the application considers anchored', async () => {
    const rejected: string[] = []

    for (const block of BLOCKS) {
      // Quote a real slice of the middle of the line — the shape of a genuine
      // excerpt, not the whole line.
      const words = block.split(' ')
      const excerpt = words.slice(1, Math.max(2, words.length - 1)).join(' ')

      expect(isAnchoredIn(excerpt, block)).toBe(true)

      const result = await insertBlockAndCite(block, excerpt)
      if (!result.accepted) {
        rejected.push(
          `  bloc    : ${JSON.stringify(block)}\n` +
            `    extrait : ${JSON.stringify(excerpt)}\n` +
            `    erreur  : ${result.error}`,
        )
      }
    }

    expect(
      rejected,
      `La base a refusé des extraits que l'application juge ancrés :\n${rejected.join('\n')}`,
    ).toEqual([])
  })

  it('refuses a claim that is true of One Piece but absent from the cited page', async () => {
    const block = 'Je serai le Roi des Pirates !'
    const excerpt = 'Mon père est Gol D. Roger'

    // The application rejects it...
    expect(isAnchoredIn(excerpt, block)).toBe(false)
    // ...and so does the database, independently.
    const result = await insertBlockAndCite(block, excerpt)
    expect(result.accepted).toBe(false)
    expect(result.error).toContain('non ancré')
  })

  it('survives typographic variation between scanlation releases', async () => {
    // Same line, different apostrophe and dash conventions.
    const stored = 'L’homme au chapeau de paille — celui de Shanks'
    const quotedDifferently = "L'homme au chapeau de paille - celui de Shanks"

    expect(isAnchoredIn(quotedDifferently, stored)).toBe(true)
    const result = await insertBlockAndCite(stored, quotedDifferently)
    expect(result.accepted).toBe(true)
  })
})

describe('fuzzy anchoring for OCR noise', () => {
  const block = 'je serai le roi des pirates !'

  it('accepts an exact quote as exact', () => {
    expect(anchorMatch('Roi des Pirates', block)).toEqual({
      matched: true,
      exact: true,
    })
  })

  it('accepts a character-level OCR confusion, but flags it inexact', () => {
    const result = anchorMatch('je serai Ie roi des pirates', block)
    expect(result.matched).toBe(true)
    if (result.matched) expect(result.exact).toBe(false)
  })

  it('rejects an empty excerpt', () => {
    expect(anchorMatch('   ', block).matched).toBe(false)
  })

  it('does not stretch to a different claim', () => {
    // A whole word swapped is not OCR noise, it is a different sentence. The
    // budget — one error per ten characters, capped at four — is deliberately
    // too tight to absorb it.
    expect(anchorMatch('je serai le roi des marines', block).matched).toBe(false)
    expect(
      anchorMatch('la carte du monde est cachée sous la mer', block).matched,
    ).toBe(false)
  })
})
