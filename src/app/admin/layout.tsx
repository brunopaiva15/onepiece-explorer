import type { Metadata } from 'next'
import { ChainWatcher } from './chain-watcher.tsx'

/**
 * Everything under `/admin` is the workshop.
 *
 * The layout is where the metadata belongs — the public site is meant to be
 * indexed and the workshop is not, and declaring it once on the segment is what
 * keeps that true for a route somebody adds next month without thinking about
 * robots at all.
 *
 * And it is where the lot watcher belongs, for the same kind of reason: a batch
 * that publishes itself needs someone to pick the queue up when an invocation's
 * window is spent, and pinning that to the import page pinned it to the one page
 * nobody stays on. Any page of the workshop now does it, and none of them has to
 * know.
 *
 * The access rule lives in `src/proxy.ts` and each page's own session call, not
 * here: a layout is not a security boundary — Next may serve a page's data
 * without re-rendering the layout around it. The watcher is not an exception —
 * everything it calls checks the session itself.
 */
export const metadata: Metadata = {
  title: { default: 'Atelier', template: '%s · Atelier' },
  robots: { index: false, follow: false, nocache: true },
}

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {children}
      <ChainWatcher />
    </>
  )
}
