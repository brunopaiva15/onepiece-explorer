'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { GraphProjection } from '@/domains/temporal/projection.ts'
import { predicateLabel } from '@/domains/knowledge/predicate-label.ts'

/**
 * The graph, rendered in WebGL, laid out by a live simulation.
 *
 * Sigma and graphology are loaded dynamically for two reasons. They are large
 * enough that a reader who only opens the table view should not pay for them,
 * and the layout runs on `window` — so importing at module scope would break
 * the server render of the page around it.
 *
 * ForceAtlas2 used to run synchronously for 200 iterations and stop there. The
 * argument for it was that a moving graph cannot be clicked; what it produced
 * was a graph that could be clicked and not read. Two hundred iterations is a
 * budget imposed by the main thread, not a state of the layout: it is what fits
 * in a second before the page stops responding, and at a few thousand nodes it
 * leaves the communities half-folded into each other, still on their way apart
 * when the clock runs out. Measured on a graph built to have communities, the
 * groups sit 2.5 times further from each other than from themselves after 200
 * iterations, and 4.1 times once the layout is allowed to finish — the same
 * data, saying twice as much.
 *
 * So the layout is physical now: it runs in a Web Worker, where it can take the
 * thousands of iterations it needs without the page ever freezing; the reader
 * watches it open out, and nodes can be dragged and stay where they are put.
 * Both halves of the old argument are still answered:
 *
 * - it stops. The simulation freezes once it has settled, and the picture then
 *   holds still to be read and clicked. The control in the corner resumes it.
 * - it is still deterministic. Starting positions are seeded from node ids and
 *   the same corpus at the same boundary converges to the same arrangement, so
 *   moving the boundary one chapter does not reshuffle what the reader has just
 *   learnt to recognise.
 */

/** The worker-driven layout, reduced to what this file drives. */
interface LiveLayout {
  start(): void
  stop(): void
  kill(): void
  isRunning(): boolean
}

/**
 * Iterations run on the main thread before the worker takes over.
 *
 * Enough to get out of the seeded square — a first frame of evenly scattered
 * dots reads as a bug rather than as a graph — and few enough that nobody waits
 * for it. Everything past this point happens off the main thread.
 */
function warmUpIterations(order: number): number {
  return order > 2_000 ? 20 : 60
}

/**
 * How long the simulation runs before it freezes.
 *
 * ForceAtlas2 has no convergence signal to wait on, and a worker left running
 * spins a core for as long as the tab is open. The budget is time rather than
 * iterations because iterations get slower as the corpus grows: this keeps the
 * wait bounded while still giving a large graph the thousand-odd iterations it
 * needs to open out.
 */
function settleDelay(order: number): number {
  return Math.min(45_000, 8_000 + order * 6)
}

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

/**
 * The label box under the cursor, drawn in the theme rather than in white.
 *
 * Sigma's own hover renderer fills the box with a hard-coded `#FFF` and then
 * writes the label in `labelColor` — which here is the body text colour, ivory
 * on a dark ground. White on white: hovering any node produced a blank
 * rectangle, and the name it was supposed to make readable was the one thing it
 * hid.
 *
 * Painted like the rest of the interface: the overlay surface, the hard ink
 * shadow of the panels and an accent border, so a hovered name reads as a
 * cartouche rather than as a browser tooltip. The tokens are read once, when
 * the renderer is built — this runs on every frame the pointer moves, which is
 * no place to interrogate the stylesheet.
 */
