'use client'

import Link from 'next/link'

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
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main id="contenu" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold text-primary">
        Cette page n&apos;a pas pu être rendue
      </h1>

      <p className="mt-4 text-secondary">
        Si toutes les pages échouent, la cause est presque toujours la même :
        chacune résout une session, et une session lit la configuration puis
        ouvre une connexion à la base. Une seule variable manquante suffit à
        faire tomber le site entier.
      </p>

      <p className="mt-4 text-secondary">
        <Link href="/etat" className="text-accent underline">
          Ouvrez l&apos;état du déploiement
        </Link>{' '}
        — cette page-là ne dépend de rien de ce qu&apos;elle contrôle, donc elle
        répond même maintenant, et elle dit laquelle manque.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
        >
          Réessayer
        </button>
        <Link
          href="/etat"
          className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          État du déploiement
        </Link>
      </div>

      {error.digest && (
        <p className="mt-10 text-xs text-muted">
          {/* The digest is the only thing that survives to the browser, and it
              is what lets the real message be found in the host's runtime
              logs. Useless on its own; the whole key when it is not. */}
          Référence : <code className="text-secondary">{error.digest}</code> — à
          chercher dans les journaux d&apos;exécution de l&apos;hébergeur, où le
          message complet est conservé.
        </p>
      )}
    </main>
  )
}
