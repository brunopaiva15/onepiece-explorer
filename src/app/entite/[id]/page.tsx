import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getEntitySheet, type SheetFact } from '@/domains/temporal/entity-sheet.ts'
import { displayImage } from '@/domains/images/index.ts'
import { PREDICATE_BY_KEY } from '@/domains/knowledge/ontology.ts'
import { localizedLabel, type Locale } from '@/lib/i18n/index.ts'
import { getDict } from '@/lib/i18n/server.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.entity.sheetTitle }
}
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
  const dict = await getDict()
  const t = dict.entity

  const sheet = await getEntitySheet(
    session.userId,
    session.boundaryChapter,
    id,
    session.locale,
  )
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
                  alt={t.illustrationAlt(sheet.displayLabel)}
                  loading="eager"
                  className="h-44 w-36 object-cover"
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
              <span className="badge badge-or">{sheet.nodeType}</span>
              <h1 className="mt-2 break-words text-white">{sheet.displayLabel}</h1>

              <div className="mt-3 flex flex-wrap gap-4">
                <span>
                  <span className="cartouche block !text-white/70">
                    {t.firstAppearance}
                  </span>
                  <span className="chiffre text-2xl">
                    {t.ch(sheet.firstSeenChapter)}
                  </span>
                </span>
                <span>
                  <span className="cartouche block !text-white/70">{t.factsLabel}</span>
                  <span className="chiffre text-2xl">{sheet.facts.length}</span>
                </span>
                {sheet.memberIds.length > 1 && (
                  <span title={t.mergedPersonTitle}>
                    <span className="cartouche block !text-white/70">
                      {t.mergedLabel}
                    </span>
                    <span className="chiffre text-2xl">{sheet.memberIds.length}</span>
                  </span>
                )}
                {sheet.labels.length > 1 && (
                  <span>
                    <span className="cartouche block !text-white/70">
                      {t.namesLabel}
                    </span>
                    <span className="chiffre text-2xl">{sheet.labels.length}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {sheet.displayKind === 'placeholder' && (
            <p className="border-t-[3px] border-ink bg-[var(--accent)] px-4 py-1.5 text-sm text-ink">
              {t.placeholderNote}
            </p>
          )}

          {portrait && (
            /* The caption is not optional: a name match is a guess, and a face
               shown without saying so reads as something the pipeline
               established from your pages. It did not. */
            <p className="border-t-[3px] border-ink px-4 py-1.5 text-xs text-muted">
              {t.captionLead}{' '}
              <a
                href={portrait.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline decoration-dotted hover:text-secondary"
              >
                {portrait.attribution}
              </a>
              {t.captionMatchedByName}
            </p>
          )}
        </header>

        {sheet.labels.length > 1 && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold text-primary">{t.namesLabel}</h2>
            <p className="mt-1 text-sm text-secondary">{t.namesIntro}</p>
            <ul className="mt-3 divide-y divide-[var(--border)]">
              {sheet.labels.map((label) => (
                <li
                  key={`${label.label}-${label.revealedInChapter}`}
                  className="flex flex-wrap items-baseline gap-x-3 py-2"
                >
                  <span className="text-primary">{label.label}</span>
                  <span className="text-sm text-muted">
                    {dict.common.labelKind[label.kind] ?? label.kind}
                  </span>
                  <span className="ml-auto font-mono text-sm text-muted">
                    {t.revealedCh(label.revealedInChapter)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <FactList
          title={t.knownFactsTitle}
          facts={outgoing}
          boundary={session.boundaryChapter}
          empty={t.knownFactsEmpty}
          locale={session.locale}
        />

        {incoming.length > 0 && (
          <FactList
            title={t.saidFactsTitle}
            facts={incoming}
            boundary={session.boundaryChapter}
            empty=""
            locale={session.locale}
          />
        )}

        <p className="mt-14 border-t border-line pt-6 text-sm text-muted">
          {t.provenanceNote}
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
  locale,
}: {
  title: string
  facts: SheetFact[]
  boundary: number
  empty: string
  locale: Locale
}) {
  if (facts.length === 0 && empty === '') return null

  const dict = getDictFor(locale)
  const t = dict.entity

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
                <span className="font-mono text-sm text-accent">
                  {predicateLabel(fact.predicate, locale)}
                </span>
                {fact.otherId ? (
                  <Link
                    href={`/entite/${fact.otherId}?ch=${boundary}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {fact.otherLabel ?? dict.common.unnamedEntity}
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
                  {dict.common.epistemic[fact.epistemicStatus] ??
                    t.epistemicExtra[fact.epistemicStatus] ??
                    fact.epistemicStatus}
                </span>

                {fact.locked && (
                  <span
                    className="rounded-sm border border-line px-1.5 text-[0.7rem] text-muted"
                    title={t.yourCorrectionTitle}
                  >
                    {t.yourCorrection}
                  </span>
                )}

                <span className="ml-auto font-mono text-xs text-muted">
                  {t.knownSinceCh(fact.knowledgeFromChapter)}
                </span>
              </div>

              {fact.knowledgeUntilChapter !== null && (
                /* The reader is inside a window where this was believed and is
                   not yet refuted. Saying so is the point of the two-axis
                   model — a wiki would simply have deleted it. */
                <p className="mt-1.5 text-sm text-[var(--epi-hypothetical)]">
                  {t.beliefRefuted(fact.knowledgeUntilChapter)}
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
                          alt={t.evidenceAlt((evidence.pageIndex ?? 0) + 1)}
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
                            t.ch(evidence.chapterNumber)}
                          {evidence.pageIndex !== null &&
                            t.pageDot(evidence.pageIndex + 1)}
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

/**
 * The predicate's localized label from the ontology, the raw key when the
 * predicate is unknown there — a raw key is still legible, an empty span is
 * not.
 */
function predicateLabel(key: string, locale: Locale): string {
  const def = PREDICATE_BY_KEY.get(key)
  return def ? localizedLabel(def, locale) : key
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
