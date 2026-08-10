import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { documents, pages } from '@/db/schema/documents.ts'
import { RUNNABLE_STEPS, STEPS, type StepKey } from './registry.ts'
import {
  inputHash,
  markRunFinished,
  markRunStarted,
  markStepRunning,
  previousSuccess,
  recordStep,
} from './runs.ts'
import { runPanelDetect, runTextDetect } from './steps/panel-detect.ts'

/**
 * Run the pipeline for one chapter.
 *
 * Steps execute in declaration order and the run stops at the first failure,
 * because every later step consumes the output of an earlier one — continuing
 * past a broken panel detection would produce descriptions of boxes that are
 * wrong, at full price.
 *
 * Steps that are declared but not yet built are recorded as skipped with the
 * reason, rather than left pending. A pending step in a finished run reads as
 * "something got stuck"; "not yet implemented" is the truth and takes the same
 * amount of space to say.
 */

export interface ExecuteResult {
  status: 'succeeded' | 'failed'
  error?: string
}

export async function executeRun(
  userId: string,
  chapterId: string,
  runId: string,
): Promise<ExecuteResult> {
  await markRunStarted(runId)

  try {
    for (const step of RUNNABLE_STEPS) {
      const hash = await hashInputsFor(step.key, userId, chapterId)

      /*
       * Skip a step that already succeeded on exactly these inputs.
       *
       * This is what makes re-running a chapter after correcting one page
       * cheap. It is also why the hash has to cover everything the step reads:
       * a hash that missed the page list would silently reuse a stale result.
       */
      if (hash && (await previousSuccess(userId, step.key, hash))) {
        // 'cached', not 'skipped'. The two mean different things to whoever
        // reads the run later: cached is "already computed, reused", skipped is
        // "deliberately not run". Collapsing them would make a free retry
        // indistinguishable from a step that never happened.
        await recordStep(runId, userId, step.key, hash, {
          status: 'cached',
          durationMs: 0,
          note: 'Entrées identiques à une exécution réussie — résultat réutilisé.',
        })
        continue
      }

      await markStepRunning(runId, step.key)
      const started = Date.now()

      try {
        const note = await runStep(step.key, userId, chapterId)
        await recordStep(runId, userId, step.key, hash, {
          status: 'succeeded',
          durationMs: Date.now() - started,
          note,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await recordStep(runId, userId, step.key, hash, {
          status: 'failed',
          durationMs: Date.now() - started,
          error: message,
        })
        await markRunFinished(runId, { status: 'failed', error: message })
        return { status: 'failed', error: message }
      }
    }

    for (const step of STEPS.filter((s) => !s.implemented)) {
      await recordStep(runId, userId, step.key, null, {
        status: 'skipped',
        durationMs: 0,
        note: 'Étape déclarée, pas encore implémentée (phase 2).',
      })
    }

    await markRunFinished(runId, { status: 'succeeded' })
    return { status: 'succeeded' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markRunFinished(runId, { status: 'failed', error: message })
    return { status: 'failed', error: message }
  }
}

async function runStep(
  key: StepKey,
  userId: string,
  chapterId: string,
): Promise<string> {
  switch (key) {
    case 'panel_detect': {
      const result = await runPanelDetect(userId, chapterId)
      const warning =
        result.lowConfidencePages > 0
          ? ` · ${result.lowConfidencePages} page(s) à vérifier`
          : ''
      return `${result.panelsCreated} cases sur ${result.pagesProcessed} pages${warning}`
    }

    case 'text_detect': {
      const result = await runTextDetect(userId, chapterId)
      if (result.blocks === 0) {
        return 'Aucun bloc de texte — la transcription reste à faire.'
      }
      const orphans =
        result.unassigned > 0
          ? ` · ${result.unassigned} hors case (titre, pagination, mentions)`
          : ''
      return `${result.assigned}/${result.blocks} blocs rattachés à une case${orphans}`
    }

    default: {
      throw new Error(`Étape non implémentée : ${key}`)
    }
  }
}

/**
 * What a step's result depends on.
 *
 * Deliberately explicit per step rather than a generic "hash the chapter":
 * a coarse hash makes every step re-run whenever anything changes, which
 * defeats the purpose, and a hash that is too narrow reuses a stale result.
 * Returning null means "always re-run" — the safe answer for a step whose
 * inputs are not fully enumerated yet.
 */
async function hashInputsFor(
  key: StepKey,
  userId: string,
  chapterId: string,
): Promise<string | null> {
  const fingerprint = await withIngest(async (db) => {
    const rows = await db
      .select({
        id: pages.id,
        index: pages.index,
        phash: pages.phash,
        excluded: pages.excluded,
        rotation: pages.rotation,
      })
      .from(pages)
      .where(and(eq(pages.chapterId, chapterId), eq(pages.userId, userId)))
      .orderBy(pages.index)

    const [doc] = await db
      .select({ sha: documents.sha256 })
      .from(documents)
      .where(eq(documents.chapterId, chapterId))
      .limit(1)

    return { pages: rows, source: doc?.sha ?? null }
  })

  switch (key) {
    // Panel detection reads the page images and the reading direction, and
    // nothing else. Perceptual hashes stand in for the pixels.
    case 'panel_detect':
      return inputHash(['panel_detect', fingerprint])

    // Text assignment depends on the panels, which depend on the same inputs,
    // plus whatever text extraction produced. Both are covered by the page
    // fingerprint and the source hash.
    case 'text_detect':
      return inputHash(['text_detect', fingerprint])

    default:
      return null
  }
}
