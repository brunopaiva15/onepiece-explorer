import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { chapters, works } from './documents.ts'
import {
  reviewDecisionEnum,
  reviewStatusEnum,
  runStatusEnum,
  stepStatusEnum,
} from './enums.ts'

/**
 * A cost in cents, with the decimals it actually has.
 *
 * `integer` was the original choice and it threw on the first real invoice: a
 * step's cost is token counts times a per-million price, which is fractional by
 * construction. Rounding at the write boundary would lose sub-cent steps
 * entirely, and the cost dashboard is there to be trusted against a measured
 * estimate. `mode: 'number'` keeps every reader working with a number rather
 * than the string node-postgres returns for numeric by default.
 */
const money = (name: string) =>
  numeric(name, { precision: 14, scale: 6, mode: 'number' })

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    status: runStatusEnum('status').notNull().default('pending'),
    pipelineVersion: text('pipeline_version').notNull(),
    provider: text('provider').notNull(),
    usedBatchApi: boolean('used_batch_api').notNull().default(false),
    /** From a real countTokens() call, kept next to the observed total so the
     *  estimator can be checked against reality. */
    estimatedCostCents: money('estimated_cost_cents'),
    totalCostCents: money('total_cost_cents').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ingestion_runs_chapter_idx').on(t.chapterId),
    index('ingestion_runs_user_status_idx').on(t.userId, t.status),
  ],
)

/**
 * One row per attempt. A retry never overwrites the record of what failed,
 * and `inputHash` is what makes replaying an unchanged step free.
 */
export const ingestionSteps = pgTable(
  'ingestion_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    stepKey: text('step_key').notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    inputHash: text('input_hash'),
    outputRef: text('output_ref'),
    durationMs: integer('duration_ms'),
    costCents: money('cost_cents').notNull().default(0),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    modelId: text('model_id'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.stepKey, t.attempt),
    index('ingestion_steps_run_idx').on(t.runId, t.stepKey),
  ],
)

export const reviewItems = pgTable(
  'review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    category: text('category').notNull(),
    priority: integer('priority').notNull().default(0),
    payload: jsonb('payload').notNull(),
    proposalFingerprint: text('proposal_fingerprint').notNull(),
    /** Identity, reveals, deaths, hidden affiliations, contradictions and
     *  mystery resolutions can never be bulk-accepted. */
    requiresExplicitReview: boolean('requires_explicit_review')
      .notNull()
      .default(false),
    confidence: real('confidence').notNull().default(0),
    /**
     * What a second model answered about this card, from the wiki page.
     *
     * Null means nobody arbitrated it, which is the truth for every card
     * written before the pass existed. See `domains/review/arbitration.ts` for
     * the shape and migration 0031 for why it is stored rather than recomputed.
     */
    arbitration: jsonb('arbitration'),
    status: reviewStatusEnum('status').notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('review_items_run_idx').on(t.runId, t.status, t.priority),
    index('review_items_fingerprint_idx').on(t.userId, t.proposalFingerprint),
  ],
)

/**
 * Why human corrections survive a re-import.
 *
 * Keyed by a fingerprint of the normalised proposal plus its evidence anchors,
 * not by row id — so re-processing the same chapter produces the same key and
 * the decision is re-applied automatically.
 */
export const reviewDecisions = pgTable(
  'review_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    workId: uuid('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    proposalFingerprint: text('proposal_fingerprint').notNull(),
    decision: reviewDecisionEnum('decision').notNull(),
    correctedPayload: jsonb('corrected_payload'),
    comment: text('comment'),
    decidedAt: timestamp('decided_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.userId, t.workId, t.proposalFingerprint)],
)

/**
 * Where a proposal goes when it cannot be anchored to real evidence — the
 * mechanism that stops the model answering from what it already knows about
 * One Piece rather than from the imported pages (ADR 0003).
 */
export const quarantine = pgTable(
  'quarantine',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').references(() => ingestionRuns.id, {
      onDelete: 'cascade',
    }),
    chapterId: uuid('chapter_id').references(() => chapters.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('quarantine_run_idx').on(t.runId),
    index('quarantine_user_idx').on(t.userId, t.createdAt),
  ],
)

/**
 * Units of work already completed inside a step.
 *
 * A step is too coarse to be the unit of progress when it costs money. One
 * extraction is twenty billed calls, and a step retried from the top pays for
 * all twenty again — which is exactly what happened, three times, on a chapter
 * estimated at thirty cents.
 */
export const runCheckpoints = pgTable(
  'run_checkpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    stepKey: text('step_key').notNull(),
    /** Whatever identifies a unit for this step. Stable across retries. */
    unitKey: text('unit_key').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('run_checkpoints_unit').on(table.runId, table.stepKey, table.unitKey),
    index('run_checkpoints_lookup').on(table.runId, table.stepKey),
  ],
)
