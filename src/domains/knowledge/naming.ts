import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, textBlocks } from '@/db/schema/documents.ts'
import { normalizeText } from './normalize.ts'

/**
 * A name the reader is not supposed to have yet.
 *
 * Every other defence in this pipeline guards the *claim*. An excerpt is
 * checked character by character against the block it cites (ADR 0003), a
 * relation's ends are checked against the ontology (ADR 0004), an identity
 * never publishes without a human. Nothing checked the *name*, and a name is
 * the purest form of the spoiler this product exists to prevent: it is the
 * whole content of a reveal, and it arrives on the fiche, in the search, and in
 * the story feed all at once.
 *
 * The hole is not in the extraction. Asked about chapters 23 to 25, whose
 * source says « Klahadore » and never « Kuro », the model proposed
 * « Klahadore » three times and « Kuro » only at chapter 26, where the source
 * reveals it. The hole is one step later. A proposal that is unsure of a French
 * form sets `naming_confident: false`, and the review card then asks « comment
 * dit-on ce nom en français ? » — showing the source term, and nothing else. No
 * chapter, no text, no notion that an answer could be from the future. A reader
 * who knows the story answers with the name they know, which for Klahadore is
 * Kuro, fifty chapters early; the answer is written as a `true_name` revealed at
 * chapter 23, and the glossary then hands it to every later chapter as settled
 * vocabulary.
 *
 * What makes this checkable is that the library holds the evidence itself. The
 * source text of every chapter is in `text_blocks`, so « when does this word
 * first appear » is a question with an answer:
 *
 *   - The name occurs at or before this chapter → it is on the page. Fine.
 *   - The name occurs nowhere in the whole work → it is a translation or an
 *     invention, and this cannot tell which. Fine, and deliberately so:
 *     « Piiman » becomes « Piment » and « Tamanegi » becomes « Oignon », which
 *     are exactly right and appear in no source. Refusing those would make the
 *     check useless the day it shipped.
 *   - The name occurs only *later* → the reader could not have read it here.
 *     That is the one case, and it is not a matter of degree: the word is in
 *     the book, at a chapter this one precedes.
 *
 * So the rule has no threshold and no model in it. It fires on Kuro at chapter
 * 23 because « Kuro » is in the source of chapter 26, and stays silent on every
 * legitimate localisation because those are in no source at all.
 *
 * Limited to `true_name` by the caller. A placeholder is a description drawn
 * from the art — « l'homme au foulard rayé » — and is not expected to occur
 * anywhere; an epithet and an alias are the same kind of thing. The true name
 * is the one that claims to be what the thing is called, and the only one whose
 * arrival is a revelation.
 */

export interface FutureName {
  label: string
  /** What the source called it, when the proposal said. */
  sourceTerm: string | null
  /** The chapter the name was about to be recorded as revealed in. */
  revealedInChapter: number
  /** The earliest chapter whose text actually contains it. */
  occursFromChapter: number
}

/**
 * Below this, a name is too short to look for.
 *
 * Word boundaries make a three-letter match respectable and a two-letter one
 * an accident waiting in a hundred thousand words of prose. Nothing is lost:
 * the check exists for names that carry a reveal, and those are not two letters
 * long.
 */
const MIN_LENGTH = 3

export async function nameRevealedLater(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    userId: string
    workId: string
    /** The chapter being published — where this name would become known. */
    chapterNumber: number
    label: string
    sourceTerm: string | null
  },
): Promise<FutureName | null> {
  const needle = normalizeText(input.label)
  if (needle.length < MIN_LENGTH) return null

  /*
   * A word, not a substring. « Soro » inside « Sorrow » is not an occurrence of
   * the name, and a check that treated it as one would refuse a correct answer
   * for a reason nobody could see. `\y` is PostgreSQL's word boundary; the
   * needle is escaped because a label may legitimately contain a metacharacter
   * — « Gomu Gomu no Mi (?) » is a label somebody will write one day.
   */
  const pattern = `\\y${needle.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}\\y`

  const rows = await db
    .select({ first: sql<number | null>`min(${chapters.number})` })
    .from(textBlocks)
    .innerJoin(chapters, eq(chapters.id, textBlocks.chapterId))
    .where(
      and(
        eq(chapters.workId, input.workId),
        eq(chapters.userId, input.userId),
        sql`${textBlocks.normalizedText} ~ ${pattern}`,
      ),
    )

  const first = rows[0]?.first ?? null

  // Nowhere in the work: a translation this cannot judge, and must not.
  if (first === null) return null
  // Already on the page here or earlier: the reader has read it.
  if (first <= input.chapterNumber) return null

  return {
    label: input.label,
    sourceTerm: input.sourceTerm,
    revealedInChapter: input.chapterNumber,
    occursFromChapter: first,
  }
}

/**
 * The refusal, in the words the reader needs to answer it.
 *
 * « Refusée par la base » would be useless here: the reader is looking at a
 * naming card and has to decide what to type instead. So the sentence names
 * both chapters and quotes the source's own word, which is the answer in every
 * case seen so far — the card was showing it the whole time.
 */
export function futureNameReason(found: FutureName): string {
  const source = found.sourceTerm
    ? ` La source de ce chapitre dit « ${found.sourceTerm} ».`
    : ''
  return (
    `« ${found.label} » n’apparaît qu’au chapitre ${found.occursFromChapter} ; ` +
    `l’enregistrer comme nom au chapitre ${found.revealedInChapter} révélerait ` +
    `au lecteur quelque chose qu’il n’a pas encore lu.${source}`
  )
}
