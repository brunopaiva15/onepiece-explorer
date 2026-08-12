'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import {
  deleteChapter,
  previewDeletion,
  type DeletionPreview,
  type DeletionResult,
} from '@/domains/chapters/delete.ts'
import { enrichEntityImages } from '@/domains/images/index.ts'
import { consume } from '@/domains/observability/rate-limit.ts'
import { getLocale } from '@/lib/i18n/server.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

export interface PreviewResult {
  ok: boolean
  preview?: DeletionPreview
  error?: string
}

export async function previewDeletionAction(
  chapterId: string,
): Promise<PreviewResult> {
  // Resolved before the try: getLocale never throws, and the catch needs it.
  const t = getDictFor(await getLocale()).settings
  try {
    const session = await requireOwner()
    const preview = await previewDeletion(session.userId, chapterId)
    if (!preview) return { ok: false, error: t.chapterNotFound }
    return { ok: true, preview }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : t.previewFailed,
    }
  }
}

export interface DeleteResult {
  ok: boolean
  result?: DeletionResult
  error?: string
}

/**
 * Delete a chapter.
 *
 * The confirmation is checked server-side, not only in the browser. A
 * client-side-only guard on an irreversible action is a suggestion, and this one
 * removes files the reader may have no other copy of.
 */
export async function deleteChapterAction(
  chapterId: string,
  confirmation: string,
  keepKnowledge: boolean,
): Promise<DeleteResult> {
  const t = getDictFor(await getLocale()).settings
  try {
    const session = await requireOwner()

    const preview = await previewDeletion(session.userId, chapterId)
    if (!preview) return { ok: false, error: t.chapterNotFound }

    if (confirmation.trim() !== String(preview.chapterNumber)) {
      return { ok: false, error: t.confirmIncorrect(preview.chapterNumber) }
    }

    const result = await deleteChapter(session.userId, chapterId, { keepKnowledge })

    revalidatePath('/reglages')
    revalidatePath('/chapitres')
    revalidatePath('/graph')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : t.deleteFailed,
    }
  }
}

export interface EnrichImagesResult {
  ok: boolean
  considered?: number
  stored?: number
  unmatched?: number
  failures?: number
  catalogueSize?: number
  notes?: string[]
  error?: string
}

/**
 * Fetch illustrations for the entities that have none.
 *
 * Rate-limited under `start_run`, not because it calls a model — it does not,
 * and it costs nothing — but because it downloads from three free community
 * services. A button that can be clicked in a loop is a button that can hammer
 * someone else's server, and being polite to them is worth one shared counter.
 */
export async function enrichImagesAction(): Promise<EnrichImagesResult> {
  const locale = await getLocale()
  const t = getDictFor(locale).settings
  try {
    const session = await requireOwner()

    const allowance = await consume(session.userId, 'start_run')
    if (!allowance.allowed) {
      // Null only when allowed; the window length is the worst honest answer.
      const minutes = allowance.retryInMinutes ?? 60
      // `allowance.explain` is domain-produced French prose; appended for the
      // French interface only rather than shown untranslated in English.
      return {
        ok: false,
        error:
          locale === 'fr'
            ? `${t.rateLimited(minutes)} ${allowance.explain}`
            : t.rateLimited(minutes),
      }
    }

    const report = await enrichEntityImages(session.userId)

    const notes = [
      ...report.catalogueFailures.map((failure) =>
        t.noteCatalogueDown(failure.source, failure.reason),
      ),
      ...report.failures
        .slice(0, 5)
        .map((failure) => t.noteEntityFailed(failure.label, failure.reason)),
    ]

    revalidatePath('/reglages')
    revalidatePath('/graph')
    revalidatePath('/graph/table')

    return {
      ok: true,
      considered: report.considered,
      stored: report.stored,
      unmatched: report.unmatched,
      failures: report.failures.length,
      catalogueSize: report.catalogueSize,
      notes,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : t.enrichFailed,
    }
  }
}
