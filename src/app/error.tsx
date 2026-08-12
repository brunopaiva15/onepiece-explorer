'use client'

import Link from 'next/link'
import type { Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

/**
 * What a server error says instead of nothing.
 *
 * In production Next.js replaces the real message with a digest before it
 * reaches the browser, and rightly so — an error can carry a connection string.
 * The cost is that the default screen reads "A server error occurred", which
 * tells the one person who could fix it precisely nothing.
 *
 * This cannot recover the message, so it does not pretend to. It names the
 * failure that is overwhelmingly the most likely on a fresh deployment —
 * configuration, because every page resolves a session and every session reads
 * the configuration — and points at the one page built to answer the question
 * without depending on any of it.
 *
 * An error boundary has no server parent to hand it a locale prop, so the
 * locale is read from the `lang` attribute the root layout already sets on
 * `<html>` — the one locale-carrying thing guaranteed to be in the document.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const locale: Locale =
    typeof document !== 'undefined' && document.documentElement.lang === 'en'
      ? 'en'
      : 'fr'
  const dict = getDictFor(locale)
  const t = dict.errors

  return (
    <main id="contenu" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold text-primary">{t.pageTitle}</h1>

      <p className="mt-4 text-secondary">{t.noMessage}</p>

      <p className="mt-4 text-secondary">
        <strong className="font-medium text-primary">{t.allPagesFailLead}</strong>{' '}
        {t.allPagesFailBody}{' '}
        <Link href="/etat" className="text-accent underline">
          {t.statusPageLinkLabel}
        </Link>{' '}
        {t.allPagesFailTail}
      </p>

      <p className="mt-4 text-secondary">
        <strong className="font-medium text-primary">{t.onlyActionFailLead}</strong>{' '}
        {t.onlyActionFailBody}
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
        >
          {dict.common.retry}
        </button>
        <Link
          href="/etat"
          className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          {t.statusPageButton}
        </Link>
      </div>

      {error.digest && (
        <p className="mt-10 text-xs text-muted">
          {/* The digest is the only thing that survives to the browser, and it
              is what lets the real message be found in the host's runtime
              logs. Useless on its own; the whole key when it is not. */}
          {t.digestLead} <code className="text-secondary">{error.digest}</code>{' '}
          {t.digestTail}
        </p>
      )}
    </main>
  )
}
