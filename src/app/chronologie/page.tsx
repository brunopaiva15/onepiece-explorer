import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getTimeline, type TimelineEntry } from '@/domains/temporal/timeline.ts'

export const metadata: Metadata = { title: 'Chronologie' }
export const dynamic = 'force-dynamic'

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; axe?: string }>
}) {
  const { ch, axe } = await searchParams
  const session = await getViewerSession(ch)
  const timeline = await getTimeline(session.userId, session.boundaryChapter)

  const axis = axe === 'histoire' ? 'histoire' : 'revelation'
  const entries = axis === 'histoire' ? timeline.byStoryTime : timeline.byRevelation

  return (
    <>

      <main id="contenu" className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-3xl font-semibold text-primary">Chronologie</h1>

        <p className="mt-2 max-w-2xl text-sm text-secondary">
          Deux axes, jamais confondus. L&apos;ordre de <strong>révélation</strong>{' '}
          est celui où vous avez appris les choses ; l&apos;ordre de{' '}
          <strong>l&apos;histoire</strong> est celui où elles se sont produites. Un
          flashback est loin sur l&apos;un et récent sur l&apos;autre.
        </p>

        <nav className="mt-5 flex gap-2" aria-label="Axe de la chronologie">
          {(
            [
              ['revelation', 'Ordre de révélation'],
              ['histoire', "Ordre de l'histoire"],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={`/chronologie?ch=${session.boundaryChapter}&axe=${key}`}
              aria-current={axis === key}
              className={`rounded-sm border px-3 py-1.5 text-sm ${
                axis === key
                  ? 'border-accent bg-accent text-inverted'
                  : 'border-line-strong text-primary hover:bg-surface-raised'
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>

        {entries.length === 0 ? (
          <p className="mt-8 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
            {axis === 'histoire'
              ? "Aucun événement n'a de position connue dans le temps de l'histoire à ce chapitre."
              : `Rien de connu au chapitre ${session.boundaryChapter}.`}
          </p>
        ) : (
          <ol className="mt-8 space-y-3">
            {entries.map((entry) => (
              <li key={entry.entityId}>
                <Entry entry={entry} boundary={session.boundaryChapter} axis={axis} />
              </li>
            ))}
          </ol>
        )}

        {axis === 'histoire' && timeline.undated.length > 0 && (
          <section className="mt-12 border-t border-line pt-6">
            <h2 className="text-lg font-semibold text-primary">
              Sans position connue ({timeline.undated.length})
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-secondary">
              Ces événements sont connus mais les pages ne disent pas quand ils
              se produisent. Les placer sur l&apos;axe demanderait d&apos;inventer
              une précision que l&apos;œuvre ne donne pas.
            </p>
            <ul className="mt-3 space-y-2">
              {timeline.undated.map((entry) => (
                <li key={entry.entityId} className="text-sm text-secondary">
                  <Link
                    href={`/entite/${entry.entityId}?ch=${session.boundaryChapter}`}
                    className="text-accent hover:underline"
                  >
                    {entry.label}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-muted">
                    connu au ch. {entry.knownFromChapter}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  )
}

function Entry({
  entry,
  boundary,
  axis,
}: {
  entry: TimelineEntry
  boundary: number
  axis: 'revelation' | 'histoire'
}) {
  return (
    <article className="rounded-sm border border-line bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          href={`/entite/${entry.entityId}?ch=${boundary}`}
          className="font-medium text-primary hover:underline"
        >
          {entry.label}
        </Link>

        {entry.kind === 'mystery' && (
          <span className="rounded-sm border border-[var(--epi-hypothetical)] px-1.5 text-[0.7rem] text-[var(--epi-hypothetical)]">
            mystère{entry.resolvedInChapter !== null && ' — résolu'}
          </span>
        )}

        {entry.isFlashback && (
          <span
            className="rounded-sm border border-line px-1.5 text-[0.7rem] text-muted"
            title="Montré ici, survenu plus tôt dans l'histoire"
          >
            flashback
          </span>
        )}

        <span className="ml-auto font-mono text-xs text-muted">
          {axis === 'histoire' && entry.storyTime
            ? entry.storyTime.description
            : `ch. ${entry.knownFromChapter}`}
        </span>
      </div>

      {entry.summary && entry.summary !== entry.label && (
        <p className="mt-1.5 text-sm text-secondary">{entry.summary}</p>
      )}

      {axis === 'histoire' && entry.storyTime?.kind === 'approximate' && (
        /* The imprecision is the finding, not a gap to hide. */
        <p className="mt-1 text-xs text-muted">
          Position approximative : c&apos;est tout ce que les pages donnent.
        </p>
      )}

      {entry.resolvedInChapter !== null && (
        <p className="mt-1 text-sm text-[var(--epi-validated)]">
          Résolu au chapitre {entry.resolvedInChapter}.
        </p>
      )}
    </article>
  )
}
