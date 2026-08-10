import 'server-only'
import { projectGraph, type GraphProjection } from '../temporal/projection.ts'
import type { SearchHit } from './types.ts'

/**
 * Graph traversal: neighbourhoods and shortest paths.
 *
 * Built on `projectGraph` rather than on a recursive SQL CTE, and that is a
 * correctness choice rather than a convenience one. The projection has already
 * applied the boundary *and* the union-find over visible `same_as` assertions.
 * A CTE walking the `assertions` table directly would traverse the raw rows and
 * therefore treat two halves of a merged character as two nodes — giving a
 * different answer from the graph the reader is looking at, on the same screen.
 *
 * The cost is holding the projection in memory. At the sizes this product
 * reaches — the whole work is on the order of 20 000 nodes — that is a few
 * megabytes and a breadth-first walk over an adjacency map, which is faster
 * than the round trips a CTE would need anyway.
 */

export interface Neighbourhood {
  centre: string
  /** Distance in hops from the centre, keyed by node id. */
  distances: Map<string, number>
  projection: GraphProjection
}

function adjacency(projection: GraphProjection): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const node of projection.nodes) map.set(node.id, new Set())
  for (const edge of projection.edges) {
    map.get(edge.source)?.add(edge.target)
    map.get(edge.target)?.add(edge.source)
  }
  return map
}

/**
 * Everything within `hops` of an entity, as the reader currently knows it.
 *
 * Breadth-first, so `distances` is the true hop count and not whatever order a
 * depth-first walk happened to find first — the distance is displayed, and a
 * wrong one would claim two characters are closer than the story makes them.
 */
export async function neighbourhood(
  userId: string,
  boundaryChapter: number,
  entityId: string,
  hops = 2,
): Promise<Neighbourhood | null> {
  const projection = await projectGraph(userId, boundaryChapter)

  // The requested entity may have been folded into another node by a merge the
  // reader has now seen. Resolving through memberIds means a link built at
  // chapter 20 still works at chapter 300.
  const centre = projection.nodes.find(
    (node) => node.id === entityId || node.memberIds.includes(entityId),
  )
  if (!centre) return null

  const links = adjacency(projection)
  const distances = new Map<string, number>([[centre.id, 0]])
  let frontier = [centre.id]

  for (let depth = 1; depth <= hops; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of links.get(id) ?? []) {
        if (distances.has(neighbour)) continue
        distances.set(neighbour, depth)
        next.push(neighbour)
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  return { centre: centre.id, distances, projection }
}

/**
 * The shortest chain of relations between two entities.
 *
 * Unweighted breadth-first rather than Dijkstra: every relation is one step,
 * because there is no honest weight to put on them. Confidence would be the
 * tempting choice and it is wrong — a low-confidence relation is not a *longer*
 * connection, it is a less certain one, and conflating the two would quietly
 * route the reader around exactly the links they should be looking at.
 */
export interface PathStep {
  from: string
  to: string
  predicate: string
  chapterNumber: number
}

export async function shortestPath(
  userId: string,
  boundaryChapter: number,
  fromId: string,
  toId: string,
  maxHops = 6,
): Promise<{ steps: PathStep[]; labels: Map<string, string> } | null> {
  const projection = await projectGraph(userId, boundaryChapter)
  const resolve = (id: string): string | undefined =>
    projection.nodes.find((node) => node.id === id || node.memberIds.includes(id))?.id

  const start = resolve(fromId)
  const goal = resolve(toId)
  if (!start || !goal) return null

  const labels = new Map(projection.nodes.map((node) => [node.id, node.label]))
  if (start === goal) return { steps: [], labels }

  // Keep the edge that produced each hop, so the path can be read as sentences
  // rather than as a list of names with the relations left out.
  const edgeBetween = new Map<string, (typeof projection.edges)[number]>()
  const links = new Map<string, string[]>()
  for (const node of projection.nodes) links.set(node.id, [])
  for (const edge of projection.edges) {
    links.get(edge.source)?.push(edge.target)
    links.get(edge.target)?.push(edge.source)
    edgeBetween.set(`${edge.source}|${edge.target}`, edge)
    edgeBetween.set(`${edge.target}|${edge.source}`, edge)
  }

  const cameFrom = new Map<string, string>()
  const seen = new Set([start])
  let frontier = [start]

  for (let depth = 0; depth < maxHops && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const neighbour of links.get(id) ?? []) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        cameFrom.set(neighbour, id)
        if (neighbour === goal) {
          return { steps: rebuild(cameFrom, edgeBetween, start, goal), labels }
        }
        next.push(neighbour)
      }
    }
    frontier = next
  }

  // No path within the limit is a real answer: at this chapter, the reader has
  // no reason to connect these two.
  return null
}

function rebuild(
  cameFrom: Map<string, string>,
  edges: Map<string, { predicate: string; knowledgeFromChapter: number }>,
  start: string,
  goal: string,
): PathStep[] {
  const chain: string[] = [goal]
  let cursor = goal
  while (cursor !== start) {
    const previous = cameFrom.get(cursor)
    if (!previous) break
    chain.unshift(previous)
    cursor = previous
  }

  const steps: PathStep[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    const from = chain[i]!
    const to = chain[i + 1]!
    const edge = edges.get(`${from}|${to}`)
    steps.push({
      from,
      to,
      predicate: edge?.predicate ?? 'lié à',
      chapterNumber: edge?.knowledgeFromChapter ?? 0,
    })
  }
  return steps
}

/**
 * Expand a set of entity hits with their immediate neighbours.
 *
 * This is what makes the assistant able to answer "who does X travel with"
 * rather than only "what is X". The neighbours are ranked below the direct hits
 * and say plainly that they are one step away, because a neighbour presented at
 * the same weight as a match is a result the reader did not ask for.
 */
export async function expandNeighbours(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
  limit = 20,
): Promise<SearchHit[]> {
  if (entityIds.length === 0) return []

  const projection = await projectGraph(userId, boundaryChapter)
  const links = adjacency(projection)
  const byId = new Map(projection.nodes.map((node) => [node.id, node]))

  const roots = new Set(
    entityIds
      .map(
        (id) =>
          projection.nodes.find(
            (node) => node.id === id || node.memberIds.includes(id),
          )?.id,
      )
      .filter((id): id is string => id !== undefined),
  )

  const hits: SearchHit[] = []
  const seen = new Set(roots)

  for (const root of roots) {
    const rootLabel = byId.get(root)?.label ?? 'une entité'
    for (const neighbour of links.get(root) ?? []) {
      if (seen.has(neighbour)) continue
      seen.add(neighbour)
      const node = byId.get(neighbour)
      if (!node) continue

      hits.push({
        kind: 'entity',
        id: node.id,
        entityId: node.id,
        title: node.label,
        snippet: node.label,
        chapterNumber: node.firstSeenChapter,
        // Degree-normalised so a hub does not outrank a genuinely close
        // relation simply by being connected to everything.
        score: 1 / (1 + Math.log1p(node.degree)),
        mode: 'graph',
        reason: `En relation directe avec « ${rootLabel} ».`,
      })

      if (hits.length >= limit) return hits
    }
  }

  return hits
}
