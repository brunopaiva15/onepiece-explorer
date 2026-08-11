'use server'

import { revalidatePath } from 'next/cache'
import { getReaderSession } from '@/domains/auth/session.ts'
import {
  deleteChapter,
  previewDeletion,
  type DeletionPreview,
  type DeletionResult,
} from '@/domains/chapters/delete.ts'

export interface PreviewResult {
  ok: boolean
  preview?: DeletionPreview
  error?: string
}

export async function previewDeletionAction(
  chapterId: string,
): Promise<PreviewResult> {
  try {
    const session = await getReaderSession()
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
    const session = await getReaderSession()

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
