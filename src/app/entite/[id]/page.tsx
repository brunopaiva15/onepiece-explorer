import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { getEntitySheet, type SheetFact } from '@/domains/temporal/entity-sheet.ts'
import { displayImage } from '@/domains/images/index.ts'
import { BoundarySlider } from '@/app/graph/boundary-slider.tsx'
import { Portrait } from '@/app/components/portrait.tsx'

export const metadata: Metadata = { title: 'Fiche' }
export const dynamic = 'force-dynamic'

export default async function EntityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ ch?: string }>
}) {
  const { id } = await params
  const { ch } = await searchParams
  const session = await getReaderSession(ch)

  const sheet = await getEntitySheet(session.userId, session.boundaryChapter, id)
  if (!sheet) notFound()

  const [chapters, portrait] = await Promise.all([
    listChapters(session.userId, session.workId),
    // Every member of the identity component: after a merge the picture may
    // hang off the half that is no longer the representative.
    displayImage(session.userId, session.boundaryChapter, sheet.memberIds),
  ])
  const outgoing = sheet.facts.filter((fact) => fact.direction === 'outgoing')
  const incoming = sheet.facts.filter((fact) => fact.direction === 'incoming')

  return (
    <>
      <BoundarySlider
        boundaryChapter={session.boundaryChapter}
        maxChapter={session.maxChapter}
        chapters={chapters.filter((c) => c.status === 'published').map((c) => c.number)}
      />

      <main id="contenu" className="mx-auto max-w-4xl px-6 py-8">
        <nav className="text-sm">
          <Link
            href={`/graph?ch=${session.boundaryChapter}`}
            className="text-muted hover:text-primary"
          >
            Graphe
          </Link>
        </nav>

        <header className="mt-4 flex flex-wrap items-start gap-6">
          <Portrait image={portrait} label={sheet.displayLabel} />

          <div className="min-w-64 flex-1">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            {sheet.nodeType}
          </p>
          <h1 className="mt-1 text-4xl font-semibold text-primary">
            {sheet.displayLabel}
          </h1>
          <p className="mt-2 text-sm text-secondary">
            {sheet.displayKind === 'placeholder'
              ? "Aucun nom n'est donné à ce stade : cette désignation vient de l'image."
              : `Désignation : ${labelKindLabel(sheet.displayKind)}.`}{' '}
            Première apparition au chapitre {sheet.firstSeenChapter}.
            {sheet.memberIds.length > 1 &&
              ` ${sheet.memberIds.length} apparitions distinctes ont été identifiées comme une seule personne.`}
          </p>
          </div>
        </header>

        {sheet.labels.length > 1 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-primary">Noms connus</h2>
            <p className="mt-1 text-sm text-secondary">
              L&apos;historique de ce qu&apos;il fallait l&apos;appeler. Reculez le
              curseur et le nom affiché change avec lui.
            </p>
            <ul className="mt-3 divide-y divide-[var(--border)]">
              {sheet.labels.map((label) => (
                <li
                  key={`${label.label}-${label.revealedInChapter}`}
                  className="flex flex-wrap items-baseline gap-x-3 py-2"
                >
                  <span className="text-primary">{label.label}</span>
                  <span className="text-sm text-muted">
                    {labelKindLabel(label.kind)}
                  </span>
                  <span className="ml-auto font-mono text-sm text-muted">
                    révélé ch. {label.revealedInChapter}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <FactList
          title="Ce que l’on sait"
          facts={outgoing}
          boundary={session.boundaryChapter}
          empty="Rien d’affirmé à propos de cette entité à ce chapitre."
        />

        {incoming.length > 0 && (
          <FactList
            title="Ce que l’on dit d’elle"
            facts={incoming}
            boundary={session.boundaryChapter}
            empty=""
          />
        )}

        <p className="mt-14 border-t border-line pt-6 text-sm text-muted">
          Chaque fait porte le chapitre où vous avez pu l&apos;apprendre et la case
          qui le prouve. Un fait sans preuve n&apos;entre pas ici.
        </p>
      </main>
    </>
  )
}

function FactList({
  title,
  facts,
  boundary,
  empty,
}: {
  title: string
  facts: SheetFact[]
  boundary: number
  empty: string
}) {
  if (facts.length === 0 && empty === '') return null

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-primary">{title}</h2>

      {facts.length === 0 ? (
        <p className="mt-3 rounded-sm border border-line bg-surface-raised p-4 text-secondary">
          {empty}
        </p>
      ) : (
        <ul className="mt-3 space-y-4">
          {facts.map((fact) => (
            <li
              key={fact.assertionId}
              className="rounded-sm border border-line bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-accent">{fact.predicate}</span>
                {fact.otherId ? (
                  <Link
                    href={`/entite/${fact.otherId}?ch=${boundary}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {fact.otherLabel ?? 'entité sans nom révélé'}
                  </Link>
                ) : (
                  <span className="font-medium text-primary">{fact.literalValue}</span>
                )}

                <span
                  className="rounded-sm px-1.5 text-[0.7rem]"
                  style={{
                    color: epistemicColour(fact.epistemicStatus),
                    border: `1px solid ${epistemicColour(fact.epistemicStatus)}`,
                  }}
                >
                  {epistemicLabel(fact.epistemicStatus)}
                </span>

                {fact.locked && (
                  <span
                    className="rounded-sm border border-line px-1.5 text-[0.7rem] text-muted"
                    title="Corrigé par vous : jamais remplacé par une nouvelle extraction"
                  >
                    votre correction
                  </span>
                )}

                <span className="ml-auto font-mono text-xs text-muted">
                  su depuis ch. {fact.knowledgeFromChapter}
                </span>
              </div>

              {fact.knowledgeUntilChapter !== null && (
                /* The reader is inside a window where this was believed and is
                   not yet refuted. Saying so is the point of the two-axis
                   model — a wiki would simply have deleted it. */
                <p className="mt-1.5 text-sm text-[var(--epi-hypothetical)]">
                  Cette croyance sera démentie au chapitre {fact.knowledgeUntilChapter}.
                </p>
              )}

              {fact.evidence.length > 0 && (
                <ul className="mt-3 space-y-3 border-t border-line pt-3">
                  {fact.evidence.map((evidence, index) => (
                    <li key={index} className="flex flex-wrap gap-3">
                      {evidence.panelImageUrl && (
                        // Signed, short-lived URL from a private bucket. Not
                        // next/image, which would cache a private page under a
                        // stable public path.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={evidence.panelImageUrl}
                          alt={`Case source, page ${(evidence.pageIndex ?? 0) + 1}`}
                          loading="lazy"
                          className="max-h-40 w-auto rounded-sm border border-line"
                        />
                      )}
                      <div className="min-w-48 flex-1">
                        {evidence.excerpt && (
                          <blockquote className="border-l-2 border-accent pl-2.5 text-sm text-primary">
                            {evidence.excerpt}
                          </blockquote>
                        )}
                        <p className="mt-1 font-mono text-xs text-muted">
                          {evidence.chapterNumber !== null &&
                            `ch. ${evidence.chapterNumber}`}
                          {evidence.pageIndex !== null &&
                            ` · page ${evidence.pageIndex + 1}`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function labelKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    placeholder: 'désignation provisoire',
    alias: 'surnom',
    true_name: 'vrai nom',
    epithet: 'épithète',
    translation: 'traduction',
  }
  return labels[kind] ?? kind
}

function epistemicLabel(status: string): string {
  const labels: Record<string, string> = {
    explicit: 'affirmé',
    inferred_strong: 'déduit',
    hypothetical: 'hypothèse',
    contradicted: 'contredit',
    refuted: 'réfuté',
    user_validated: 'validé par vous',
  }
  return labels[status] ?? status
}

function epistemicColour(status: string): string {
  const colours: Record<string, string> = {
    explicit: 'var(--epi-explicit)',
    inferred_strong: 'var(--epi-inferred)',
    hypothetical: 'var(--epi-hypothetical)',
    contradicted: 'var(--epi-contradicted)',
    refuted: 'var(--epi-refuted)',
    user_validated: 'var(--epi-validated)',
  }
  return colours[status] ?? 'var(--text-muted)'
}
