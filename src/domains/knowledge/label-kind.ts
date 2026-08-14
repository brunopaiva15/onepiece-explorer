import type { labelKindEnum } from '@/db/schema/enums.ts'

/**
 * What kind of name a label is, in French.
 *
 * A plain table rather than a query, for the same reason `predicateLabel()` is
 * one: a client component can call this. The rename form on a fiche needs to
 * offer the five kinds and the fiche needs to print them, and the words living
 * in two files is how they drift apart.
 *
 * The order is the order they outrank each other — `LABEL_PRECEDENCE` in the
 * schema holds the numbers, and this holds the reading. A true name beats an
 * epithet beats a surname beats a translation beats a provisional designation,
 * which is why a placeholder disappears from the display the moment anything
 * better is revealed while remaining in the table for the boundary that only
 * knew that.
 *
 * `import type` on the enum: the values are a compile-time check that no kind
 * is forgotten here, and erasing the import keeps drizzle — and the schema it
 * describes — out of any client bundle that renders one of these words.
 */

export type LabelKind = (typeof labelKindEnum.enumValues)[number]

export const LABEL_KINDS: ReadonlyArray<{ kind: LabelKind; label: string }> = [
  { kind: 'true_name', label: 'vrai nom' },
  { kind: 'epithet', label: 'épithète' },
  { kind: 'alias', label: 'surnom' },
  { kind: 'translation', label: 'traduction' },
  { kind: 'placeholder', label: 'désignation provisoire' },
]

/** An unknown kind is shown as it is stored, never as an invented word. */
export function labelKindLabel(kind: string): string {
  return LABEL_KINDS.find((entry) => entry.kind === kind)?.label ?? kind
}

/**
 * When a name became readable, in one phrase.
 *
 * Here rather than in each view for the same reason the kinds are: the fiche
 * and the rename form print it side by side, and « ch. null » is what the two
 * of them say the day one of them forgets that a name can have no chapter at
 * all. Migration 0026 has the why; this is the wording.
 */
export function revealedAtLabel(revealedInChapter: number | null): string {
  return revealedInChapter === null
    ? 'hors chronologie'
    : `révélé ch. ${revealedInChapter}`
}
