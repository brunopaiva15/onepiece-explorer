import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { BoundarySlider } from './boundary-slider.tsx'
import { GraphCanvas } from './graph-canvas.tsx'

export const metadata: Metadata = { title: 'Graphe' }
export const dynamic = 'force-dynamic'

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; type?: string }>
}) {
  const { ch, type } = await searchParams
  // The boundary is resolved and clamped server-side. A value from the query
  // string is untrusted input, and one that widened what the reader can see
  // would be the whole product failing at once.
  const session = await getReaderSession(ch)
  const chapters = await listChapters(session.userId, session.workId)

  const nodeTypes = type ? type.split(',').filter(Boolean) : undefined
  const projection = await projectGraph(session.userId, session.boundaryChapter, {
    ...(nodeTypes ? { nodeTypes } : {}),
  })

  return (
    <>
      <BoundarySlider
        boundaryChapter={session.boundaryChapter}
        maxChapter={session.maxChapter}
        chapters={chapters.filter((c) => c.status === 'published').map((c) => c.number)}
      />

      <main id="contenu" className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold text-primary">Graphe</h1>
            <p className="mt-1 text-sm text-secondary">
              {projection.nodes.length} nœud
              {projection.nodes.length === 1 ? '' : 's'} ·{' '}
              {projection.edges.length} relation
              {projection.edges.length === 1 ? '' : 's'}
              {projection.mergedAway > 0 && (
                <>
                  {' · '}
                  <span title="Entités fusionnées par une identité révélée à ce chapitre ou avant">
                    {projection.mergedAway} apparition(s) regroupée(s)
                  </span>
                </>
              )}
            </p>
          </div>

          <Link
            href={`/graph/table?ch=${session.boundaryChapter}`}
            className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Vue tableau
          </Link>
        </div>

        <GraphCanvas projection={projection} />

        <p className="mt-6 text-sm text-muted">
          La taille d&apos;un nœud suit son nombre de relations. La couleur d&apos;un
          lien indique son statut : gris pour un fait affirmé, violet pour une
          déduction, ambre pour une hypothèse. Cliquez un nœud pour ouvrir sa
          fiche.
        </p>
      </main>
    </>
  )
}
