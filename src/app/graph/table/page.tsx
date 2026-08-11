import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { BoundarySlider } from '../boundary-slider.tsx'

export const metadata: Metadata = { title: 'Graphe — vue tableau' }
export const dynamic = 'force-dynamic'

/**
 * The same graph, as tables.
 *
 * Not a degraded fallback — the same projection, read through the same
 * boundary, rendered in a form that works with a screen reader, with keyboard
 * navigation, without WebGL and without a GPU. A force-directed picture is good
 * at showing shape and bad at answering "what exactly is known about this
 * person", which is most of what anyone actually asks.
 *
 * It also serves as the accessibility guarantee for the graph view: because
 * both read `projectGraph`, there is no way for one to show something the other
 * hides.
 */
export default async function GraphTablePage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string }>
}) {
  const { ch } = await searchParams
  const session = await getReaderSession(ch)
  const chapters = await listChapters(session.userId, session.workId)
  const projection = await projectGraph(session.userId, session.boundaryChapter)

  const labelOf = new Map(projection.nodes.map((node) => [node.id, node.label]))
  const byDegree = [...projection.nodes].sort((a, b) => b.degree - a.degree)

  return (
    <>
      <BoundarySlider
        boundaryChapter={session.boundaryChapter}
        maxChapter={session.maxChapter}
        chapters={chapters.filter((c) => c.status === 'published').map((c) => c.number)}
      />

      <main id="contenu" className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-3xl font-semibold text-primary">
            Graphe — vue tableau
          </h1>
          <Link
            href={`/graph?ch=${session.boundaryChapter}`}
            className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Vue graphique
          </Link>
        </div>

        <p className="mt-2 text-sm text-secondary">
          Mêmes données que la vue graphique, au même chapitre. Aucun WebGL requis.
        </p>

        {projection.truncated && (
          <p
            role="status"
            className="mt-4 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-3 text-sm text-primary"
          >
            Liste tronquée : {projection.truncated.shown} entités sur{' '}
            {projection.truncated.total}, les plus connectées d&apos;abord.
          </p>
        )}

        <section className="mt-8">
          <h2 className="text-lg font-semibold text-primary">
            Entités ({projection.nodes.length})
          </h2>

          {projection.nodes.length === 0 ? (
            <p className="mt-3 rounded-sm border border-line bg-surface-raised p-4 text-secondary">
              Rien de connu au chapitre {session.boundaryChapter}.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-sm">
              <caption className="sr-only">
                Entités connues au chapitre {session.boundaryChapter}, par nombre de relations
              </caption>
              <thead>
                <tr className="border-b border-line-strong text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Nom</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Vue depuis</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Relations</th>
                  <th scope="col" className="py-2 font-medium">Apparitions</th>
                </tr>
              </thead>
              <tbody>
                {byDegree.map((node) => (
                  <tr key={node.id} className="border-b border-line">
                    <td className="py-2 pr-3">
                      <Link
                        href={`/entite/${node.id}?ch=${session.boundaryChapter}`}
                        className="text-accent hover:underline"
                      >
                        {node.label}
                      </Link>
                      {node.labelKind === 'placeholder' && (
                        <span
                          className="ml-2 text-xs text-muted"
                          title="Aucun nom donné à ce stade : désignation tirée de l’image"
                        >
                          (sans nom)
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-secondary">{node.nodeType}</td>
                    <td className="py-2 pr-3 font-mono text-secondary">
                      ch. {node.firstSeenChapter}
                    </td>
                    <td className="py-2 pr-3 text-secondary">{node.degree}</td>
                    <td className="py-2 text-secondary">
                      {/* Only interesting once a merge has happened; before
                          that it is always one and says nothing. */}
                      {node.memberIds.length > 1 ? node.memberIds.length : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {projection.edges.length > 0 && (
          <section className="mt-12">
            <h2 className="text-lg font-semibold text-primary">
              Relations ({projection.edges.length})
            </h2>
            <table className="mt-3 w-full border-collapse text-sm">
              <caption className="sr-only">
                Relations connues au chapitre {session.boundaryChapter}
              </caption>
              <thead>
                <tr className="border-b border-line-strong text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Sujet</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Relation</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Objet</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Statut</th>
                  <th scope="col" className="py-2 font-medium">Su depuis</th>
                </tr>
              </thead>
              <tbody>
                {projection.edges.map((edge) => (
                  <tr key={edge.id} className="border-b border-line">
                    <td className="py-2 pr-3 text-primary">
                      {labelOf.get(edge.source) ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-accent">{edge.predicate}</td>
                    <td className="py-2 pr-3 text-primary">
                      {labelOf.get(edge.target) ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-secondary">
                      {epistemicLabel(edge.epistemicStatus)}
                    </td>
                    <td className="py-2 font-mono text-secondary">
                      ch. {edge.knowledgeFromChapter}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
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
