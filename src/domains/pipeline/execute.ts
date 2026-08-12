import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, documents, pages } from '@/db/schema/documents.ts'
import { ingestionRuns } from '@/db/schema/ingestion.ts'
import { isProviderChoice, modelProvider, type ProviderChoice } from '@/domains/ai/index.ts'
import { autoReview, autoReviewEnabled, autoReviewNote } from '@/domains/review/auto.ts'
import { runnableSteps, stepsFor, type StepKey } from './registry.ts'
import {
  inputHash,
  markRunFinished,
  markRunStarted,
  markStepRunning,
  previousSuccess,
  recordStep,
} from './runs.ts'
import type { StepContext, StepResult } from './steps/context.ts'
import { runConflicts } from './steps/conflicts.ts'
import { runDescribe } from './steps/describe.ts'
import { runEmbed } from './steps/embed.ts'
import { runExtract } from './steps/extract.ts'
import { runOcr } from './steps/ocr.ts'
import { runPanelDetect, runTextDetect } from './steps/panel-detect.ts'
import { runResolve } from './steps/resolve.ts'

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
  costCents: number
}

/**
 * The provider choice recorded on a run.
 *
 * A row written before this feature existed holds a resolved provider name
 * ('anthropic', 'local', 'synthetic') rather than a choice, so anything that is
 * not one of the three choices means "whatever is configured" — which is what
 * those runs were launched with.
 */
async function runProviderChoice(runId: string): Promise<ProviderChoice> {
  const stored = await withIngest(async (db) => {
    const [row] = await db
      .select({ provider: ingestionRuns.provider })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.id, runId))
      .limit(1)
    return row?.provider ?? null
  })

  return isProviderChoice(stored) ? stored : 'auto'
}

