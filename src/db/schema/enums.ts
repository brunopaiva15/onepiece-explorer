import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Mirrors the enums created in drizzle/0001_foundations.sql.
 *
 * The SQL is the source of truth; these declarations give Drizzle its types.
 * `tests/db/schema-parity.test.ts` asserts the two agree against the real
 * database, so a divergence fails CI rather than surfacing as a runtime cast
 * error months later.
 */

export const readingDirectionEnum = pgEnum('reading_direction', ['rtl', 'ltr'])

export const chapterStatusEnum = pgEnum('chapter_status', [
  'draft',
  'uploaded',
  'processing',
  'review',
  'published',
  'failed',
])

export const documentKindEnum = pgEnum('document_kind', [
  'pdf',
  'zip',
  'cbz',
  'images',
])

export const pageKindEnum = pgEnum('page_kind', [
  'narrative',
  'cover',
  'bonus',
  'other',
])

export const detectionSourceEnum = pgEnum('detection_source', [
  'auto',
  'model',
  'manual',
])

export const textBlockKindEnum = pgEnum('text_block_kind', [
  'bubble',
  'caption',
  'sfx',
  'sign',
  'other',
])

export const textSourceEnum = pgEnum('text_source', [
  'pdf_text',
  'tesseract',
  'model',
  'manual',
])

export const labelKindEnum = pgEnum('label_kind', [
  'placeholder',
  'alias',
  'true_name',
  'epithet',
  'translation',
])

/**
 * The distinction the interface must never blur. A fact, a machine inference
 * and a guess look the same in a database row and must never look the same on
 * screen.
 */
export const epistemicStatusEnum = pgEnum('epistemic_status', [
  'explicit',
  'inferred_strong',
  'hypothetical',
  'contradicted',
  'refuted',
  'user_validated',
])

export const reviewStatusEnum = pgEnum('review_status', [
  'proposed',
  'accepted',
  'rejected',
  'deferred',
  'superseded',
])

export const proposerEnum = pgEnum('proposer', ['ai', 'user'])

export const evidenceKindEnum = pgEnum('evidence_kind', [
  'dialogue',
  'narration',
  'image',
  'cover',
  'metadata',
  'human',
])

export const runStatusEnum = pgEnum('run_status', [
  'pending',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
])

export const stepStatusEnum = pgEnum('step_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cached',
])

export const reviewDecisionEnum = pgEnum('review_decision', [
  'accept',
  'reject',
  'correct',
  'merge',
  'split',
  'defer',
])

export const mysteryStateEnum = pgEnum('mystery_state', [
  'open',
  'partially_resolved',
  'resolved',
  'refuted',
  'reopened',
])

export const occurrenceKindEnum = pgEnum('occurrence_kind', [
  'appearance',
  'mention',
])

/** Label precedence: the highest revealed label wins at a given boundary. */
export const LABEL_PRECEDENCE = {
  placeholder: 10,
  translation: 30,
  alias: 50,
  epithet: 70,
  true_name: 100,
} as const satisfies Record<(typeof labelKindEnum.enumValues)[number], number>
