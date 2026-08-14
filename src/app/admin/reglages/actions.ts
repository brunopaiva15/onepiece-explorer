'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import {
  deleteChapter,
  previewDeletion,
  type DeletionPreview,
  type DeletionResult,
} from '@/domains/chapters/delete.ts'
import { enrichBountyPosters, enrichEntityImages } from '@/domains/images/index.ts'
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

    revalidatePath('/admin/reglages')
    revalidatePath('/admin/chapitres')
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
  /**
   * The entities that came back without a picture, named.
   *
   * Capped — see UNMATCHED_NAMED. `unmatched` stays the true total, so the page
   * can say how many it is not showing rather than pretending the list is
   * complete.
   */
  unmatchedEntities?: Array<{ entityId: string; label: string; nodeType: string }>
  /** Of the pictures found, how many came from the wiki fallback. */
  fromWiki?: number
  /** Of the pictures found, how many the wiki dates to before the ellipse. */
  preTimeskip?: number
  /** Pictures taken away because the name that found them no longer matches. */
  dropped?: number
  failures?: number
  catalogueSize?: number
  notes?: string[]
  error?: string
}

/**
 * How many nameless-in-the-report entities get named back to the page.
 *
 * A first run on a library that was never illustrated can leave hundreds of
 * entities without a picture, and every one of them would cross the wire in the
 * action's result. Two hundred is already more than anyone reads in one sitting,
 * and the count beside the list says how many were left out — a truncated list
 * that admits it beats a complete one nobody can scroll.
 */
const UNMATCHED_NAMED = 200

/**
 * Fetch illustrations for the entities that have none.
 *
 * Rate-limited under `start_run`, not because it calls a model — it does not,
 * and it costs nothing — but because it downloads from three free community
 * services. A button that can be clicked in a loop is a button that can hammer
 * someone else's server, and being polite to them is worth one shared counter.
 *
 * `includeIllustrated` re-examines entities that already have a picture, which
 * is normally a waste and is exactly what a library illustrated before the
 * portraits carried a date needs: those rows are all `era = 'unknown'`, so a
 * reader below chapter 598 is still being served whatever artwork was found
 * first. Nothing is replaced — the new pictures are added beside the old ones
 * and the boundary chooses between them.
 *
 * `recheck` is the one that does take something away, and it is the only way a
 * correction to the matching rules ever reaches a library already illustrated.
 * It puts the rapprochements made on a resemblance back through today's rules,
 * forgets the pictures they no longer justify, and — in the same run, because
 * an entity that just lost its picture is an entity without one — looks again.
 */
export async function enrichImagesAction(
  options: { includeIllustrated?: boolean; recheck?: boolean } = {},
): Promise<EnrichImagesResult> {
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

    const report = await enrichEntityImages(session.userId, {
      includeIllustrated: options.includeIllustrated ?? false,
      recheck: options.recheck ?? false,
    })

    const notes = [
      ...(report.cacheNote ? [report.cacheNote] : []),
      ...report.catalogueFailures.map(
        (failure) => `${failure.source} injoignable : ${failure.reason}`,
      ),
      ...report.failures
        .slice(0, 5)
        .map((failure) => `« ${failure.label} » : ${failure.reason}`),
    ]

    revalidatePath('/admin/reglages')
    revalidatePath('/graph')
    revalidatePath('/graph/table')

    return {
      ok: true,
      considered: report.considered,
      stored: report.stored,
      unmatched: report.unmatched,
      unmatchedEntities: report.unmatchedEntities.slice(0, UNMATCHED_NAMED),
      fromWiki: report.fromWiki,
      preTimeskip: report.preTimeskip,
      dropped: report.dropped,
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

export interface EnrichPostersResult {
  ok: boolean
  considered?: number
  resolved?: number
  stored?: number
  skipped?: number
  unresolved?: string[]
  failures?: string[]
  error?: string
}

/** How many unresolved printings the panel names before it stops listing them. */
const UNRESOLVED_NAMED = 8

/**
 * Rapatrier les avis de recherche.
 *
 * Separate from the illustration button beside it because it is a different
 * question with a different answer: that one asks three catalogues « do you
 * have a picture of this name », this one walks a hand-written list of bounties
 * and fetches the poster of each printing, dated by the chapter that shows it.
 *
 * Rate-limited like the enrichment, and for the same reason: it is a loop of
 * requests to somebody else's free server, and the limit is there to catch a
 * script or a tab that replays it, not an intruder.
 */
export async function enrichPostersAction(): Promise<EnrichPostersResult> {
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

    const report = await enrichBountyPosters(session.userId)

    revalidatePath('/admin/reglages')
    revalidatePath('/')

    return {
      ok: true,
      considered: report.considered,
      resolved: report.resolved,
      stored: report.stored,
      skipped: report.skipped,
      unresolved: report.unresolved.slice(0, UNRESOLVED_NAMED),
      failures: report.failures.map((failure) => `${failure.what} : ${failure.reason}`).slice(0, 5),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Récupération impossible.',
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
      revalidatePath('/admin/reglages')
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
