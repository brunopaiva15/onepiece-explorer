/**
 * What a claim is worth, in one word and one colour.
 *
 * Six statuses, each meaning exactly one thing, and the rule the stylesheet
 * states for them: a colour is never alone — it is always paired with the word.
 * A reader who cannot tell teal from purple must still be able to tell an
 * affirmation from a deduction.
 *
 * Written out three times across the interface before it lived here — the
 * fiche, the relations table, the review board — which is the usual way a
 * seventh status ends up displayed as `probably_true` on one page out of three.
 */

const LABELS: Record<string, string> = {
  explicit: 'affirmé',
  inferred_strong: 'déduit',
  hypothetical: 'hypothèse',
  contradicted: 'contredit',
  refuted: 'réfuté',
  user_validated: 'validé par vous',
}

const COLOURS: Record<string, string> = {
  explicit: 'var(--epi-explicit)',
  inferred_strong: 'var(--epi-inferred)',
  hypothetical: 'var(--epi-hypothetical)',
  contradicted: 'var(--epi-contradicted)',
  refuted: 'var(--epi-refuted)',
  user_validated: 'var(--epi-validated)',
}

export function epistemicLabel(status: string): string {
  return LABELS[status] ?? status
}

export function epistemicColour(status: string): string {
  return COLOURS[status] ?? 'var(--text-muted)'
}
