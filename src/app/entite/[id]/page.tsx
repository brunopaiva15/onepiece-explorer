import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getEntitySheet, type SheetFact } from '@/domains/temporal/entity-sheet.ts'
import { displayImage } from '@/domains/images/index.ts'
import { labelKindLabel } from '@/domains/knowledge/label-kind.ts'
import { nodeTypeLabel, predicateLabel } from '@/domains/knowledge/predicate-label.ts'
import { RenameEntity } from './rename-entity.tsx'
import { RetypeEntity } from './retype-entity.tsx'

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
  const session = await getViewerSession(ch)

  const sheet = await getEntitySheet(session.userId, session.boundaryChapter, id)
  if (!sheet) notFound()
  // Every member of the identity component: after a merge the picture may hang
  // off the half that is no longer the representative.
  const portrait = await displayImage(
    session.userId,
    session.boundaryChapter,
    sheet.memberIds,
  )
  const outgoing = sheet.facts.filter((fact) => fact.direction === 'outgoing')
  const incoming = sheet.facts.filter((fact) => fact.direction === 'incoming')

  return (
    <>
      <main id="contenu" className="mx-auto max-w-5xl px-4 py-4">
        {/*
         * A cover, not a paragraph.
         *
         * We have had portraits since the images phase and this page still
         * opened with a breadcrumb, a 12px node type, a title, and four
         * sentences of prose covering the naming model, the first appearance
         * and the merge count — a wall of exposition where a reader wants a
         * face and a name. The facts are all still here; they are now
         * *displayed* rather than narrated: the type is a badge, the first
         * appearance is a number, the merge count is a number.
         */}
        <header
          className="panneau overflow-hidden"
          style={{ boxShadow: 'var(--shadow-hard)' }}
        >
          <div className="flex flex-col gap-4 bg-[var(--sea-deep)] p-4 text-white sm:flex-row sm:items-end">
            {portrait ? (
              <div className="shrink-0 self-start border-[3px] border-ink bg-surface-raised">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={portrait.url}
                  alt={`Illustration de ${sheet.displayLabel}`}
                  loading="eager"
                  className="h-44 w-36 object-cover object-top"
                />
              </div>
            ) : (
              <div className="flex h-44 w-36 shrink-0 items-center justify-center self-start border-[3px] border-ink bg-[var(--sea)] text-center">
                <span className="chiffre text-5xl opacity-60">
                  {sheet.displayLabel.slice(0, 1).toUpperCase()}
                </span>
              </div>
            )}

            <div className="min-w-0 flex-1">
              <span className="badge badge-or">{nodeTypeLabel(sheet.nodeType)}</span>
              <h1 className="mt-2 break-words text-white">{sheet.displayLabel}</h1>

              <div className="mt-3 flex flex-wrap gap-4">
                <span>
                  <span className="cartouche block !text-white/70">1re apparition</span>
                  <span className="chiffre text-2xl">ch. {sheet.firstSeenChapter}</span>
                </span>
                <span>
                  <span className="cartouche block !text-white/70">Faits</span>
                  <span className="chiffre text-2xl">{sheet.facts.length}</span>
                </span>
                {sheet.memberIds.length > 1 && (
                  <span title="Apparitions distinctes identifiées comme une seule personne">
                    <span className="cartouche block !text-white/70">Fusionnées</span>
                    <span className="chiffre text-2xl">{sheet.memberIds.length}</span>
                  </span>
                )}
                {sheet.labels.length > 1 && (
                  <span>
                    <span className="cartouche block !text-white/70">Noms connus</span>
                    <span className="chiffre text-2xl">{sheet.labels.length}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {sheet.displayKind === 'placeholder' && (
            <p className="border-t-[3px] border-ink bg-[var(--accent)] px-4 py-1.5 text-sm text-ink">
              Aucun nom n&apos;est donné à ce stade : cette désignation vient de
              l&apos;image.
            </p>
          )}

          {portrait && (
            /* The caption is not optional: a name match is a guess, and a face
               shown without saying so reads as something the pipeline
               established from your pages. It did not. */
            <p className="border-t-[3px] border-ink px-4 py-1.5 text-xs text-muted">
              Illustration{' '}
              <a
                href={portrait.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-dotted hover:text-secondary"
              >
                {portrait.attribution}
              </a>
              , rapprochée par le nom — pas une preuve tirée de vos pages.
            </p>
          )}
        </header>

        {/*
         * The two things on this page you can be sure of and the pipeline
         * cannot: whether « Helmeppo » is called Hermep in French, and whether
         * the Bara Bara no Mi is a power or the fruit you eat to get one.
         * Neither is a fact in the chapter — both are conventions you hold.
         *
         * Under the cover rather than in it, and side by side: a correction is
         * a rare gesture, and the fiche opens on a face and a name, not on two
         * forms. Whichever one is opened takes the row to itself.
         *
         * A visitor reading a public library gets no button. Both actions check
         * ownership again on their own.
         */}
        {session.isOwner && (
          <div className="mt-4 flex flex-wrap items-start gap-2">
            <RenameEntity labels={sheet.labels} displayLabel={sheet.displayLabel} />
            <RetypeEntity
              entityId={sheet.id}
              nodeType={sheet.nodeType}
              displayLabel={sheet.displayLabel}
            />
          </div>
        )}

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
                <span className="text-sm text-accent">
                  {predicateLabel(fact.predicate)}
                </span>
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
