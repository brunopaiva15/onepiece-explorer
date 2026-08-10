'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { GraphProjection } from '@/domains/temporal/projection.ts'

/**
 * The graph, rendered in WebGL.
 *
 * Sigma and graphology are loaded dynamically for two reasons. They are large
 * enough that a reader who only opens the table view should not pay for them,
 * and the layout runs on `window` — so importing at module scope would break
 * the server render of the page around it.
 *
 * ForceAtlas2 runs synchronously for a bounded number of iterations rather than
 * as a live animation. A settling layout looks impressive and makes the graph
 * unusable while it moves: you cannot click a node that is still drifting, and
 * the reader's mental map is rebuilt every frame. A fixed number of iterations
 * gives the same arrangement every time for the same data, which also means
 * moving the boundary by one chapter does not reshuffle the whole picture.
 */

interface Props {
  projection: GraphProjection
  /** Colour per node type, from the design tokens. */
  onSelect?: (nodeId: string) => void
}

const TYPE_COLOURS: Record<string, string> = {
  character: '#a8622a',
  group: '#2f6f6b',
  place: '#b08430',
  object: '#7a5ea8',
  power: '#b4552d',
  species: '#4a5a68',
  event: '#2d6a4f',
  battle: '#8a4d1e',
  voyage: '#5aa9a3',
  concept: '#74838f',
  mystery: '#d08c4a',
}

export function GraphCanvas({ projection, onSelect }: Props) {
  const container = useRef<HTMLDivElement | null>(null)
  /**
   * 'empty' is not in here on purpose: an empty projection is derived data, and
   * storing it as state would mean setting state from the effect body for
   * something the props already say.
   */
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const router = useRouter()
  const empty = projection.nodes.length === 0

  useEffect(() => {
    if (empty) return

    let sigma: { kill: () => void } | null = null
    let cancelled = false

    void (async () => {
      try {
        const [{ default: Graph }, { default: Sigma }, { default: forceAtlas2 }] =
          await Promise.all([
            import('graphology'),
            import('sigma'),
            // `assign` lives on the default export, not on the module namespace.
            import('graphology-layout-forceatlas2'),
          ])

        if (cancelled || !container.current) return

        const graph = new Graph({ multi: false, type: 'undirected' })

        for (const node of projection.nodes) {
          graph.addNode(node.id, {
            label: node.label,
            // Degree-based sizing: the reader's eye should land on the
            // characters the story keeps returning to.
            size: 4 + Math.min(14, Math.sqrt(node.degree) * 2.5),
            color: TYPE_COLOURS[node.nodeType] ?? '#74838f',
            nodeType: node.nodeType,
            // Seeded deterministically from the id so the pre-layout positions
            // are the same on every render. Math.random() here would make the
            // settled layout differ between two loads of identical data.
            x: pseudoRandom(node.id, 1),
            y: pseudoRandom(node.id, 2),
          })
        }

        for (const edge of projection.edges) {
          if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
          if (graph.hasEdge(edge.source, edge.target)) continue
          graph.addEdge(edge.source, edge.target, {
            label: edge.predicate,
            size: Math.min(4, edge.weight),
            // A hypothesis and an explicit fact must not look alike: the whole
            // epistemic model would be invisible if they did.
            color:
              edge.epistemicStatus === 'hypothetical'
                ? 'rgba(176,132,48,0.45)'
                : edge.epistemicStatus === 'inferred_strong'
                  ? 'rgba(122,94,168,0.45)'
                  : 'rgba(116,131,143,0.35)',
            type: edge.epistemicStatus === 'hypothetical' ? 'line' : 'line',
          })
        }

        // Bounded iterations, scaled down for large graphs so the wait stays
        // roughly constant rather than growing with the corpus.
        const iterations = projection.nodes.length > 800 ? 80 : 200
        forceAtlas2.assign(graph, {
          iterations,
          settings: {
            ...forceAtlas2.inferSettings(graph),
            barnesHutOptimize: projection.nodes.length > 500,
          },
        })

        if (cancelled || !container.current) return

        const renderer = new Sigma(graph, container.current, {
          renderEdgeLabels: false,
          defaultEdgeColor: 'rgba(116,131,143,0.35)',
          labelColor: { color: getComputedStyle(document.body).color },
          labelSize: 12,
          labelWeight: '500',
          // Below this zoom, labels would overlap into an unreadable mat.
          labelRenderedSizeThreshold: 7,
          minCameraRatio: 0.05,
          maxCameraRatio: 4,
        })

        renderer.on('clickNode', ({ node }) => {
          if (onSelect) onSelect(node)
          else router.push(`/entite/${node}`)
        })

        sigma = renderer
        setStatus('ready')
      } catch (error) {
        // WebGL unavailable, a blocked worker, an old GPU: the table view is a
        // complete alternative, so this is a redirect rather than a dead end.
        setMessage(error instanceof Error ? error.message : String(error))
        setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
      sigma?.kill()
    }
  }, [projection, onSelect, router, empty])

  if (empty) {
    return (
      <p className="mt-8 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
        Rien de connu à ce chapitre. Remontez le curseur, ou importez et publiez
        un chapitre.
      </p>
    )
  }

  return (
    <div className="relative mt-4">
      <div
        ref={container}
        className="h-[70vh] w-full rounded-sm border border-line bg-surface-raised"
        role="img"
        aria-label={`Graphe de ${projection.nodes.length} nœuds et ${projection.edges.length} relations au chapitre ${projection.boundaryChapter}`}
      />

      {status === 'loading' && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
          Calcul de la disposition…
        </p>
      )}

      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-primary">Le rendu WebGL a échoué.</p>
          <p className="max-w-md text-sm text-secondary">
            {message}
            {' — '}la vue tableau contient exactement les mêmes données et ne
            demande pas de GPU.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * A deterministic coordinate from a node id.
 *
 * Not for randomness — for stability. ForceAtlas2 converges to different
 * arrangements from different starting points, so seeding from `Math.random()`
 * would give a visibly different graph on every reload of identical data, and
 * moving the boundary one chapter would reshuffle everything the reader had
 * just learned to recognise.
 */
function pseudoRandom(seed: string, salt: number): number {
  let hash = 2_166_136_261 ^ salt
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16_777_619)
  }
  return ((hash >>> 0) % 10_000) / 100
}
