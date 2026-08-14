'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type { GraphProjection } from '@/domains/temporal/projection.ts'
import { GraphCanvas } from './graph-canvas.tsx'
import { nodeTypeLabel, predicateLabel } from '@/domains/knowledge/predicate-label.ts'

/**
 * The graph, with somewhere to put what you clicked.
 *
 * The page's central failure was not visual: **clicking a node navigated
 * away**. You spend a minute finding a figure in eight thousand nodes, click
 * it, and lose the view — position, zoom, filters, all of it — to read four
 * lines you could have seen in place. Coming back means finding it again.
 *
 * A graph explorer needs a selection panel. Click puts the node in the aside:
 * its type, when it first appeared, how many relations it has, who they are.
 * The full sheet is one link away for when you actually want to leave.
 *
 * Neighbours are computed here rather than fetched, because the projection
 * already carries every visible edge — it is what drew them. A round-trip per
 * click would add latency to the one interaction that has to feel instant, and
 * would be able to disagree with the picture on screen.
 */

interface Props {
  projection: GraphProjection
  portraits: Record<string, { thumbUrl: string; attribution: string }>
  nodeTypes: Array<{ key: string; labelFr: string }>
  boundaryChapter: number
  /** Types currently filtered in, from the query string. Empty means all. */
  active: string[]
}

/**
 * One source for a type's colour: the stylesheet.
 *
 * A second map here would drift from the badges and the table view, and the
 * whole value of colouring a type is that it means the same thing everywhere.
 */
function typeColour(key: string): string {
  return `var(--type-${key}, var(--surface-sunken))`
}


