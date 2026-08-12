/**
 * A chapter's state, as a badge.
 *
 * The states were rendered as their raw database values — "imported",
 * "processing", "review" — in the same grey as everything else on the row. They
 * are the single most important thing about a chapter, because they decide what
 * you can do with it, so they get a colour, a French word, and a border.
 */
const LOOK: Record<string, { label: string; className: string }> = {
  draft: { label: 'brouillon', className: 'badge-gris' },
  uploaded: { label: 'importé', className: 'badge-gris' },
  processing: { label: 'en cours', className: 'badge-mer' },
  review: { label: 'à relire', className: 'badge-or' },
  published: { label: 'publié', className: 'badge-vert' },
  failed: { label: 'échec', className: 'badge-rouge' },
}

export function StatusBadge({ status }: { status: string }) {
  const look = LOOK[status] ?? { label: status, className: 'badge-gris' }
  return <span className={`badge ${look.className}`}>{look.label}</span>
}
