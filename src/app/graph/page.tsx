import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { displayImages } from '@/domains/images/index.ts'
import { GraphCanvas } from './graph-canvas.tsx'

export const metadata: Metadata = { title: 'Graphe' }
export const dynamic = 'force-dynamic'

/**
 * How many nodes get a pre-signed portrait for the hover card.
 *
 * Ranked by degree, so the ones covered are the ones the eye lands on. Raising
 * this costs a signed URL per node on every page load; the cost is not in the
 * pictures, which are cached, but in the signing.
 */
const HOVERABLE_NODES = 400

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; type?: string }>
}) {
  const { ch, type } = await searchParams
  // The boundary is resolved and clamped server-side. A value from the query
  // string is untrusted input, and one that widened what the reader can see
  // would be the whole product failing at once.
  const session = await getViewerSession(ch)

  const nodeTypes = type ? type.split(',').filter(Boolean) : undefined
  const projection = await projectGraph(session.userId, session.boundaryChapter, {
    ...(nodeTypes ? { nodeTypes } : {}),
  })

  /*
   * Portraits for the nodes a reader is likely to hover, signed here.
   *
   * Capped by degree because each one is a signed URL with a lifetime measured
   * in seconds: minting eight thousand of them per page load would be slow and
   * would waste all but a handful. The hover card says "aucune illustration"
   * for the rest, which is true of most of them anyway.
   */
  const hoverable = [...projection.nodes]
    .sort((a, b) => b.degree - a.degree)
    .slice(0, HOVERABLE_NODES)
  const images = await displayImages(
    session.userId,
    session.boundaryChapter,
    hoverable.flatMap((node) => node.memberIds),
  )

  const portraits: Record<string, { thumbUrl: string; attribution: string }> = {}
  for (const node of hoverable) {
    for (const memberId of node.memberIds) {
      const found = images.get(memberId)
      if (found) {
        portraits[node.id] = {
          thumbUrl: found.thumbUrl,
          attribution: found.attribution,
        }
        break
      }
    }
  }

  return (
    <>

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

        {projection.truncated && (
          <p
            role="status"
            className="mt-4 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-3 text-sm text-primary"
          >
            Graphe tronqué : {projection.truncated.shown} nœuds affichés sur{' '}
            {projection.truncated.total}. Les plus connectés sont conservés —
            c&apos;est l&apos;ossature de l&apos;histoire, pas ses premiers
            chapitres. Filtrez par type pour voir le reste.
          </p>
        )}

        <GraphCanvas projection={projection} portraits={portraits} />

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