export function GraphExplorer({
  projection,
  portraits,
  nodeTypes,
  boundaryChapter,
  active,
}: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const byId = useMemo(
    () => new Map(projection.nodes.map((node) => [node.id, node])),
    [projection.nodes],
  )

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null

  /** Every visible relation touching the selection, with the node at its far end. */
  const neighbours = useMemo(() => {
    if (!selectedId) return []
    return projection.edges
      .filter((edge) => edge.source === selectedId || edge.target === selectedId)
      .map((edge) => {
        const otherId = edge.source === selectedId ? edge.target : edge.source
        return {
          edgeId: edge.id,
          predicate: edge.predicate,
          outgoing: edge.source === selectedId,
          chapter: edge.knowledgeFromChapter,
          status: edge.epistemicStatus,
          other: byId.get(otherId) ?? null,
        }
      })
      .sort((a, b) => a.chapter - b.chapter)
  }, [selectedId, projection.edges, byId])

  function toggleType(key: string): void {
    const next = active.includes(key)
      ? active.filter((t) => t !== key)
      : [...active, key]
    const query = new URLSearchParams(params.toString())
    if (next.length === 0) query.delete('type')
    else query.set('type', next.join(','))
    router.replace(`/graph?${query.toString()}`, { scroll: false })
  }

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const node of projection.nodes) {
      map.set(node.nodeType, (map.get(node.nodeType) ?? 0) + 1)
    }
    return map
  }, [projection.nodes])

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0">
        {/* Filters as chips: the ?type= parameter existed and had no control,
            so the only way to use it was to edit the URL by hand. */}
        <div className="flex flex-wrap gap-1.5">
          {nodeTypes.map((type) => {
            const on = active.length === 0 || active.includes(type.key)
            const count = counts.get(type.key) ?? 0
            return (
              <button
                key={type.key}
                type="button"
                onClick={() => toggleType(type.key)}
                aria-pressed={active.includes(type.key)}
                className={`badge ${on ? '' : 'opacity-40'}`}
                style={on ? { background: typeColour(type.key), color: '#fff' } : undefined}
              >
                {type.labelFr}
                <span className="tabular opacity-80">{count}</span>
              </button>
            )
          })}
          {active.length > 0 && (
            <button type="button" onClick={() => router.replace('/graph')} className="badge badge-gris">
              tout afficher
            </button>
          )}
        </div>

        <GraphCanvas
          projection={projection}
          portraits={portraits}
          onSelect={(id) => setSelectedId(id)}
        />
      </div>

      {/* --- Selection ---------------------------------------------------- */}
      <aside className="panneau self-start lg:sticky lg:top-[9.5rem]">
        {!selected ? (
          <>
            <h2 className="panneau-titre">Sélection</h2>
            <div className="panneau-corps text-sm text-secondary">
              <p>Cliquez un nœud : sa fiche s&apos;ouvre ici, sans quitter le graphe.</p>
              <hr className="regle my-3" />
              <p className="cartouche">Lire le dessin</p>
              <ul className="mt-1 space-y-1">
                <li>La taille suit le nombre de relations.</li>
                <li>
                  <span style={{ color: 'var(--epi-inferred)' }}>Violet</span> : déduction.{' '}
                  <span style={{ color: 'var(--epi-hypothetical)' }}>Ambre</span> : hypothèse.
                  Gris : fait affirmé.
                </li>
                <li>
                  La disposition est physique : elle s&apos;organise, puis se
                  fige pour être lue. Glissez un nœud pour le placer — il y
                  reste ; double-cliquez-le pour le rendre à la simulation.
                </li>
              </ul>
            </div>
          </>
        ) : (
          <>
            <h2 className="panneau-titre panneau-titre-vedette">
              <span className="truncate">{selected.label}</span>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Fermer la sélection"
                className="font-sans text-lg leading-none"
              >
                ✕
              </button>
            </h2>
            <div className="panneau-corps">
              <div className="flex gap-3">
                {portraits[selected.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={portraits[selected.id]!.thumbUrl}
                    alt=""
                    className="h-20 w-20 shrink-0 border-[3px] border-ink object-cover object-top"
                  />
                ) : (
                  <div className="flex h-20 w-20 shrink-0 items-center justify-center border-[3px] border-ink bg-surface-sunken">
                    <span className="chiffre text-3xl text-muted">
                      {selected.label.slice(0, 1).toUpperCase()}
                    </span>
                  </div>
                )}
                <div className="min-w-0">
                  <span
                    className="badge"
                    style={{ background: typeColour(selected.nodeType), color: '#fff' }}
                  >
                    {nodeTypeLabel(selected.nodeType)}
                  </span>
                  <p className="mt-1.5 text-sm text-secondary">
                    <span className="cartouche block">1re apparition</span>
                    <span className="chiffre text-xl">ch. {selected.firstSeenChapter}</span>
                  </p>
                </div>
              </div>

              <div className="mt-3 flex gap-4">
                <span>
                  <span className="cartouche block">Relations</span>
                  <span className="chiffre text-xl">{selected.degree}</span>
                </span>
                {selected.memberIds.length > 1 && (
                  <span title="Apparitions distinctes identifiées comme une seule">
                    <span className="cartouche block">Fusionnées</span>
                    <span className="chiffre text-xl">{selected.memberIds.length}</span>
                  </span>
                )}
              </div>

              {neighbours.length > 0 && (
                <>
                  <hr className="regle my-3" />
                  <p className="cartouche">Relations visibles</p>
                  <ul className="mt-1.5 max-h-64 space-y-1.5 overflow-y-auto text-sm">
                    {neighbours.map((link) => (
                      <li key={link.edgeId} className="flex items-baseline gap-2">
                        <span className="tabular shrink-0 text-xs text-muted">
                          {link.chapter}
                        </span>
                        <span className="min-w-0">
                          <span className="text-muted">
                            {link.outgoing ? '' : '← '}
                            {predicateLabel(link.predicate)}
                            {link.outgoing ? ' →' : ''}{' '}
                          </span>
                          {link.other ? (
                            <button
                              type="button"
                              onClick={() => setSelectedId(link.other!.id)}
                              className="text-left text-primary underline decoration-[var(--accent)] decoration-2 underline-offset-2"
                            >
                              {link.other.label}
                            </button>
                          ) : (
                            <span className="text-muted">hors du graphe affiché</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <Link
                href={`/entite/${selected.id}?ch=${boundaryChapter}`}
                className="bouton bouton-primaire mt-4 w-full !text-sm"
              >
                Ouvrir la fiche complète
              </Link>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