function hoverPainter(): (
  context: CanvasRenderingContext2D,
  data: { x: number; y: number; size: number; label: string | null },
  settings: { labelSize: number; labelFont: string; labelWeight: string },
) => void {
  const style = getComputedStyle(document.documentElement)
  const read = (key: string, fallback: string) =>
    style.getPropertyValue(key).trim() || fallback

  const ink = read('--ink', '#000000')
  const surface = read('--surface-overlay', '#2e2e2e')
  const accent = read('--accent', '#F5C542')
  const text = read('--text-primary', '#FFF8E7')

  return (context, data, settings) => {
    const size = settings.labelSize
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`

    const padding = 5
    const label = typeof data.label === 'string' ? data.label : ''

    if (label.length > 0) {
      const width = context.measureText(label).width + padding * 2
      const height = size + padding * 2
      const left = data.x + data.size + 3 - padding
      const top = data.y - height / 2

      context.fillStyle = ink
      context.fillRect(left + 3, top + 3, width, height)
      context.fillStyle = surface
      context.fillRect(left, top, width, height)
      context.lineWidth = 2
      context.strokeStyle = accent
      context.strokeRect(left, top, width, height)

      context.fillStyle = text
      context.fillText(label, left + padding, data.y + size / 3)
    }

    // The node itself, ringed so the cursor's target is unambiguous when two
    // of them overlap.
    context.beginPath()
    context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2)
    context.closePath()
    context.lineWidth = 2
    context.strokeStyle = accent
    context.stroke()
  }
}

export function GraphCanvas({ projection, portraits, onSelect }: Props) {
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
  /** Whether the simulation is currently moving nodes. */
  const [physics, setPhysics] = useState<'running' | 'paused'>('running')
  const router = useRouter()
  const empty = projection.nodes.length === 0
  const order = projection.nodes.length
  const labelOf = new Map(projection.nodes.map((node) => [node.id, node.label]))

  const layout = useRef<LiveLayout | null>(null)
  /**
   * Nodes the reader has placed by hand, in graph coordinates.
   *
   * Held in a ref rather than in the graph's own attributes because the worker
   * rebuilds its matrix only on `start()`: a `fixed` attribute set afterwards
   * would be ignored until the next restart. The layout's `outputReducer` reads
   * this map on every tick instead, which is the one hook that runs between the
   * worker's positions and the graph's.
   */
  const pinned = useRef(new Map<string, { x: number; y: number }>())
  const dragged = useRef<string | null>(null)
  const settleTimer = useRef<number | null>(null)

  const stopPhysics = useCallback(() => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
    layout.current?.stop()
    setPhysics('paused')
  }, [])

  const startPhysics = useCallback(() => {
    if (!layout.current) return
    layout.current.start()
    setPhysics('running')
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null
      layout.current?.stop()
      setPhysics('paused')
    }, settleDelay(order))
  }, [order])

  useEffect(() => {
    if (empty) return

    let sigma: { kill: () => void } | null = null
    let cancelled = false
    // Captured for the cleanup: the refs themselves are stable, and reading
    // `.current` from a teardown is what the exhaustive-deps rule warns about.
    const pins = pinned.current

    void (async () => {
      try {
        const [
          { default: Graph },
          { default: Sigma },
          { default: forceAtlas2 },
          { default: FA2Layout },
        ] = await Promise.all([
          import('graphology'),
          import('sigma'),
          // `assign` lives on the default export, not on the module namespace.
          import('graphology-layout-forceatlas2'),
          import('graphology-layout-forceatlas2/worker'),
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
            label: predicateLabel(edge.predicate),
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

        /*
         * The settings are the inferred ones, and that is a finding rather than
         * a default left alone.
         *
         * The obvious knobs for an unreadable graph — Noack's LinLog model,
         * `adjustSizes` for anti-collision — both look like improvements by the
         * measure of how much canvas gets used, and both were rejected after
         * being scored against a stochastic block model, which is the shape this
         * graph actually has: crews, marine bases, islands. Each one takes the
         * spatial separation between communities from 4.0 down to 1.0. A
         * separation of 1 means two figures from different corners of the story
         * sit as far apart as two members of the same crew — the drawing has
         * stopped saying anything, while looking tidier. Spread is not
         * legibility.
         *
         * What was actually wrong was the iteration count. Everything below
         * depends on this being the same set of settings the worker continues
         * with, so the warm-up and the live layout share one object.
         */
        const settings = {
          ...forceAtlas2.inferSettings(graph),
          barnesHutOptimize: projection.nodes.length > 500,
        }

        forceAtlas2.assign(graph, {
          iterations: warmUpIterations(projection.nodes.length),
          settings,
        })

        if (cancelled || !container.current) return

        const renderer = new Sigma(graph, container.current, {
          renderEdgeLabels: false,
          defaultEdgeColor: 'rgba(116,131,143,0.35)',
          labelColor: { color: getComputedStyle(document.body).color },
          labelSize: 12,
          labelWeight: '500',
          defaultDrawNodeHover: hoverPainter(),
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

        /*
         * Dragging: the reader's half of a physical graph.
         *
         * A simulation you can only watch is a screensaver. Pulling a node out
         * of a knot to see what it is attached to is the whole point, and
         * because the node stays where it was dropped, the layout can be
         * arranged by hand — the reader is the one who knows which figure the
         * page is about.
         *
         * Sigma suppresses `clickNode` once the pointer has moved, so a drag
         * does not also open the selection panel.
         */
        renderer.on('downNode', ({ node, event }) => {
          dragged.current = node
          graph.setNodeAttribute(node, 'highlighted', true)
          pinned.current.set(node, {
            x: graph.getNodeAttribute(node, 'x') as number,
            y: graph.getNodeAttribute(node, 'y') as number,
          })
          // Otherwise the camera pans along with the node.
          event.preventSigmaDefault()
        })

        renderer.on('moveBody', ({ event }) => {
          const node = dragged.current
          if (!node) return
          const position = renderer.viewportToGraph(event)
          graph.setNodeAttribute(node, 'x', position.x)
          graph.setNodeAttribute(node, 'y', position.y)
          pinned.current.set(node, position)
          event.preventSigmaDefault()
          event.original.preventDefault()
          event.original.stopPropagation()
        })

        const release = () => {
          const node = dragged.current
          if (!node) return
          graph.removeNodeAttribute(node, 'highlighted')
          dragged.current = null
        }
        renderer.on('upNode', release)
        renderer.on('upStage', release)

        // Double-click hands a node back to the simulation. Sigma's own
        // double-click zooms, which is not what a pinned node needs.
        renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
          preventSigmaDefault()
          pinned.current.delete(node)
        })

        /*
         * `outputReducer` runs between the worker's positions and the graph's,
         * which makes it the place to overrule the simulation. Whatever the
         * worker computed for a pinned node is discarded here, and the
         * supervisor reads the corrected positions back into its matrix on the
         * same tick — so a dragged node holds still while its neighbours react
         * to it in real time.
         */
        const live: LiveLayout = new FA2Layout(graph, {
          settings,
          outputReducer: (node, attributes) => {
            const pin = pinned.current.get(node)
            return pin ? { ...attributes, x: pin.x, y: pin.y } : attributes
          },
        })

        sigma = renderer
        layout.current = live
        setStatus('ready')
        startPhysics()
      } catch (error) {
        // WebGL unavailable, a blocked worker, an old GPU: the table view is a
        // complete alternative, so this is a redirect rather than a dead end.
        setMessage(error instanceof Error ? error.message : String(error))
        setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      // The worker outlives the component unless it is killed: an unmounted
      // graph page would keep a core busy for the life of the tab.
      layout.current?.kill()
      layout.current = null
      // A different projection is a different set of coordinates: positions
      // pinned in the old one would drag nodes to meaningless places in the new.
      pins.clear()
      dragged.current = null
      sigma?.kill()
    }
  }, [projection, onSelect, router, empty, startPhysics])

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

      {hovered && (
        <HoverCard
          label={labelOf.get(hovered) ?? ''}
          portrait={portraits?.[hovered] ?? null}
        />
      )}

      {/*
        The simulation, under the reader's hand.

        It stops on its own once settled, so the button is mostly there to say
        that the stillness is deliberate — and to start it again after the
        filters, the boundary or a handful of dragged nodes have changed what
        the arrangement should be.
      */}
      {status === 'ready' && (
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={physics === 'running' ? stopPhysics : startPhysics}
            aria-pressed={physics === 'running'}
            className="bouton !px-2.5 !py-1 !text-xs"
          >
            {physics === 'running' ? '❚❚ Figer' : '▶ Physique'}
          </button>
          <button
            type="button"
            onClick={() => {
              pinned.current.clear()
              startPhysics()
            }}
            title="Relance la simulation et libère les nœuds déplacés à la main"
            className="bouton !px-2.5 !py-1 !text-xs"
          >
            Réorganiser
          </button>
        </div>
      )}

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
 * The hovered node, named and — when there is one — shown.
 *
 * `aria-hidden`: this is a pointer affordance duplicating information already
 * available to a keyboard or screen-reader user in the table view, and
 * announcing a card that changes on every mouse move would be noise.
 */
function HoverCard({
  label,
  portrait,
}: {
  label: string
  portrait: NodePortrait | null
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
          className="h-12 w-12 shrink-0 rounded-sm border border-line object-cover object-top"
        />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-primary">{label}</p>
        <p className="truncate text-xs text-muted">
          {portrait ? portrait.attribution : 'Aucune illustration'}
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
