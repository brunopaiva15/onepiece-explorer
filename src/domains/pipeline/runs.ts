import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, ne } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { ingestionRuns, ingestionSteps, runCheckpoints } from '@/db/schema/ingestion.ts'
import type { ProviderChoice } from '@/domains/ai/index.ts'
import { PIPELINE_VERSION } from '../ingestion/import.ts'
import { stepsFor, stepDefinition, type StepKey } from './registry.ts'

/**
 * Runs and steps: the record of what the pipeline did.
 *
 * `ingestion_steps` holds one row per attempt, never overwritten. A retry that
 * replaced the failed row would erase the only evidence of what went wrong,
 * which is precisely what someone debugging a bad import needs. `input_hash`
 * is what makes replaying an unchanged step free: if the inputs match a
 * previous success, the step is skipped rather than recomputed — and for the
 * model steps that is the difference between a free retry and paying twice.
 */

/** Derived from the enums so a new state cannot silently fall out of the view. */
export type RunStatus = (typeof ingestionRuns.status.enumValues)[number]
export type StepStatus = (typeof ingestionSteps.status.enumValues)[number]

export interface RunSummary {
  id: string
  chapterId: string
  chapterNumber: number
  status: RunStatus
  pipelineVersion: string
  provider: string
  totalCostCents: number
  error: string | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

export interface StepSummary {
  key: string
  label: string
  detail: string
  usesModel: boolean
  implemented: boolean
  status: StepStatus
  attempt: number
  durationMs: number | null
  costCents: number
  error: string | null
  /** Why a step was skipped, when it was. */
  note: string | null
  /*
   * What it actually cost, in the units that explain the bill and the wait.
   *
   * Recorded since the first version of this table and shown nowhere, which is
   * how "why is extraction slow" became a question nobody could answer from the
   * screen: output tokens are the wait, and they were sitting in a column.
   */
  tokensIn: number | null
  tokensOut: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  modelId: string | null
  /** Null means "always re-run"; a value means this step can be reused. */
  inputHash: string | null
  startedAt: Date | null
  finishedAt: Date | null
  /**
   * Units of work already bought inside this step.
   *
   * The only progress signal that exists *during* a step: tokens and duration
   * are written when a step ends, so a three-minute extraction shows nothing
   * moving and cannot be told apart from a dead one. Checkpoints are written
   * per slice as each returns, and were already being recorded — they just had
   * nowhere to appear.
   */
  unitsDone: number
}

export interface RunView {
  run: RunSummary
  steps: StepSummary[]
}

/**
 * Open a run and lay out its steps as pending rows.
 *
 * Creating the step rows up front rather than as each one starts is what lets
 * the progress view show the whole pipeline immediately. A view that grows a
 * row at a time cannot tell the user how much is left.
 */
export async function createRun(
  userId: string,
  chapterId: string,
  /**
   * Which model to use, chosen at launch.
   *
   * Stored on the run rather than read from the environment when each step
   * runs: a run has to keep the choice it was started under, and two runs of
   * the same chapter are allowed to differ. That is what makes "is the cheaper
   * model good enough here" an answerable question rather than an opinion.
   */
  provider: ProviderChoice = 'auto',
): Promise<string> {
  return withIngest(async (db) => {
    const [chapter] = await db
      .select({ id: chapters.id, sourceKind: chapters.sourceKind })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)

    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const [run] = await db
      .insert(ingestionRuns)
      .values({
        chapterId,
        userId,
        status: 'pending',
        pipelineVersion: PIPELINE_VERSION,
        provider,
        usedBatchApi: process.env.USE_BATCH_API !== 'false',
      })
      .returning({ id: ingestionRuns.id })

    if (!run) throw new Error('Création du run échouée.')

    await db.insert(ingestionSteps).values(
      stepsFor(chapter.sourceKind).map((step) => ({
        runId: run.id,
        userId,
        stepKey: step.key,
        status: 'pending' as const,
        attempt: 1,
      })),
    )

    await db
      .update(chapters)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(chapters.id, chapterId))

    return run.id
  })
}

/**
 * Erase a run that never became work.
 *
 * Only for the case where the pipeline could not be scheduled at all. Nothing
 * ran, so there is no history to preserve, and leaving the row would put a run
 * in the list that is permanently `pending`: indistinguishable, to the reader,
 * from one that is about to start.
 *
 * The chapter's own status is left alone on purpose: if it says `processing`,
 * it is because another run really is processing it.
 */
export async function discardRun(runId: string): Promise<void> {
  await withIngest(async (db) => {
    await db.delete(ingestionSteps).where(eq(ingestionSteps.runId, runId))
    await db.delete(ingestionRuns).where(eq(ingestionRuns.id, runId))
  })
}

