import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import {
  ingestionLimits,
  transportLimitIsHostImposed,
  uploadTransportLimitBytes,
} from '@/domains/ingestion/limits.ts'
import { ImportForm } from './import-form.tsx'

export const metadata: Metadata = { title: 'Importer un chapitre' }
/**
 * Per-user and cookie-dependent: never prerendered, and never in a shared
 * cache. Signed asset URLs expire within the minute, so a cached render would
 * hand a later request a page of dead links.
 */
export const dynamic = 'force-dynamic'


export default async function ImportPage() {
  const session = await getReaderSession()
  const existing = await listChapters(session.userId, session.workId)
  const limits = ingestionLimits()

  const highest = existing.reduce((max, c) => Math.max(max, c.number), 0)
  const suggested = existing.length === 0 ? 1 : highest + 1
  const direction = existing.at(-1)?.readingDirection ?? 'rtl'

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-16">
      <nav className="text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal d&apos;exploration
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">
        Importer un chapitre
      </h1>
      <p className="mt-4 text-secondary">
        Un chapitre à la fois, dans votre ordre de lecture. Le numéro fixe la
        date de révélation de tout ce que ce chapitre apprend : c&apos;est lui
        qui décide, plus tard, de ce qui reste caché derrière le curseur.
      </p>

      {transportLimitIsHostImposed() && (
        <div
          role="note"
          className="mt-6 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4 text-sm"
        >
          <p className="text-primary">
            <strong className="font-medium">
              Cet hébergeur ne peut pas recevoir un chapitre.
            </strong>{' '}
            Le corps d&apos;une requête y est plafonné à 4,5 Mo par la
            plate-forme — pas par un réglage — et un chapitre fait dix à cent
            fois cela.
          </p>
          <p className="mt-2 text-secondary">
            Le reste du site fonctionne : lire, chercher, explorer le graphe. Pour
            importer, deux voies — lancer l&apos;application sur une machine à
            vous, qui écrira dans la même base ; ou faire passer l&apos;envoi
            directement du navigateur au stockage, sans traverser de fonction.
            La seconde est la vraie correction, et elle reste à écrire.
          </p>
        </div>
      )}

      <ImportForm
        suggestedNumber={suggested}
        defaultDirection={direction}
        /*
         * The transport limit, not the ingestion one.
         *
         * What the pipeline will accept is irrelevant if the bytes cannot reach
         * it. Showing the larger number let the form accept a file the request
         * could not carry, and the Server Action then failed without a message
         * Next passes on — which is how an import produced a bare error page.
         */
        maxUploadMb={Math.round(uploadTransportLimitBytes() / 1_048_576)}
        limitIsHostImposed={transportLimitIsHostImposed()}
        maxPages={limits.maxPages}
      />

      {existing.length > 0 && (
        <section className="mt-14 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">
            Déjà importés
          </h2>
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {existing.map((chapter) => (
              <li key={chapter.id} className="flex items-baseline gap-3 py-2.5">
                <Link
                  href={`/chapitres/${chapter.id}`}
                  className="font-mono text-sm text-accent hover:underline"
                >
                  {String(chapter.number).padStart(3, '0')}
                </Link>
                <span className="text-sm text-primary">
                  {chapter.title ?? <span className="text-muted">sans titre</span>}
                </span>
                <span className="ml-auto shrink-0 text-sm text-muted">
                  {chapter.pageCount} p.
                  {chapter.hasTextLayer && ' · texte'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-14 border-t border-line pt-6 text-sm text-muted">
        Outil privé, pour des fichiers que vous possédez déjà. Rien n&apos;est
        téléchargé depuis Internet, rien n&apos;est récupéré automatiquement,
        rien n&apos;est partagé : les pages restent dans un stockage privé,
        servies par des liens signés de courte durée, et supprimables.
      </p>
    </main>
  )
}
