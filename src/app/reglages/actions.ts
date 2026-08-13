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
import {
  retypeDevilFruitsAsObjects,
  type FruitReclassification,
} from '@/domains/knowledge/retype.ts'
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

export interface ReclassifyFruitsResult {
  ok: boolean
  result?: FruitReclassification
  error?: string
}

/**
 * Move every Devil Fruit out of « Pouvoir ».
 *
 * The ontology used to say a fruit *was* a power, so a library imported before
 * that was corrected has them all filed beside the techniques they grant. This
 * is that correction applied to what is already published — the fiche does one
 * entity, this does the eighty nobody is going to click through.
 *
 * Not rate-limited, unlike the enrichment beside it: it calls no model, reaches
 * no third party, and writes one column of the reader's own rows. What it will
 * not do is decide anything: a fruit whose published facts the new type forbids
 * is reported, never forced, because rejecting a fact in bulk is exactly the
 * silent damage the per-entity form exists to prevent.
 */
export async function reclassifyDevilFruitsAction(): Promise<ReclassifyFruitsResult> {
  try {
    const session = await requireOwner()
    const result = await retypeDevilFruitsAsObjects(session.userId)

    if (result.retyped.length > 0) {
      revalidatePath('/reglages')
      revalidatePath('/graph')
      revalidatePath('/graph/table')
      revalidatePath('/recherche')
    }

    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Reclassement impossible.',
    }
  }
}
