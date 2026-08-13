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

export interface PreviewResult {
  ok: boolean
  preview?: DeletionPreview
  error?: string
}

export async function previewDeletionAction(
  chapterId: string,
): Promise<PreviewResult> {
  try {
    const session = await requireOwner()
    const preview = await previewDeletion(session.userId, chapterId)
    if (!preview) return { ok: false, error: 'Chapitre introuvable.' }
    return { ok: true, preview }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Aperçu impossible.',
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
  try {
    const session = await requireOwner()

    const preview = await previewDeletion(session.userId, chapterId)
    if (!preview) return { ok: false, error: 'Chapitre introuvable.' }

    if (confirmation.trim() !== String(preview.chapterNumber)) {
      return {
        ok: false,
        error:
          `Confirmation incorrecte. Tapez ${preview.chapterNumber} pour confirmer ` +
          `la suppression du chapitre ${preview.chapterNumber}.`,
      }
    }

    const result = await deleteChapter(session.userId, chapterId, { keepKnowledge })

    revalidatePath('/reglages')
    revalidatePath('/chapitres')
    revalidatePath('/graph')

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Suppression impossible.',
    }
  }
}

export interface EnrichImagesResult {
  ok: boolean
  considered?: number
  stored?: number
  unmatched?: number
  /** Of the pictures found, how many came from the wiki fallback. */
  fromWiki?: number
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
  try {
    const session = await requireOwner()

    const allowance = await consume(session.userId, 'start_run')
    if (!allowance.allowed) {
      return {
        ok: false,
        error:
          `Limite atteinte. Réessayez dans ${allowance.retryInMinutes} minute(s). ` +
          allowance.explain,
      }
    }

    const report = await enrichEntityImages(session.userId)

    const notes = [
      ...(report.cacheNote ? [report.cacheNote] : []),
      ...report.catalogueFailures.map(
        (failure) => `${failure.source} injoignable : ${failure.reason}`,
      ),
      ...report.failures
        .slice(0, 5)
        .map((failure) => `« ${failure.label} » : ${failure.reason}`),
    ]

    revalidatePath('/reglages')
    revalidatePath('/graph')
    revalidatePath('/graph/table')

    return {
      ok: true,
      considered: report.considered,
      stored: report.stored,
      unmatched: report.unmatched,
      fromWiki: report.fromWiki,
      failures: report.failures.length,
      catalogueSize: report.catalogueSize,
      notes,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Enrichissement impossible.',
    }
  }
}