/**
 * Units of work already bought, so a retry does not buy them again.
 *
 * A step is the wrong unit of progress once a step costs money. Extraction is
 * twenty billed calls; a step retried from the top pays for all twenty a second
 * time, and on an unstable connection that happened three times in one evening
 * on a chapter estimated at thirty cents.
 *
 * The key is the step's business: for extraction it is a hash of the panel refs
 * in a slice, which is stable across retries and changes the instant the input
 * does — so a genuine reprocessing still redoes the work, and only a retry of
 * the identical work is skipped.
 */
export async function completedUnits(
  runId: string,
  stepKey: string,
): Promise<Map<string, string | null>> {
  return withIngest(async (db) => {
    const rows = await db
      .select({ unitKey: runCheckpoints.unitKey, detail: runCheckpoints.detail })
      .from(runCheckpoints)
      .where(and(eq(runCheckpoints.runId, runId), eq(runCheckpoints.stepKey, stepKey)))
    return new Map(rows.map((row) => [row.unitKey, row.detail]))
  })
}

export async function recordUnit(
  runId: string,
  userId: string,
  stepKey: string,
  unitKey: string,
  detail?: string,
): Promise<void> {
  await withIngest(async (db) => {
    await db
      .insert(runCheckpoints)
      .values({ runId, userId, stepKey, unitKey, detail: detail ?? null })
      // Recording the same unit twice is a retry behaving correctly.
      .onConflictDoNothing()
  })
}

export async function markRunStarted(runId: string): Promise<void> {
  await withIngest(async (db) => {
    await db
      .update(ingestionRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(ingestionRuns.id, runId))
  })
}

export async function markRunFinished(
  runId: string,
  outcome: { status: 'succeeded' | 'failed' | 'cancelled'; error?: string },
): Promise<void> {
  await withIngest(async (db) => {
    const [run] = await db
      .update(ingestionRuns)
      .set({
        status: outcome.status,
        error: outcome.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(ingestionRuns.id, runId))
      .returning({ chapterId: ingestionRuns.chapterId })

    if (run) {
      await db
        .update(chapters)
        .set({
          // 'review' rather than 'published': a pipeline produces proposals,
          // not canon. Success here means "ready to be looked at".
          status: outcome.status === 'succeeded' ? 'review' : 'failed',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chapters.id, run.chapterId),
            /*
             * Never take an opened chapter back.
             *
             * The last step of a run can finish its review and publish it, and
             * this line ran afterwards — putting it back to 'review' and
             * dropping the reader's boundary below it, so the facts published
             * seconds earlier disappeared again. Re-processing a published
             * chapter is the same case: its new proposals wait in the queue,
             * and what was already read stays readable.
             */
            ne(chapters.status, 'published'),
          ),
        )
    }
  })
}

export interface StepOutcome {
  status: 'succeeded' | 'failed' | 'skipped' | 'cached'
  durationMs: number
  costCents?: number
  tokensIn?: number
  tokensOut?: number
  modelId?: string
  error?: string
  /** Stored in outputRef; carries the "skipped because…" explanation. */
  note?: string
  outputRef?: string
}

/**
 * Record the result of a step attempt.
 *
 * The first attempt updates the row laid out by createRun; a retry inserts a
 * new row with the next attempt number, so the failure history survives.
 */
export async function recordStep(
  runId: string,
  userId: string,
  stepKey: StepKey,
  inputHash: string | null,
  outcome: StepOutcome,
): Promise<void> {
  await withIngest(async (db) => {
    const existing = await db
      .select({ id: ingestionSteps.id, status: ingestionSteps.status, attempt: ingestionSteps.attempt })
      .from(ingestionSteps)
      .where(and(eq(ingestionSteps.runId, runId), eq(ingestionSteps.stepKey, stepKey)))
      .orderBy(desc(ingestionSteps.attempt))

    const values = {
      status: outcome.status,
      inputHash,
      outputRef: outcome.note ?? outcome.outputRef ?? null,
      durationMs: outcome.durationMs,
      costCents: outcome.costCents ?? 0,
      tokensIn: outcome.tokensIn ?? null,
      tokensOut: outcome.tokensOut ?? null,
      modelId: outcome.modelId ?? null,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    }

    const latest = existing[0]
    if (latest && latest.status === 'pending') {
      await db.update(ingestionSteps).set(values).where(eq(ingestionSteps.id, latest.id))
      return
    }

    await db.insert(ingestionSteps).values({
      runId,
      userId,
      stepKey,
      attempt: (latest?.attempt ?? 0) + 1,
      startedAt: new Date(Date.now() - outcome.durationMs),
      ...values,
    })
  })
}

export async function markStepRunning(runId: string, stepKey: StepKey): Promise<void> {
  await withIngest(async (db) => {
    await db
      .update(ingestionSteps)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(ingestionSteps.runId, runId), eq(ingestionSteps.stepKey, stepKey)))
  })
}

/**
 * Has this exact step already succeeded on these exact inputs?
 *
 * The whole point of `input_hash`. Re-running a chapter after fixing one page
 * should not re-pay for the nine steps that did not change.
 */
