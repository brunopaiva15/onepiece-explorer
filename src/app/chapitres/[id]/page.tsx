import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { getChapter, getChapterPages } from '@/domains/chapters/queries.ts'
import { chapterPassages } from '@/domains/ingestion/summary.ts'
import { latestRunForChapter } from '@/domains/pipeline/runs.ts'
import { PageGrid } from './page-grid.tsx'
import { providerOptions } from '@/domains/ai/index.ts'
import { StartRun } from './start-run.tsx'

export const metadata: Metadata = { title: 'Source du chapitre' }

/**
 * Signed asset URLs live about a minute, so this page must never be cached.
 * A cached render would hand a later visitor a set of expired links and look
 * like the storage had broken.
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


export default async function ChapterPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getReaderSession()

  const chapter = await getChapter(session.userId, id)
  if (!chapter) notFound()

  const written = chapter.sourceKind === 'summary'

  /*
   * One branch, two sources.
   *
   * A written chapter has passages and no pages; a file-imported one has pages.
   * Fetching only what applies keeps a written chapter from paying for a round
   * of signed URLs that would sign nothing.
   */
  const [pages, passages, lastRunId] = await Promise.all([
    written ? Promise.resolve([]) : getChapterPages(session.userId, chapter.id, chapter.number),
    written ? chapterPassages(session.userId, chapter.id) : Promise.resolve([]),
    latestRunForChapter(session.userId, chapter.id),
  ])

  const units = written ? passages.length : pages.length
  const characters = passages.reduce((sum, passage) => sum + passage.text.length, 0)

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-4 py-6">
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal
        </Link>
        <span className="text-muted">/</span>
        <Link href="/import" className="text-muted hover:text-primary">
          Import
        </Link>
      </nav>

      {/*
       * The chapter as a masthead: number, title, and the figures that say
       * whether the source is usable. Those figures replace the paragraph that
       * used to describe signed links — a note about storage on a page whose
       * subject is text.
       */}
      <header className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="flex items-baseline gap-2">
          <span className="cartouche">Chapitre</span>
          <span className="chiffre text-4xl leading-none">{chapter.number}</span>
        </span>
        {chapter.title && <p className="text-xl text-secondary">{chapter.title}</p>}

        <span className="flex items-baseline gap-1.5">
          <span className="chiffre text-2xl">{units}</span>
          <span className="cartouche">{written ? 'passages' : 'pages'}</span>
        </span>
        {written && (
          <span className="flex items-baseline gap-1.5">
            <span className="chiffre text-2xl">{characters}</span>
            <span className="cartouche">caractères</span>
          </span>
        )}
        {written && chapter.language !== 'fr' && (
          <span className="badge badge-gris" title="Langue de la source : celle des extraits cités">
            source {chapter.language}
          </span>
        )}

        <span className="badge ml-auto">{statusLabel(chapter.status)}</span>
      </header>

      <div className="mt-5 flex flex-wrap items-start gap-3">
        {units > 0 && (
          <StartRun
            chapterId={chapter.id}
            options={providerOptions()}
            processed={chapter.status === 'review' || chapter.status === 'published'}
          />
        )}
        {lastRunId && (
          <Link href={`/runs/${lastRunId}`} className="bouton !py-1.5 !text-sm">
            Dernier traitement
          </Link>
        )}
        {written && (
          <Link href="/import" className="bouton !py-1.5 !text-sm">
            Corriger le texte
          </Link>
        )}
      </div>

      {units === 0 ? (
        <p className="mt-8 border-[3px] border-ink bg-[var(--accent)] px-4 py-3 text-ink">
          {written
            ? "Ce chapitre n'a aucun passage. Réimportez son texte."
            : "Aucune page enregistrée pour ce chapitre. Relancez l'import."}
        </p>
      ) : written ? (
        <>
          {/*
           * The passages, numbered and shown whole.
           *
           * This is the entire evidence base of the chapter: every fact the
           * review queue will offer you cites one of these by number, and
           * checking a citation means reading the passage it points at. Hiding
           * them behind a toggle would hide the only thing on this page that
           * can be checked.
           */}
          <ol className="mt-8 space-y-2.5">
            {passages.map((passage) => (
              <li
                key={passage.id}
                className="flex gap-3 border-[3px] border-ink bg-surface-raised px-3 py-2.5"
              >
                <span className="chiffre shrink-0 text-xl leading-tight text-muted">
                  {passage.order + 1}
                </span>
                <p className="min-w-0 whitespace-pre-wrap text-primary">{passage.text}</p>
              </li>
            ))}
          </ol>

          {chapter.parallelText !== null && (
            /*
             * The second text, shown as prose and never numbered.
             *
             * The numbering above is the vocabulary of citation — a proposal
             * points at passage 7 — and this text can be pointed at by nothing.
             * Giving it numbers of its own would suggest otherwise on the one
             * page where the distinction has to be legible, so it keeps a shape
             * that cannot be cited: a paragraph, behind a toggle, stated for
             * what it is.
             */
            <details className="mt-8 border-[3px] border-ink bg-surface-raised">
              <summary className="cursor-pointer px-3 py-2.5 font-display text-sm uppercase text-primary">
                Le même chapitre en{' '}
                {chapter.parallelLanguage === 'fr' ? 'français' : 'anglais'}
                <span className="ml-2 font-sans normal-case text-muted">
                  {chapter.parallelText.length} caractères · non citable
                </span>
              </summary>
              <div className="border-t-[3px] border-ink px-3 py-2.5">
                <p className="text-sm text-secondary">
                  Fourni au modèle pour les noms uniquement&nbsp;: la mise en
                  regard des deux langues donne la forme française d&apos;un nom
                  au lieu de la lui faire deviner. Aucune preuve ne peut renvoyer
                  ici, et un fait que ce texte serait seul à énoncer n&apos;entre
                  pas dans le graphe.
                </p>
                <p className="mt-3 whitespace-pre-wrap text-primary">
                  {chapter.parallelText}
                </p>
              </div>
            </details>
          )}

          <p className="mt-10 border-t border-line pt-6 text-sm text-muted">
            Chaque proposition devra citer mot pour mot un de ces passages. Un
            extrait qui n&apos;y apparaît pas est mis en quarantaine et
            n&apos;atteint jamais la revue — c&apos;est ce qui empêche le modèle
            d&apos;ajouter ce qu&apos;il sait de One&nbsp;Piece par ailleurs.
          </p>
        </>
      ) : (
        <>
          <PageGrid
            chapterId={chapter.id}
            chapterNumber={chapter.number}
            readingDirection={chapter.readingDirection}
            pages={pages}
          />
          <p className="mt-10 border-t border-line pt-6 text-sm text-muted">
            Les aperçus sont servis par des liens signés valables une minute.
            Aucune page n&apos;a d&apos;adresse permanente&nbsp;: un lien copié
            cesse de fonctionner.
          </p>
        </>
      )}
    </main>
  )
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'brouillon',
    uploaded: 'importé',
    processing: 'en traitement',
    review: 'à revoir',
    published: 'publié',
    failed: 'échec',
  }
  return labels[status] ?? status
}
