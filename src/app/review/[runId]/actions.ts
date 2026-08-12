'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { requireOwner } from '@/domains/auth/session.ts'
import { illustrateQuietly } from '@/domains/images/enrich.ts'
import { autoReview, autoReviewEnabled } from '@/domains/review/auto.ts'
import {
  markChapterReviewed,
  mergePublishResults,
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

    /*
     * Release what was waiting on the answers you just gave.
     *
     * The run's automatic pass holds back a naming question and every relation
     * whose subject it names — publishing those without their entity would fail
     * on a subject that does not exist. Answering the name here is what makes
     * them publishable, so the same pass runs again on the way out rather than
     * leaving them in a queue nothing will come back to.
     */
    const swept = autoReviewEnabled() ? await autoReview(session.userId, runId) : null

    const result = swept?.published
      ? mergePublishResults(published, swept.published)
      : published

    /*
     * A chapter that has just become readable, illustrated on the way out.
     *
     * `after()` for the same reason the pipeline uses it: this downloads and
     * re-encodes pictures, and the reviewer who clicked « publier » should not
     * wait for it. Only when the chapter actually opened — publishing a batch
     * mid-review would run it several times over the same entities for nothing.
     */
    if (result.chapterPublished !== null) {
      // No revalidation on the way out: /graph is force-dynamic, so the next
      // visit reads the pictures this just stored.
      after(() => illustrateQuietly(session.userId))
    }

    revalidatePath(`/review/${runId}`)
    revalidatePath('/chapitres')
    revalidatePath('/graph')

    return { ok: true, published: result }
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

    if (chapterNumber !== null) {
      // No revalidation on the way out: /graph is force-dynamic, so the next
      // visit reads the pictures this just stored.
      after(() => illustrateQuietly(session.userId))
    }

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