export async function previousSuccess(
  userId: string,
  stepKey: StepKey,
  inputHash: string,
): Promise<boolean> {
  return withIngest(async (db) => {
    const [row] = await db
      .select({ id: ingestionSteps.id })
      .from(ingestionSteps)
      .where(
        and(
          eq(ingestionSteps.userId, userId),
          eq(ingestionSteps.stepKey, stepKey),
          eq(ingestionSteps.inputHash, inputHash),
          eq(ingestionSteps.status, 'succeeded'),
        ),
      )
      .limit(1)
    return row !== undefined
  })
}

/** Stable hash of whatever a step's result depends on. */
export function inputHash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * The run as the progress view needs it.
 *
 * Read through withIngest and filtered on the verified userId: a run is
 * metadata about processing, not narrative content, and it must remain visible
 * while the chapter it processes sits beyond the reader's boundary — otherwise
 * importing a chapter would hide its own progress bar.
 */
export async function getRun(userId: string, runId: string): Promise<RunView | null> {
  return withIngest(async (db) => {
    const [run] = await db
      .select({
        id: ingestionRuns.id,
        chapterId: ingestionRuns.chapterId,
        chapterNumber: chapters.number,
        sourceKind: chapters.sourceKind,
        status: ingestionRuns.status,
        pipelineVersion: ingestionRuns.pipelineVersion,
        provider: ingestionRuns.provider,
        totalCostCents: ingestionRuns.totalCostCents,
        error: ingestionRuns.error,
        startedAt: ingestionRuns.startedAt,
        finishedAt: ingestionRuns.finishedAt,
        createdAt: ingestionRuns.createdAt,
      })
      .from(ingestionRuns)
      .innerJoin(chapters, eq(chapters.id, ingestionRuns.chapterId))
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.userId, userId)))
      .limit(1)

    if (!run) return null

    const rows = await db
      .select({
        stepKey: ingestionSteps.stepKey,
        status: ingestionSteps.status,
        attempt: ingestionSteps.attempt,
        durationMs: ingestionSteps.durationMs,
        costCents: ingestionSteps.costCents,
        error: ingestionSteps.error,
        outputRef: ingestionSteps.outputRef,
        tokensIn: ingestionSteps.tokensIn,
        tokensOut: ingestionSteps.tokensOut,
        cacheReadTokens: ingestionSteps.cacheReadTokens,
        cacheWriteTokens: ingestionSteps.cacheWriteTokens,
        modelId: ingestionSteps.modelId,
        inputHash: ingestionSteps.inputHash,
        stepStartedAt: ingestionSteps.startedAt,
        stepFinishedAt: ingestionSteps.finishedAt,
      })
      .from(ingestionSteps)
      .where(eq(ingestionSteps.runId, runId))
      .orderBy(asc(ingestionSteps.attempt))

    const checkpoints = await db
      .select({ stepKey: runCheckpoints.stepKey })
      .from(runCheckpoints)
      .where(eq(runCheckpoints.runId, runId))

    const unitsByStep = new Map<string, number>()
    for (const row of checkpoints) {
      unitsByStep.set(row.stepKey, (unitsByStep.get(row.stepKey) ?? 0) + 1)
    }

    // Latest attempt wins for display; earlier attempts stay in the table for
    // anyone reading the history.
    const latest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) latest.set(row.stepKey, row)

    const steps: StepSummary[] = stepsFor(run.sourceKind).map((definition) => {
      const row = latest.get(definition.key)
      return {
        key: definition.key,
        label: definition.label,
        detail: definition.detail,
        usesModel: definition.usesModel,
        implemented: definition.implemented,
        status: row?.status ?? 'pending',
        attempt: row?.attempt ?? 1,
        durationMs: row?.durationMs ?? null,
        costCents: row?.costCents ?? 0,
        error: row?.error ?? null,
        note: row?.outputRef ?? null,
        tokensIn: row?.tokensIn ?? null,
        tokensOut: row?.tokensOut ?? null,
        cacheReadTokens: row?.cacheReadTokens ?? null,
        cacheWriteTokens: row?.cacheWriteTokens ?? null,
        modelId: row?.modelId ?? null,
        inputHash: row?.inputHash ?? null,
        startedAt: row?.stepStartedAt ?? null,
        finishedAt: row?.stepFinishedAt ?? null,
        unitsDone: unitsByStep.get(definition.key) ?? 0,
      }
    })

    return { run, steps }
  })
}

/** Most recent run for a chapter, if any. */
export async function latestRunForChapter(
  userId: string,
  chapterId: string,
): Promise<string | null> {
  return withIngest(async (db) => {
    const [row] = await db
      .select({ id: ingestionRuns.id })
      .from(ingestionRuns)
      .where(and(eq(ingestionRuns.chapterId, chapterId), eq(ingestionRuns.userId, userId)))
      .orderBy(desc(ingestionRuns.createdAt))
      .limit(1)
    return row?.id ?? null
  })
}

export function stepLabel(key: string): string {
  return stepDefinition(key)?.label ?? key
}
