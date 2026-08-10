import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { ingestionRuns, ingestionSteps } from '@/db/schema/ingestion.ts'
import { effectiveModelProvider } from '@/lib/env.ts'
import { PIPELINE_VERSION } from '../ingestion/import.ts'
import { STEPS, stepDefinition, type StepKey } from './registry.ts'

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
): Promise<string> {
  return withIngest(async (db) => {
    const [chapter] = await db
      .select({ id: chapters.id })
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
        provider: effectiveModelProvider(),
        usedBatchApi: process.env.USE_BATCH_API !== 'false',
      })
      .returning({ id: ingestionRuns.id })

    if (!run) throw new Error('Création du run échouée.')

    await db.insert(ingestionSteps).values(
      STEPS.map((step) => ({
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
          // 'review' rather than 'published': a successful pipeline produces
          // proposals, not canon. Nothing joins the graph without a human
          // decision, so success here means "ready to be looked at".
          status: outcome.status === 'succeeded' ? 'review' : 'failed',
          updatedAt: new Date(),
        })
        .where(eq(chapters.id, run.chapterId))
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
      })
      .from(ingestionSteps)
      .where(eq(ingestionSteps.runId, runId))
      .orderBy(asc(ingestionSteps.attempt))

    // Latest attempt wins for display; earlier attempts stay in the table for
    // anyone reading the history.
    const latest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) latest.set(row.stepKey, row)

    const steps: StepSummary[] = STEPS.map((definition) => {
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
