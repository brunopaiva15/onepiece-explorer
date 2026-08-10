/**
 * What every step is handed, and what it reports back.
 *
 * Kept in its own module so a step can be imported without dragging in the
 * executor, and so the shape of "what a step returns" is one declaration rather
 * than a convention repeated in eight files.
 */

export interface StepContext {
  userId: string
  chapterId: string
  chapterNumber: number
  runId: string
}

export interface StepResult {
  /**
   * One line, shown in the progress view. Every step returns one, including
   * successful ones: a step that reports nothing is indistinguishable from a
   * step that did nothing.
   */
  note: string
  /** Real cost, from the provider's usage, in cents. */
  costCents?: number
  tokensIn?: number
  tokensOut?: number
  modelId?: string
  /**
   * A step may declare itself skipped. 'skipped' with a reason beats running a
   * step that cannot improve on what is already there — OCR on a chapter whose
   * PDF carried exact text is the canonical case.
   */
  status?: 'succeeded' | 'skipped'
}
