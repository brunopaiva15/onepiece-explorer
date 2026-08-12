'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { importChapter } from '@/domains/ingestion/import.ts'
import { IngestionRejection } from '@/domains/ingestion/limits.ts'
import { MAX_SUMMARY_CHARS, type SummaryLanguage } from '@/domains/ingestion/passages.ts'
import { reorderPages } from '@/domains/ingestion/persist.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { startChapterRun } from '@/domains/pipeline/start.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'
import { getLocale } from '@/lib/i18n/server.ts'

/**
 * Import a chapter from the browser.
 *
 * A server action rather than a route handler because the whole operation is
 * a form submission with a file in it, and the action gets CSRF protection,
 * the verified session and typed results without a hand-written endpoint.
 *
 * The file never touches the client's idea of who the user is: the uid comes
 * from getUser() server-side, and every row written is stamped with it.
 */

export interface ImportActionResult {
  ok: boolean
  chapterId?: string
  pageCount?: number
  hasTextLayer?: boolean
  replaced?: boolean
  unchanged?: boolean
  error?: { message: string; hint?: string }
}

const MAX_FIELD_LENGTH = 200

export async function importChapterAction(
  _previous: ImportActionResult | null,
  formData: FormData,
): Promise<ImportActionResult> {
  try {
    const session = await requireOwner()
    const t = getDictFor(session.locale).importer

    const numberRaw = formData.get('chapterNumber')
    const chapterNumber = Number(numberRaw)
    if (!Number.isInteger(chapterNumber) || chapterNumber < 0) {
      return {
        ok: false,
        error: {
          message: t.invalidChapterNumber,
          hint: t.invalidChapterNumberHint,
        },
      }
    }

    const title = text(formData.get('title'))
    const volume = formData.get('volume') ? Number(formData.get('volume')) : undefined
    const direction = formData.get('readingDirection') === 'ltr' ? 'ltr' : 'rtl'

    const files = formData.getAll('file').filter(isFile)
    if (files.length === 0) {
      return {
        ok: false,
        error: {
          message: t.noFile,
          hint: t.noFileHint,
        },
      }
    }

    const result =
      files.length === 1 && !isImageFile(files[0]!)
        ? await importChapter({
            userId: session.userId,
            workId: session.workId,
            chapterNumber,
            title,
            volume: Number.isFinite(volume) ? volume : undefined,
            readingDirection: direction,
            file: {
              filename: files[0]!.name,
              bytes: new Uint8Array(await files[0]!.arrayBuffer()),
            },
          })
        : await importChapter({
            userId: session.userId,
            workId: session.workId,
            chapterNumber,
            title,
            volume: Number.isFinite(volume) ? volume : undefined,
            readingDirection: direction,
            images: await Promise.all(
              files.map(async (file) => ({
                filename: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            ),
          })

    revalidatePath('/chapitres')
    revalidatePath(`/chapitres/${result.chapterId}`)

    return {
      ok: true,
      chapterId: result.chapterId,
      pageCount: result.pages.length,
      hasTextLayer: result.hasTextLayer,
      replaced: result.replaced,
      unchanged: result.unchanged,
    }
  } catch (error) {
    // An IngestionRejection already carries a message and a remedy written for
    // the person holding the file. Anything else is a bug, and saying so is
    // more useful than dressing it up as a user error.
    if (error instanceof IngestionRejection) {
      return { ok: false, error: { message: error.message, hint: error.hint } }
    }
    const t = getDictFor(await getLocale()).importer
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : t.unknownFailure,
        hint: t.unexpectedHint,
      },
    }
  }
}

export interface SummaryActionResult {
  ok: boolean
  chapterId?: string
  /** Set when the chapter went straight into the pipeline. */
  runId?: string
  /**
   * The import worked and the run did not.
   *
   * Kept apart from `error`, which means the chapter was not stored at all.
   * Collapsing the two would have a rate-limited run report a failed import and
   * send someone back to re-paste a chapter that is already saved.
   */
  runError?: string
  passageCount?: number
  characterCount?: number
  language?: SummaryLanguage
  replaced?: boolean
  unchanged?: boolean
  error?: { message: string; hint?: string }
}

/**
 * Import a chapter written out as text.
 *
 * The path that replaced file upload. Everything the pipeline needs from a
 * chapter is prose, and this is prose — so no bytes are validated, no archive
 * is walked, nothing is stored in a bucket, and the model is never shown an
 * image. What arrives is a form field, and what leaves is a set of passages any
 * later claim will have to quote.
 */
export async function importSummaryAction(
  _previous: SummaryActionResult | null,
  formData: FormData,
): Promise<SummaryActionResult> {
  try {
    const session = await requireOwner()
    const t = getDictFor(session.locale).importer

    const chapterNumber = Number(formData.get('chapterNumber'))
    if (!Number.isInteger(chapterNumber) || chapterNumber < 0) {
      return {
        ok: false,
        error: {
          message: t.invalidChapterNumber,
          hint: t.invalidChapterNumberHint,
        },
      }
    }

    const summary = formData.get('summary')
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return {
        ok: false,
        error: {
          message: t.noText,
          hint: t.noTextHint,
        },
      }
    }

    /*
     * The other-language version, optional and never a second source.
     *
     * Read as a plain field rather than validated here: length and language
     * belong to the importer, which is where the same rules apply to the
     * primary text and where a rejection can explain itself in the same terms.
     */
    const parallelRaw = formData.get('parallelSummary')
    const parallelSummary =
      typeof parallelRaw === 'string' && parallelRaw.trim().length > 0
        ? parallelRaw.slice(0, MAX_SUMMARY_CHARS + 1)
        : undefined

    const volumeRaw = formData.get('volume')
    const volume = volumeRaw ? Number(volumeRaw) : undefined
    // Absent means unchecked: a checkbox posts nothing when it is off, so the
    // default has to be read as "on" rather than inferred from presence.
    const autoRun = formData.get('autoRun') !== 'off'

    const languageRaw = formData.get('language')
    const language: SummaryLanguage | undefined =
      languageRaw === 'fr' || languageRaw === 'en' ? languageRaw : undefined

    const result = await importSummary({
      userId: session.userId,
      workId: session.workId,
      chapterNumber,
      // Sliced server-side too. A client that skips the maxLength attribute is
      // not a hypothetical when the client is a script someone wrote at 2am.
      text: summary.slice(0, MAX_SUMMARY_CHARS + 1),
      ...(text(formData.get('title')) ? { title: text(formData.get('title')) } : {}),
      ...(Number.isFinite(volume) && volume !== undefined ? { volume } : {}),
      ...(language ? { language } : {}),
      ...(parallelSummary ? { parallelText: parallelSummary } : {}),
    })

    /*
     * Import and processing, in one submission.
     *
     * They were two steps because importing a file put pages on screen while
     * you were still watching, and it was worth checking the page order before
     * paying to analyse it. A pasted text has no page order to get wrong: you
     * are looking at the source as you submit it. Keeping the split would mean
     * eleven hundred extra round trips through a chapter page to press a second
     * button.
     *
     * Skipped when nothing changed — re-pasting an identical summary must not
     * re-run a pipeline whose inputs are byte-for-byte the ones it already ran.
     */
    let runId: string | undefined
    let runError: string | undefined

    if (autoRun && !result.unchanged) {
      const started = await startChapterRun({
        userId: session.userId,
        chapterId: result.chapterId,
        provider: 'auto',
      })
      if (started.ok) runId = started.runId
      else runError = started.error
    }

    revalidatePath('/chapitres')
    revalidatePath(`/chapitres/${result.chapterId}`)

    return {
      ok: true,
      chapterId: result.chapterId,
      passageCount: result.passageCount,
      characterCount: result.characterCount,
      language: result.language,
      replaced: result.replaced,
      unchanged: result.unchanged,
      ...(runId ? { runId } : {}),
      ...(runError ? { runError } : {}),
    }
  } catch (error) {
    if (error instanceof IngestionRejection) {
      return { ok: false, error: { message: error.message, hint: error.hint } }
    }
    const t = getDictFor(await getLocale()).importer
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : t.unknownFailure,
        hint: t.unexpectedHint,
      },
    }
  }
}

export interface ReorderActionResult {
  ok: boolean
  error?: string
}

export async function reorderPagesAction(
  chapterId: string,
  order: Array<{ pageId: string; index: number; excluded?: boolean }>,
): Promise<ReorderActionResult> {
  try {
    const session = await requireOwner()
    await reorderPages(session.userId, chapterId, order)
    revalidatePath(`/chapitres/${chapterId}`)
    return { ok: true }
  } catch (error) {
    const t = getDictFor(await getLocale()).importer
    return {
      ok: false,
      error: error instanceof Error ? error.message : t.reorderFailed,
    }
  }
}

function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, MAX_FIELD_LENGTH)
  return trimmed.length > 0 ? trimmed : undefined
}

function isFile(value: FormDataEntryValue): value is File {
  return value instanceof File && value.size > 0
}

function isImageFile(file: File): boolean {
  return /\.(jpe?g|png|webp|avif)$/i.test(file.name)
}
