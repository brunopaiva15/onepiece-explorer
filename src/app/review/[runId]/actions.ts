'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import {
  markChapterReviewed,
  publishDecisions,
  type Decision,
  type PublishResult,
} from '@/domains/review/publish.ts'

export interface ReviewActionResult {
  ok: boolean
  published?: PublishResult
  error?: string
}

/**
 * Apply a batch of decisions.
 *
 * Batched rather than one call per click, for a reason that is about correctness
 * rather than latency: entities and the assertions that reference them have to be
 * published in the same transaction, so accepting an entity and its relation
 * separately would leave a window where the relation cannot resolve its subject.
 * The interface keeps decisions local until the reviewer publishes, which also
 * means they can change their mind for free.
 */
export async function publishDecisionsAction(
  runId: string,
  decisions: Decision[],
): Promise<ReviewActionResult> {
  try {
    const session = await requireOwner()

    if (decisions.length === 0) {
      return { ok: false, error: 'Aucune décision à publier.' }
    }

    const published = await publishDecisions(session.userId, runId, decisions)

    revalidatePath(`/review/${runId}`)
    revalidatePath('/chapitres')

    return { ok: true, published }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Publication impossible.',
    }
  }
}

/**
 * Close a review whose queue was emptied before publication knew how to.
 *
 * Every chapter reviewed from now on is opened by `publishDecisions` itself.
 * This exists for the ones decided earlier — accepted, published, and then
 * invisible, because the reader's boundary only counts published chapters and
 * nothing ever published one.
 */
export async function markChapterReviewedAction(
  runId: string,
): Promise<{ ok: boolean; chapterNumber?: number; error?: string }> {
  try {
    const session = await requireOwner()
    const chapterNumber = await markChapterReviewed(session.userId, runId)

    revalidatePath(`/review/${runId}`)
    revalidatePath('/chapitres')
    revalidatePath('/graph')

    if (chapterNumber === null) {
      return {
        ok: false,
        error: 'Il reste des propositions à décider pour ce chapitre.',
      }
    }
    return { ok: true, chapterNumber }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Opération impossible.',
    }
  }
}