export async function executeRun(
  userId: string,
  chapterId: string,
  runId: string,
): Promise<ExecuteResult> {
  await markRunStarted(runId)

  let totalCostCents = 0

  try {
    const chapter = await withIngest(async (db) => {
      const [row] = await db
        .select({ number: chapters.number, sourceKind: chapters.sourceKind })
        .from(chapters)
        .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
        .limit(1)
      if (!row) throw new Error(`Chapitre introuvable : ${chapterId}`)
      return row
    })
    const chapterNumber = chapter.number

    /*
     * The model this run was launched with, not the one configured right now.
     *
     * Read from the run row rather than the environment so that a run keeps the
     * choice it was started under even if the worker restarts, and so two runs
     * of the same chapter can legitimately use different models — which is the
     * only way to find out whether a cheaper one is good enough at a given step.
     */
    const context: StepContext = {
      userId,
      chapterId,
      chapterNumber,
      runId,
      sourceKind: chapter.sourceKind,
      provider: modelProvider(await runProviderChoice(runId)),
    }

    for (const step of runnableSteps(chapter.sourceKind)) {
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
        const result = await runStep(step.key, context)
        totalCostCents += result.costCents ?? 0

        await recordStep(runId, userId, step.key, hash, {
          status: result.status ?? 'succeeded',
          durationMs: Date.now() - started,
          note: result.note,
          ...(result.costCents === undefined ? {} : { costCents: result.costCents }),
          ...(result.tokensIn === undefined ? {} : { tokensIn: result.tokensIn }),
          ...(result.tokensOut === undefined ? {} : { tokensOut: result.tokensOut }),
          ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await recordStep(runId, userId, step.key, hash, {
          status: 'failed',
          durationMs: Date.now() - started,
          error: message,
        })
        await recordRunCost(runId, totalCostCents)
        await markRunFinished(runId, { status: 'failed', error: message })
        return { status: 'failed', error: message, costCents: totalCostCents }
      }
    }

    for (const step of stepsFor(chapter.sourceKind).filter((s) => !s.implemented)) {
      await recordStep(runId, userId, step.key, null, {
        status: 'skipped',
        durationMs: 0,
        note: 'Étape déclarée, pas encore implémentée.',
      })
    }

    await recordRunCost(runId, totalCostCents)
    await markRunFinished(runId, { status: 'succeeded' })
    return { status: 'succeeded', costCents: totalCostCents }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordRunCost(runId, totalCostCents)
    await markRunFinished(runId, { status: 'failed', error: message })
    return { status: 'failed', error: message, costCents: totalCostCents }
  }
}

/**
 * Decide what does not need a person, and open the chapter if nothing is left.
 *
 * A step rather than a hook on the run's end, so it appears in the progress
 * view with its own note and its own row: an automatic publication that left no
 * trace would be the same work done invisibly, and the one thing a reviewer
 * needs to be able to check afterwards is what was accepted without them.
 */
async function runAutoPublish(context: StepContext): Promise<StepResult> {
  if (!autoReviewEnabled()) {
    return {
      note:
        'Revue manuelle : chaque proposition attend une décision. ' +
        'AUTO_REVIEW_NAMES_ONLY=1 pour ne garder que les questions de nom.',
      status: 'skipped',
    }
  }

  const result = await autoReview(context.userId, context.runId)
  if (result.accepted === 0 && result.heldForNaming === 0 && result.deferred === 0) {
    return { note: 'Aucune proposition en attente.', status: 'skipped' }
  }
  return { note: autoReviewNote(result) }
}

async function runStep(key: StepKey, context: StepContext): Promise<StepResult> {
  switch (key) {
    case 'panel_detect': {
      const result = await runPanelDetect(context.userId, context.chapterId)
      const warning =
        result.lowConfidencePages > 0
          ? ` · ${result.lowConfidencePages} page(s) à vérifier`
          : ''
      return {
        note: `${result.panelsCreated} cases sur ${result.pagesProcessed} pages${warning}`,
      }
    }

    case 'text_detect': {
      const result = await runTextDetect(context.userId, context.chapterId)
      if (result.blocks === 0) {
        return { note: 'Aucun bloc de texte — la transcription reste à faire.' }
      }
      const orphans =
        result.unassigned > 0
          ? ` · ${result.unassigned} hors case (titre, pagination, mentions)`
          : ''
      return {
        note: `${result.assigned}/${result.blocks} blocs rattachés à une case${orphans}`,
      }
    }

    case 'ocr':
      return runOcr(context)

    case 'panel_describe':
      return runDescribe(context)

    case 'extract_candidates':
      return runExtract(context)

    case 'resolve_entities':
      return runResolve(context)

    case 'detect_conflicts':
      return runConflicts(context)

    case 'embed':
      return runEmbed(context)

    case 'auto_publish':
      return runAutoPublish(context)

    default:
      throw new Error(`Étape non implémentée : ${key}`)
  }
}

/**
 * The run's real cost, accumulated from what the provider actually reported.
 *
 * Kept next to the pre-launch estimate rather than replacing it, so the
 * estimator can be checked against reality. An estimate nobody compares to the
 * outcome is decoration.
 */
async function recordRunCost(runId: string, costCents: number): Promise<void> {
  if (costCents <= 0) return
  await withIngest(async (db) => {
    await db
      .update(ingestionRuns)
      .set({ totalCostCents: Math.round(costCents) })
      .where(eq(ingestionRuns.id, runId))
  })
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

    /*
     * The model steps deliberately return null: always re-run.
     *
     * Their output depends on the prompt version, the model id, and — for
     * extraction — on which entities were already validated when the run
     * started, none of which are in the page fingerprint. A hash that missed
     * any of those would reuse a stale result after a prompt fix, which is the
     * one kind of caching bug that is invisible: the run reports success and
     * silently reproduces the behaviour the fix was meant to change.
     *
     * The per-step cost is recorded, so the price of this choice is visible
     * rather than hidden. Narrowing it is a later optimisation with a real
     * correctness argument attached, not a default.
     */
    default:
      return null
  }
}

/** Total spent on a chapter across every run. For the cost dashboard. */
export async function chapterCostCents(
  userId: string,
  chapterId: string,
): Promise<number> {
  return withIngest(async (db) => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(total_cost_cents), 0)::int` })
      .from(ingestionRuns)
      .where(
        and(eq(ingestionRuns.chapterId, chapterId), eq(ingestionRuns.userId, userId)),
      )
    return row?.total ?? 0
  })
}
