'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { GraphProjection } from '@/domains/temporal/projection.ts'
import { type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

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

/** What the hover card needs: a signed thumbnail and where it came from. */
export interface NodePortrait {
  thumbUrl: string
  attribution: string
}

interface Props {
  projection: GraphProjection
  /**
   * Portraits by node id, for the hover card.
   *
   * Signed server-side and passed in rather than fetched here: a client
   * component cannot mint a signed URL, and it must not be able to — that is
   * what keeps the boundary check and the ownership check on the server.
   */
  portraits?: Record<string, NodePortrait>
  onSelect?: (nodeId: string) => void
  locale: Locale
}

/**
 * A type's colour, resolved from the stylesheet at draw time.
 *
 * WebGL needs a literal, so this map used to be hard-coded here — and it was
 * still carrying the palette from two redesigns ago while the badges and the
 * selection panel had moved on. Reading the custom property means one
 * definition for every surface that colours a type, and it follows the theme
 * without a second table to keep in step.
 */
function typeColours(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const read = (key: string): string =>
    style.getPropertyValue(`--type-${key}`).trim() || '#74838f'

  return Object.fromEntries(
    [
      'character',
      'group',
      'place',
      'object',
      'power',
      'species',
      'event',
      'battle',
      'voyage',
      'concept',
      'mystery',
      'chapter',
      'page',
      'panel',
    ].map((key) => [key, read(key)]),
  )
}

export function GraphCanvas({ projection, portraits, onSelect, locale }: Props) {
  const t = getDictFor(locale).entity
  const container = useRef<HTMLDivElement | null>(null)
  /**
   * 'empty' is not in here on purpose: an empty projection is derived data, and
   * storing it as state would mean setting state from the effect body for
   * something the props already say.
   */
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  /**
   * The node under the cursor.
   *
   * A card in a fixed corner rather than a tooltip following the pointer: a
   * floating element chasing the mouse across a force-directed graph covers the
   * nodes you are trying to compare, which is the one thing you are doing when
   * you hover them.
   */
  const [hovered, setHovered] = useState<string | null>(null)
  const router = useRouter()
  const empty = projection.nodes.length === 0
  const labelOf = new Map(projection.nodes.map((node) => [node.id, node.label]))

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

        const colours = typeColours()

        for (const node of projection.nodes) {
          graph.addNode(node.id, {
            label: node.label,
            // Degree-based sizing: the reader's eye should land on the
            // characters the story keeps returning to.
            size: 4 + Math.min(14, Math.sqrt(node.degree) * 2.5),
            color: colours[node.nodeType] ?? '#74838f',
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

        renderer.on('enterNode', ({ node }) => setHovered(node))
        renderer.on('leaveNode', () => setHovered(null))

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
        {t.emptyGraph}
      </p>
    )
  }

  return (
    <div className="relative mt-4">
      <div
        ref={container}
        className="h-[70vh] w-full rounded-sm border border-line bg-surface-raised"
        role="img"
        aria-label={t.canvasAria(
          projection.nodes.length,
          projection.edges.length,
          projection.boundaryChapter,
        )}
      />

      {hovered && (
        <HoverCard
          label={labelOf.get(hovered) ?? ''}
          portrait={portraits?.[hovered] ?? null}
          noIllustration={t.noIllustration}
        />
      )}

      {status === 'loading' && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
          {t.computingLayout}
        </p>
      )}

      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-primary">{t.webglFailed}</p>
          <p className="max-w-md text-sm text-secondary">
            {message}
            {' — '}
            {t.webglFailedTail}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The hovered node, named and — when there is one — shown.
 *
 * `aria-hidden`: this is a pointer affordance duplicating information already
 * available to a keyboard or screen-reader user in the table view, and
 * announcing a card that changes on every mouse move would be noise.
 */
function HoverCard({
  label,
  portrait,
  noIllustration,
}: {
  label: string
  portrait: NodePortrait | null
  noIllustration: string
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-3 top-3 flex max-w-64 items-center gap-2.5 rounded-sm border border-line-strong bg-surface-overlay/95 p-2 shadow-lg"
    >
      {portrait && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={portrait.thumbUrl}
          alt=""
          width={48}
          height={48}
          className="h-12 w-12 shrink-0 rounded-sm border border-line object-cover"
        />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-primary">{label}</p>
        <p className="truncate text-xs text-muted">
          {portrait ? portrait.attribution : noIllustration}
        </p>
      </div>
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
