import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getNarrativeDelta } from '@/domains/temporal/timeline.ts'
import { getDict } from '@/lib/i18n/server.ts'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.timeline.deltaMetaTitle }
}
export const dynamic = 'force-dynamic'

/**
 * What one chapter changed.
 *
 * Read at the chapter's own boundary, so it answers "what did this chapter add
 * to what I already knew" rather than "what does this chapter contain". The
 * difference matters for the refutations section: a belief closed by this
 * chapter is invisible *at* this chapter, so it has to be read one chapter
 * earlier or the delta would never mention a single refutation.
 */
export default async function DeltaPage({
  params,
}: {
  params: Promise<{ chapitre: string }>
}) {
  const { chapitre } = await params
  const chapterNumber = Number(chapitre)
  if (!Number.isInteger(chapterNumber) || chapterNumber < 0) notFound()

  const session = await getViewerSession()
  const dict = await getDict()
  const t = dict.timeline
  const delta = await getNarrativeDelta(session.userId, chapterNumber, session.locale)
  if (!delta) notFound()

  const nothing =
    delta.newEntities.length === 0 &&
    delta.newFacts.length === 0 &&
    delta.refuted.length === 0 &&
    delta.newNames.length === 0

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-12">
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/chapitres" className="text-muted hover:text-primary">
          {t.deltaChaptersCrumb}
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">
        {t.deltaTitle(delta.chapterNumber)}
      </h1>
      {delta.chapterTitle && (
        <p className="mt-1 text-xl text-secondary">{delta.chapterTitle}</p>
      )}

      {nothing && (
        <p className="mt-8 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
          {t.deltaEmpty}
        </p>
      )}

      {delta.refuted.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-primary">
            {t.deltaRefutedHeading}
          </h2>
          <p className="mt-1 text-sm text-secondary">
            {t.deltaRefutedExplainer}
          </p>
          <ul className="mt-3 space-y-2">
            {delta.refuted.map((fact) => (
              <li
                key={fact.id}
                className="rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-3 text-sm"
              >
                <span className="text-primary">{fact.subjectLabel}</span>{' '}
                <span className="font-mono text-accent">{fact.predicate}</span>
                <span className="ml-2 text-muted">
                  {t.deltaHeldSince(fact.heldSince)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {delta.newNames.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-primary">{t.deltaNamesHeading}</h2>
          <ul className="mt-3 space-y-2">
            {delta.newNames.map((name) => (
              <li key={`${name.entityId}-${name.label}`} className="text-sm">
                <Link
                  href={`/entite/${name.entityId}?ch=${delta.chapterNumber}`}
                  className="text-accent hover:underline"
                >
                  {name.label}
                </Link>
                {name.previous && name.previous !== name.label && (
                  <span className="text-secondary">
                    {' '}
                    {t.deltaPreviousName(name.previous)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {delta.newEntities.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-primary">
            {t.deltaNewEntitiesHeading(delta.newEntities.length)}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {delta.newEntities.map((entity) => (
              <li key={entity.id}>
                <Link
                  href={`/entite/${entity.id}?ch=${delta.chapterNumber}`}
                  className="inline-block rounded-sm border border-line px-2.5 py-1 text-sm text-primary hover:bg-surface-raised"
                >
                  {entity.label}
                  <span className="ml-2 text-xs text-muted">{entity.nodeType}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {delta.newFacts.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-primary">
            {t.deltaNewFactsHeading(delta.newFacts.length)}
          </h2>
          <ul className="mt-3 space-y-1.5 text-sm">
            {delta.newFacts.map((fact) => (
              <li key={fact.id} className="text-primary">
                {fact.subjectLabel}{' '}
                <span className="font-mono text-accent">{fact.predicate}</span>{' '}
                {fact.objectLabel ?? ''}
                {fact.epistemicStatus !== 'explicit' && (
                  <span className="ml-2 text-xs text-muted">
                    ({dict.common.epistemic[fact.epistemicStatus]})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-12 flex flex-wrap gap-3 border-t border-line pt-6">
        <Link
          href={`/graph?ch=${delta.chapterNumber}`}
          className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          {t.deltaViewGraph}
        </Link>
        <Link
          href={`/delta/${delta.chapterNumber - 1}`}
          className="rounded-sm border border-line-strong px-4 py-2 text-sm text-primary hover:bg-surface-raised"
        >
          {t.deltaPreviousChapter}
        </Link>
      </div>
    </main>
  )
}
