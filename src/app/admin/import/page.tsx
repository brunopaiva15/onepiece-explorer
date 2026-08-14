import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { queuedChapters } from '@/domains/pipeline/queue.ts'
import { BatchForm } from './batch-form.tsx'
import { QueuePanel } from './queue-panel.tsx'
import { SummaryForm } from './summary-form.tsx'

export const metadata: Metadata = { title: 'Importer un chapitre' }
/**
 * Per-user and cookie-dependent: never prerendered, and never in a shared
 * cache. Signed asset URLs expire within the minute, so a cached render would
 * hand a later request a page of dead links.
 */
export const dynamic = 'force-dynamic'

/**
 * How long this route's invocation may live.
 *
 * Load-bearing, not a tuning knob. Starting a run schedules the pipeline with
 * `after()`, which continues the work once the response has left — but on the
 * same invocation, and therefore inside this ceiling. Without it the route
 * inherits the platform default of a few seconds: the response returns, the
 * function is torn down mid-call, and the run sits at `running` on its first
 * step forever with nothing recorded to explain it. That is the exact shape of
 * "stuck at step 1".
 *
 * 300s matches the SSE progress route, which has needed it since it was
 * written. Raise it if your plan allows more and a chapter ever runs long;
 * lowering it silently reintroduces the failure above.
 */
export const maxDuration = 300



export default async function ImportPage() {
  const session = await getReaderSession()
  const [existing, waiting] = await Promise.all([
    listChapters(session.userId, session.workId),
    queuedChapters(session.userId),
  ])

  const highest = existing.reduce((max, c) => Math.max(max, c.number), 0)
  const suggested = existing.length === 0 ? 1 : highest + 1

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

      <QueuePanel chapters={waiting} />

      <BatchForm suggestedNumber={suggested} />

      {/*
        * One chapter, kept as the primary form.
        *
        * The batch is for catching up; this is for the chapter that just came
        * out, for re-pasting a summary you corrected, and for writing one
        * yourself. Folded below the batch rather than removed — it is still the
        * path with every control on it.
        */}
      <details open={waiting.length === 0} className="mt-10 border-t border-line pt-6">
        <summary className="cursor-pointer font-display text-lg uppercase text-primary">
          Un seul chapitre
        </summary>
        <SummaryForm suggestedNumber={suggested} />
      </details>

      {existing.length > 0 && (
        <section className="mt-14 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">
            Déjà importés
          </h2>
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {existing.map((chapter) => (
              <li key={chapter.id} className="flex items-baseline gap-3 py-2.5">
                <Link
                  href={`/admin/chapitres/${chapter.id}`}
                  className="font-mono text-sm text-accent hover:underline"
                >
                  {String(chapter.number).padStart(3, '0')}
                </Link>
                <span className="text-sm text-primary">
                  {chapter.title ?? <span className="text-muted">sans titre</span>}
                </span>
                <span className="ml-auto shrink-0 text-sm text-muted">
                  {chapter.sourceKind === 'summary'
                    ? `${chapter.passageCount} passages`
                    : `${chapter.pageCount} p.`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-14 border-t border-line pt-6 text-sm text-muted">
        Outil privé. Le texte que vous écrivez est la seule source&nbsp;: rien
        n&apos;est récupéré sur Internet, aucune page de manga n&apos;est
        stockée, rien n&apos;est partagé. Ce que le chapitre ne dit pas
        n&apos;entrera pas dans le graphe, même si le modèle le sait par
        ailleurs.
      </p>
    </main>
  )
}
