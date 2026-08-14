import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'
import {
  chapters,
  documents,
  pages,
  textBlocks,
  type ChapterSourceKind,
} from '@/db/schema/documents.ts'
import { storage } from '../storage/index.ts'

/**
 * Reads for the library and the page viewer.
 *
 * Two different access modes, and the split is deliberate. Chapter *metadata*
 * — that chapter 42 exists, has 19 pages and was imported on Tuesday — is
 * ownership-scoped: knowing you own a file is not knowing what happens in it,
 * and hiding the list behind the boundary would make the slider impossible to
 * operate. Page *content* is boundary-scoped, because a page is the story.
 *
 * So listChapters() runs through withIngest() and filters on the verified
 * userId explicitly, while getChapterPages() runs through withBoundary() and
 * lets row-level security decide.
 */

/** Derived from the enum, not restated — a restated union drifts silently. */
export type ChapterStatus = (typeof chapters.status.enumValues)[number]

export interface ChapterSummary {
  id: string
  number: number
  title: string | null
  volume: number | null
  status: ChapterStatus
  /** Drawn pages, or a text you wrote. */
  sourceKind: ChapterSourceKind
  pageCount: number
  /** Citable units of a written chapter. Zero for one imported from a file. */
  passageCount: number
  readingDirection: 'rtl' | 'ltr'
  hasTextLayer: boolean
  updatedAt: Date
}

export async function listChapters(
  userId: string,
  workId: string,
): Promise<ChapterSummary[]> {
  /*
   * No library, no chapters.
   *
   * A visitor reading a public library whose owner id points at nothing gets an
   * empty workId. Passing that to a uuid column raises a syntax error and turns
   * a mistyped PUBLIC_LIBRARY_OWNER_ID into a 500 — which reports a broken
   * application where the truth is a wrong value in one setting.
   */
  if (workId.length === 0) return []

  return withIngest(async (db) => {
    const rows = await db
      .select({
        id: chapters.id,
        number: chapters.number,
        title: chapters.title,
        volume: chapters.volume,
        status: chapters.status,
        sourceKind: chapters.sourceKind,
        pageCount: chapters.pageCount,
        readingDirection: chapters.readingDirection,
        updatedAt: chapters.updatedAt,
        hasTextLayer: sql<boolean>`coalesce(bool_or(${documents.hasTextLayer}), false)`,
        /*
         * Passages, and only for a chapter that has them.
         *
         * Distinct, because the join to documents multiplies rows and a count
         * inflated by the number of source files would be wrong in the one
         * place you check whether a paste landed. And zero for a file-imported
         * chapter, because its text blocks are OCR'd bubbles — counting those
         * as passages would make the library's total the sum of its pages *and*
         * every speech balloon on them.
         */
        passageCount: sql<number>`
          case when ${chapters.sourceKind} = 'summary'
            then count(distinct ${textBlocks.id})::int
            else 0
          end`,
      })
      .from(chapters)
      .leftJoin(documents, eq(documents.chapterId, chapters.id))
      .leftJoin(textBlocks, eq(textBlocks.chapterId, chapters.id))
      .where(and(eq(chapters.workId, workId), eq(chapters.userId, userId)))
      .groupBy(chapters.id)
      .orderBy(asc(chapters.number))

    return rows
  })
}

/**
 * The numbers of the published chapters, ascending.
 *
 * listChapters() joins documents and text blocks to count pages and passages,
 * which is what the library table is made of and far more than a control that
 * only needs to know which numbers exist. A thousand-chapter library asks this
 * on every render of story mode, so it stays a single indexed read of one
 * column.
 *
 * Ownership-scoped like the rest of the metadata reads: that chapter 42 exists
 * is a fact about your library, not about the story.
 */
export async function listPublishedChapterNumbers(
  userId: string,
  workId: string,
): Promise<number[]> {
  if (workId.length === 0) return []

  return withIngest(async (db) => {
    const rows = await db
      .select({ number: chapters.number })
      .from(chapters)
      .where(
        and(
          eq(chapters.workId, workId),
          eq(chapters.userId, userId),
          eq(chapters.status, 'published'),
        ),
      )
      .orderBy(asc(chapters.number))

    return rows.map((row) => row.number)
  })
}

export interface ChapterDetail {
  id: string
  number: number
  title: string | null
  readingDirection: 'rtl' | 'ltr'
  status: ChapterStatus
  sourceKind: ChapterSourceKind
  /** The language the source is written in — the language its excerpts quote. */
  language: string
  /**
   * The same chapter in the other language, when one was supplied.
   *
   * Shown on the chapter page as prose rather than as numbered passages,
   * because the numbering is what a citation points at and nothing may cite
   * this. Seeing it stated that way is the point: what is citable has a number.
   */
  parallelText: string | null
  parallelLanguage: 'fr' | 'en' | null
}

/** Metadata for one chapter. Ownership-scoped, like the list. */
export async function getChapter(
  userId: string,
  chapterId: string,
): Promise<ChapterDetail | null> {
  return withIngest(async (db) => {
    const [row] = await db
      .select({
        id: chapters.id,
        number: chapters.number,
        title: chapters.title,
        readingDirection: chapters.readingDirection,
        status: chapters.status,
        sourceKind: chapters.sourceKind,
        language: chapters.language,
        parallelText: chapters.parallelText,
        parallelLanguage: chapters.parallelLanguage,
      })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    return row ?? null
  })
}

export interface PageView {
  id: string
  index: number
  width: number
  height: number
  isDoubleSpread: boolean
  excluded: boolean
  kind: 'narrative' | 'cover' | 'bonus' | 'other'
  /** Short-lived, minted per request. Never stored, never a durable address. */
  thumbUrl: string | null
  displayUrl: string | null
  textBlockCount: number
}

/**
 * Pages of a chapter, with freshly signed URLs.
 *
 * Read through withBoundary at the chapter's own number: the reader is looking
 * at a chapter they have just imported, which is by definition a chapter they
 * have read. This is the one place the boundary is raised deliberately, and it
 * is raised to exactly one chapter, not lifted.
 */
export async function getChapterPages(
  userId: string,
  chapterId: string,
  chapterNumber: number,
): Promise<PageView[]> {
  const rows = await withBoundary(
    { userId, boundaryChapter: chapterNumber },
    async (db) =>
      db
        .select({
          id: pages.id,
          index: pages.index,
          width: pages.width,
          height: pages.height,
          isDoubleSpread: pages.isDoubleSpread,
          excluded: pages.excluded,
          kind: pages.kind,
          thumbKey: pages.storageKeyThumb,
          displayKey: pages.storageKeyDisplay,
        })
        .from(pages)
        .where(and(eq(pages.chapterId, chapterId), eq(pages.userId, userId)))
        .orderBy(asc(pages.index)),
  )

  const counts = await withBoundary(
    { userId, boundaryChapter: chapterNumber },
    async (db) =>
      db.execute<{ page_id: string; count: number }>(
        sql`SELECT page_id, count(*)::int AS count FROM text_blocks
            WHERE chapter_id = ${chapterId} GROUP BY page_id`,
      ),
  )
  const byPage = new Map(counts.map((row) => [row.page_id, Number(row.count)]))

  const store = storage()

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      index: row.index,
      width: row.width,
      height: row.height,
      isDoubleSpread: row.isDoubleSpread,
      excluded: row.excluded,
      kind: row.kind,
      thumbUrl: row.thumbKey ? await store.signedUrl(row.thumbKey) : null,
      displayUrl: row.displayKey ? await store.signedUrl(row.displayKey) : null,
      textBlockCount: byPage.get(row.id) ?? 0,
    })),
  )
}
