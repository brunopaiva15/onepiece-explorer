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
    <main id="contenu" className="mx-auto max-w-3xl px-4 py-6">
      {/*
       * The suggested number, up front and enormous.
       *
       * It is the one field that cannot be corrected later without
       * consequences — it dates everything the chapter reveals, and therefore
       * decides what stays hidden behind the cursor forever after. It used to
       * be the first input of a form, under a paragraph explaining why it
       * matters. Showing the value the application already worked out, at the
       * size of a decision, does that job without asking anyone to read.
       */}
      <div className="flex items-center gap-4">
        <div
          className="flex h-24 w-24 shrink-0 flex-col items-center justify-center border-[4px] border-ink bg-[var(--accent)] text-ink"
          style={{ boxShadow: 'var(--shadow-hard)' }}
        >
          <span className="cartouche !text-ink/70">Chapitre</span>
          <span className="chiffre text-4xl">{suggested}</span>
        </div>
        <div className="min-w-0">
          <h1 className="text-primary">Importer</h1>
          <p className="mt-1 text-sm text-secondary">
            Le numéro date tout ce que ce chapitre révèle. Modifiable
            ci-dessous&nbsp;; {existing.length === 0 ? 'commencez par celui que vous avez lu en premier.' : `le dernier importé est le ${highest}.`}
          </p>
        </div>
      </div>

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
