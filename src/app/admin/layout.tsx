import type { Metadata } from 'next'

/**
 * Everything under `/admin` is the workshop.
 *
 * The layout adds nothing visual — the shell is already the frame. It exists
 * for the metadata: the public site is meant to be indexed, and the workshop is
 * not. Declaring it once on the segment is what keeps that true for a route
 * somebody adds next month without thinking about robots at all.
 *
 * The access rule lives in `src/proxy.ts` and each page's own session call, not
 * here: a layout is not a security boundary — Next may serve a page's data
 * without re-rendering the layout around it.
 */
export const metadata: Metadata = {
  title: { default: 'Atelier', template: '%s · Atelier' },
  robots: { index: false, follow: false, nocache: true },
}

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children
}
