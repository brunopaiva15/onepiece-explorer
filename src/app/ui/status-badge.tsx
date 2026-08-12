import { getDict } from '@/lib/i18n/server.ts'

/**
 * A chapter's state, as a badge.
 *
 * The states were rendered as their raw database values — "imported",
 * "processing", "review" — in the same grey as everything else on the row. They
 * are the single most important thing about a chapter, because they decide what
 * you can do with it, so they get a colour, a word in the reader's language,
 * and a border.
 */
const CLASS: Record<string, string> = {
  draft: 'badge-gris',
  uploaded: 'badge-gris',
  processing: 'badge-mer',
  review: 'badge-or',
  published: 'badge-vert',
  failed: 'badge-rouge',
}

export async function StatusBadge({ status }: { status: string }) {
  const dict = await getDict()
  const label = dict.common.status[status] ?? status
  const className = CLASS[status] ?? 'badge-gris'
  return <span className={`badge ${className}`}>{label}</span>
}
