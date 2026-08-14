import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { quarantineSummary } from '@/domains/pipeline/quarantine.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { ReopenPanel } from './reopen-panel.tsx'
import { ReviewBoard } from './review-board.tsx'

export const metadata: Metadata = { title: 'Centre de revue' }
/** Signed evidence URLs expire within the minute; never cache this render. */
export const dynamic = 'force-dynamic'
/**
 * The ceiling applies to this page's server actions too, and publishing needs
 * it: closing a chapter writes a batch of decisions and then illustrates the
 * entities it opened, downloading and re-encoding pictures after the response.
 *
 * Since batch import, it may also start a whole pipeline run — the next chapter
 * of a queue, released by exactly this publication. That is the same shape of
 * work `/admin/import` carries at the same ceiling, and it is why lowering this would
 * not merely delay a picture: it would tear down the invocation mid-run and
 * leave the queued chapter stuck on its first step with nothing to explain it.
 */
export const maxDuration = 300

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  const session = await getReaderSession()

  const queue = await getReviewQueue(session.userId, runId)
  if (!queue) notFound()

  /*
   * What was decided, read separately from what is pending.
   *
   * Two reads rather than one with `includeDecided`, because the queue's limit
   * would then be shared: a chapter with two hundred rejected proposals would
   * push the ones still waiting off the board, which is the opposite of what
   * this page is for.
   */
  const settled = await getReviewQueue(session.userId, runId, {
    includeDecided: true,
    limit: 500,
  })
  const reopenable = (settled?.items ?? []).filter(
    (item) => item.status === 'rejected' || item.status === 'deferred',
  )

  const quarantined = await quarantineSummary(session.userId, runId)

  return (
    <main id="contenu" className="mx-auto max-w-[1500px] px-4 py-4">
      {/*
       * A triage station, not an article.
       *
       * The page opened with a breadcrumb, a 4xl title, a subtitle and a
       * paragraph explaining the review model — four blocks of reading before
       * the first proposal, every single time, on a screen someone visits with
       * eighty decisions to make. The explanation is true and it belongs
       * somewhere; it does not belong between you and the work, every session.
       */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href={`/admin/runs/${runId}`}
          className="font-display text-sm uppercase text-muted no-underline hover:text-primary"
        >
          ‹ Traitement
        </Link>
        <h1 className="font-display text-2xl uppercase leading-none text-primary">
          Revue · chapitre {queue.chapterNumber}
        </h1>
        {queue.chapterTitle && (
          <span className="truncate text-secondary">{queue.chapterTitle}</span>
        )}
        {queue.counts.requiringExplicitReview > 0 && (
          <span className="badge badge-or ml-auto">
            {queue.counts.requiringExplicitReview} en revue explicite
          </span>
        )}
      </div>

      <ReviewBoard queue={serialisable(queue)} />

      {reopenable.length > 0 && (
        <ReopenPanel runId={runId} items={serialisable(reopenable)} />
      )}

      {quarantined.length > 0 && (
        <details className="panneau mt-8">
          <summary className="panneau-titre cursor-pointer list-none">
            Quarantaine
            <span className="font-sans text-xs normal-case opacity-80">
              {quarantined.reduce((sum, e) => sum + e.count, 0)} écartée(s) · pourquoi ?
            </span>
          </summary>
          <div className="panneau-corps">
            <p className="max-w-3xl text-sm text-secondary">
              Ces propositions n&apos;ont pas pu être rattachées à une preuve
              vérifiable : référence inexistante, ou extrait absent du texte
              cité. Elles ne sont <strong>pas</strong> proposables — c&apos;est
              le garde-fou qui empêche une affirmation venue d&apos;ailleurs que
              des pages d&apos;atteindre le graphe. Leur répartition est en
              revanche un bon diagnostic.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {quarantined.map((entry) => (
                <li key={entry.reason} className="flex gap-3">
                  <span className="chiffre text-lg">{entry.count}</span>
                  <span className="text-secondary">{quarantineLabel(entry.reason)}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

    </main>
  )
}

function quarantineLabel(reason: string): string {
  const labels: Record<string, string> = {
    unknown_ref:
      'référence de case ou de bloc inexistante — souvent le signe que le découpage a mal tourné',
    excerpt_not_in_source:
      "extrait absent du bloc cité — souvent le signe d'une transcription trop dégradée pour ancrer quoi que ce soit",
    visual_without_description:
      'preuve visuelle sur une case sans description produite',
    unknown_predicate: 'prédicat hors ontologie',
    unknown_node_type: 'type de nœud hors ontologie',
    unknown_subject: 'sujet introuvable — son entité a été écartée',
    unknown_object: 'objet introuvable',
    literal_object: 'objet écrit en toutes lettres au lieu d’une entité',
    empty_excerpt: 'preuve sans extrait',
  }
  return labels[reason] ?? reason
}

/** Dates cross to the client as strings; send one shape, not two. */
function serialisable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
