import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { displayImages } from '@/domains/images/index.ts'
import { NODE_TYPES } from '@/domains/knowledge/ontology.ts'
import { GraphExplorer } from './graph-explorer.tsx'

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
    <main id="contenu" className="mx-auto max-w-[1500px] px-4 py-4">
      {/*
       * Counts as figures, the alternative view as a button, and no paragraph
       * explaining the drawing — that legend now lives in the selection panel,
       * where it is read once and then replaced by what you clicked.
       */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h1 className="font-display text-2xl uppercase leading-none text-primary">Graphe</h1>

        <span className="flex items-baseline gap-1.5">
          <span className="chiffre text-2xl">{projection.nodes.length}</span>
          <span className="cartouche">nœuds</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="chiffre text-2xl">{projection.edges.length}</span>
          <span className="cartouche">relations</span>
        </span>
        {projection.mergedAway > 0 && (
          <span
            className="flex items-baseline gap-1.5"
            title="Entités fusionnées par une identité révélée à ce chapitre ou avant"
          >
            <span className="chiffre text-2xl">{projection.mergedAway}</span>
            <span className="cartouche">regroupées</span>
          </span>
        )}

        <Link
          href={`/graph/table?ch=${session.boundaryChapter}`}
          className="bouton ml-auto !py-1 !text-sm"
        >
          Vue tableau
        </Link>
      </div>

      {projection.truncated && (
        <p
          role="status"
          className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-1.5 text-sm text-ink"
        >
          Graphe tronqué : {projection.truncated.shown} nœuds sur{' '}
          {projection.truncated.total}. Les plus connectés sont conservés :
          c&apos;est l&apos;ossature de l&apos;histoire. Filtrez par type pour
          voir le reste.
        </p>
      )}

      <div className="mt-4">
        <GraphExplorer
          projection={projection}
          portraits={portraits}
          nodeTypes={NODE_TYPES.map((t) => ({ key: t.key, labelFr: t.labelFr }))}
          boundaryChapter={session.boundaryChapter}
          active={nodeTypes ?? []}
        />
      </div>
    </main>
  )
}
