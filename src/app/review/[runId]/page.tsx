import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { quarantineSummary } from '@/domains/pipeline/quarantine.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { ReviewBoard } from './review-board.tsx'

export const metadata: Metadata = { title: 'Centre de revue' }
/** Signed evidence URLs expire within the minute; never cache this render. */
export const dynamic = 'force-dynamic'

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  const session = await getReaderSession()

  const queue = await getReviewQueue(session.userId, runId)
  if (!queue) notFound()

  const quarantined = await quarantineSummary(session.userId, runId)

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-6 py-12">
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal
        </Link>
        <span className="text-muted">/</span>
        <Link href={`/runs/${runId}`} className="text-muted hover:text-primary">
          Traitement
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">
        Revue du chapitre {queue.chapterNumber}
      </h1>
      {queue.chapterTitle && (
        <p className="mt-1 text-xl text-secondary">{queue.chapterTitle}</p>
      )}

      <p className="mt-4 max-w-3xl text-secondary">
        Chaque proposition est affichée avec la case et le texte dont elle est
        tirée. Rien n&apos;entre dans le graphe sans votre accord, et une décision
        prise ici sera réappliquée automatiquement si vous réimportez ce chapitre.
      </p>

      <ReviewBoard queue={serialisable(queue)} />

      {quarantined.length > 0 && (
        <section className="mt-14 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">Quarantaine</h2>
          <p className="mt-2 max-w-3xl text-sm text-secondary">
            Ces propositions n&apos;ont pas pu être rattachées à une preuve
            vérifiable : référence inexistante, ou extrait absent du texte cité.
            Elles ne sont <strong>pas</strong> proposables — c&apos;est
            précisément le garde-fou qui empêche une affirmation venue
            d&apos;ailleurs que des pages d&apos;atteindre le graphe. Leur
            répartition est en revanche un bon diagnostic.
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {quarantined.map((entry) => (
              <li key={entry.reason} className="flex gap-3">
                <span className="font-mono text-muted">{entry.count}</span>
                <span className="text-secondary">{quarantineLabel(entry.reason)}</span>
              </li>
            ))}
          </ul>
        </section>
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
    empty_excerpt: 'preuve sans extrait',
  }
  return labels[reason] ?? reason
}

/** Dates cross to the client as strings; send one shape, not two. */
function serialisable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
