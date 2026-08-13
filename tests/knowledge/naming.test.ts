import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withIngest } from '@/db/boundary.ts'
import { futureNameReason, nameRevealedLater } from '@/domains/knowledge/naming.ts'
import { closeDb, raw, resetDatabase, seedWorld, type SeededWorld } from '../helpers/db.ts'

/**
 * The name that came from fifty chapters later.
 *
 * The source of chapters 23 to 25 says « Klahadore » and never « Kuro »; the
 * word « Kuro » first occurs in chapter 26, exactly where the manga reveals it.
 * The extraction got this right every time. What did not was the naming card,
 * which asks « comment dit-on ce nom en français ? », shows the source term,
 * and knows nothing about where the reader is — so it was answered « Kuro »,
 * three times, and the graph recorded that as a true name revealed at chapter
 * 23.
 *
 * The property these tests pin is the one that makes the check usable rather
 * than merely strict: it must fire on a name the book contains *later*, and
 * stay silent on a French form the book contains *nowhere*. « Piiman » becomes
 * « Piment » and « Tamanegi » becomes « Oignon » — correct localisations that
 * appear in no source, and a check that refused those would have to be turned
 * off the day it shipped.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([23, 26])
})

afterAll(async () => {
  await closeDb()
})

async function sourceText(chapterNumber: number, text: string): Promise<void> {
  const chapterId = world.chapterIds.get(chapterNumber)!
  const pageId = crypto.randomUUID()
  await raw`
    INSERT INTO pages (id, chapter_id, user_id, index, width, height,
                       storage_key_original, chapter_number)
    VALUES (${pageId}, ${chapterId}, ${world.userId},
            (SELECT coalesce(max(index), -1) + 1 FROM pages WHERE chapter_id = ${chapterId}),
            800, 1200, 'key', ${chapterNumber})
  `
  await raw`
    INSERT INTO text_blocks (id, page_id, chapter_id, user_id, bbox, text,
                             normalized_text, source, chapter_number)
    VALUES (${crypto.randomUUID()}, ${pageId}, ${chapterId}, ${world.userId},
            '{"x":0,"y":0,"w":1,"h":1}'::jsonb, ${text},
            app.normalize_text(${text}), 'pdf_text', ${chapterNumber})
  `
}

function ask(input: {
  chapterNumber: number
  label: string
  sourceTerm?: string | null
}): Promise<Awaited<ReturnType<typeof nameRevealedLater>>> {
  return withIngest((db) =>
    nameRevealedLater(db, {
      userId: world.userId,
      workId: world.workId,
      chapterNumber: input.chapterNumber,
      label: input.label,
      sourceTerm: input.sourceTerm ?? null,
    }),
  )
}

describe('a name the reader has not reached', () => {
  beforeEach(async () => {
    await sourceText(23, 'Kaya asks her butler Klahadore if she can meet Usopp.')
    await sourceText(
      26,
      'Usopp suddenly remembers the name "Captain Kuro", a feared pirate.',
    )
  })

  it('refuses the name the book only reaches later', async () => {
    const found = await ask({
      chapterNumber: 23,
      label: 'Kuro',
      sourceTerm: 'Klahadore',
    })

    expect(found).not.toBeNull()
    expect(found!.occursFromChapter).toBe(26)
    expect(found!.revealedInChapter).toBe(23)
  })

  it('says which chapters, and what the source called it', async () => {
    const found = await ask({ chapterNumber: 23, label: 'Kuro', sourceTerm: 'Klahadore' })
    const reason = futureNameReason(found!)

    // The reader is looking at a naming card and has to type something else.
    // The answer is the word the card was already showing them.
    expect(reason).toContain('chapitre 26')
    expect(reason).toContain('chapitre 23')
    expect(reason).toContain('Klahadore')
  })

  it('accepts the name the chapter itself uses', async () => {
    expect(await ask({ chapterNumber: 23, label: 'Klahadore' })).toBeNull()
  })

  it('accepts the same name once the reader has read that far', async () => {
    expect(await ask({ chapterNumber: 26, label: 'Kuro', sourceTerm: 'Captain Kuro' })).toBeNull()
  })

  it('leaves a French form the source never contains alone', async () => {
    // « Piiman » → « Piment ». In no chapter of the work, so this cannot judge
    // it and must not: refusing it would refuse every real translation.
    expect(await ask({ chapterNumber: 23, label: 'Piment', sourceTerm: 'Piiman' })).toBeNull()
  })
})

describe('what the check will not do', () => {
  it('does not match a name inside a longer word', async () => {
    await sourceText(23, 'The Marine called Sorrow guards the gate.')
    await sourceText(26, 'Soro finally gives his name.')

    // « Soro » occurs inside « Sorrow » at chapter 23. Treating that as an
    // occurrence would silently accept a name from chapter 26 three chapters
    // early — the exact failure, arrived at from the other side.
    const found = await ask({ chapterNumber: 23, label: 'Soro' })
    expect(found).not.toBeNull()
    expect(found!.occursFromChapter).toBe(26)
  })

  it('ignores a name too short to look for', async () => {
    await sourceText(26, 'Ab is written here.')
    expect(await ask({ chapterNumber: 23, label: 'Ab' })).toBeNull()
  })

  it('says nothing about a work with no source text imported', async () => {
    expect(await ask({ chapterNumber: 23, label: 'Kuro' })).toBeNull()
  })
})
