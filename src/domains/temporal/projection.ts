import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary, type BoundaryDb } from '@/db/boundary.ts'

/**
 * The graph, as it stood at one chapter.
 *
 * Everything here reads through `withBoundary`, so the filtering is the
 * database's job and not this file's. What this file adds is the one thing row
 * -level security cannot express: identity.
 *
 * A merge is not an operation on rows — it is a `same_as` assertion with its own
 * revelation chapter. So the set of nodes at chapter N is the set of entities
 * *modulo* the `same_as` assertions visible at N, computed by union-find over
 * exactly those. At chapter 20 the two silhouettes are two components; at
 * chapter 300, when the assertion that identifies them becomes visible, they
 * collapse into one. Nothing was destroyed to make that happen, and lowering the
 * slider brings both nodes back.
 *
 * That is the whole reason this is a projection rather than a stored graph. A
 * stored graph has to be rebuilt on every merge and cannot answer "what did I
 * know at chapter 20" once it has been. This can answer it for any N, including
 * ones the reader has never selected.
 */

export interface GraphNode {
  /** The component's representative — stable for a given boundary. */
  id: string
  /** Every entity id folded into this node at this boundary. */
  memberIds: string[]
  nodeType: string
  /** Highest-precedence label revealed at or before the boundary. */
  label: string
  labelKind: string
  firstSeenChapter: number
  /** How many visible relations touch it. Drives sizing and level of detail. */
  degree: number
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  predicate: string
  epistemicStatus: string
  knowledgeFromChapter: number
  confidence: number
  /** Set when several assertions collapsed onto the same node pair. */
  weight: number
}

export interface GraphProjection {
  boundaryChapter: number
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Entities hidden because their component representative is another node. */
  mergedAway: number
  /**
   * Set when the node cap was reached, so the caller can say so.
   *
   * Never null-and-silent. A graph that is quietly missing three quarters of
   * the work looks exactly like a graph that has all of it, and the reader has
   * no way to tell — which is the same failure mode as a spoiler, pointed the
   * other way.
   */
  truncated: { shown: number; total: number } | null
}

/**
 * Union-find over the `same_as` assertions visible at the boundary.
 *
 * Deliberately in TypeScript rather than a recursive CTE. The set of visible
 * identity assertions is small — merges are rare and every one passed a human —
 * so the cost is trivial, while a recursive CTE would have to re-derive the
 * boundary predicate inside itself and could drift out of step with the policy
 * that RLS applies. Reading the already-filtered rows means the two can never
 * disagree.
 */
class UnionFind {
  private readonly parent = new Map<string, string>()

  find(id: string): string {
    const seen = this.parent.get(id)
    if (seen === undefined) {
      this.parent.set(id, id)
      return id
    }
    if (seen === id) return id
    const root = this.find(seen)
    // Path compression: a long merge chain is resolved once, not per lookup.
    this.parent.set(id, root)
    return root
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    /*
     * Smaller id wins, always.
     *
     * Any deterministic tie-break would do, but it has to *be* deterministic:
     * the representative becomes the node id the interface renders, and a
     * representative that changed between two reads at the same boundary would
     * make the graph jump under the reader for no reason.
     */
    if (rootA < rootB) this.parent.set(rootB, rootA)
    else this.parent.set(rootA, rootB)
  }

  members(): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      const group = groups.get(root)
      if (group) group.push(id)
      else groups.set(root, [id])
    }
    return groups
  }
}

interface EntityRow extends Record<string, unknown> {
  id: string
  node_type: string
  first_seen_chapter: number
}

interface LabelRow extends Record<string, unknown> {
  entity_id: string
  label: string
  kind: string
  precedence: number
  revealed_in_chapter: number
}

interface AssertionRow extends Record<string, unknown> {
  id: string
  subject_entity_id: string
  object_entity_id: string | null
  predicate: string
  epistemic_status: string
  knowledge_from_chapter: number
  confidence: number
}

/**
 * The node cap.
 *
 * Sized for the finished work: ADR 0005 puts it at roughly 20 000 nodes after
 * ~1 100 chapters, and the measured projection cost is around 0.05 ms per node,
 * so the whole thing lands comfortably inside a request.
 *
 * It was 5 000, which the perf corpus exposed as a silent truncation: at 8 000
 * entities the projection returned 4 898 and said nothing. Worse, it ordered by
 * `first_seen_chapter`, so a truncated graph was the *earliest* nodes — the
 * story appeared to stop a quarter of the way through while looking complete.
 */
const DEFAULT_NODE_CAP = 25_000

export async function projectGraph(
  userId: string,
  boundaryChapter: number,
  options: { nodeTypes?: string[]; limit?: number } = {},
): Promise<GraphProjection> {
  const limit = options.limit ?? DEFAULT_NODE_CAP

  return withBoundary({ userId, boundaryChapter }, async (db) => {
    const [counted] = await db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM entities
    `)
    const total = Number(counted?.total ?? 0)

    /*
     * Ordered by degree, so a capped view is the backbone of the story rather
     * than its first chapters. If the cap is ever hit, the reader gets the
     * characters everything connects through — which is the useful subset — and
     * is told the count.
     */
    const entities = await db.execute<EntityRow>(sql`
      SELECT e.id, e.node_type, e.first_seen_chapter
      FROM entities e
      LEFT JOIN (
        SELECT subject_entity_id AS id, count(*) AS n FROM assertions GROUP BY 1
        UNION ALL
        SELECT object_entity_id AS id, count(*) AS n FROM assertions
        WHERE object_entity_id IS NOT NULL GROUP BY 1
      ) d ON d.id = e.id
      GROUP BY e.id, e.node_type, e.first_seen_chapter
      ORDER BY coalesce(sum(d.n), 0) DESC, e.first_seen_chapter, e.id
      LIMIT ${limit}
    `)

    const labels = await db.execute<LabelRow>(sql`
      SELECT entity_id, label, kind::text AS kind, precedence, revealed_in_chapter
      FROM entity_labels
      ORDER BY precedence DESC, revealed_in_chapter DESC
    `)

    const assertions = await db.execute<AssertionRow>(sql`
      SELECT id, subject_entity_id, object_entity_id, predicate,
             epistemic_status::text AS epistemic_status,
             knowledge_from_chapter, confidence
      FROM assertions
      WHERE object_entity_id IS NOT NULL
    `)

    const projection = assemble(
      boundaryChapter,
      entities,
      labels,
      assertions,
      options.nodeTypes,
    )

    return {
      ...projection,
      truncated:
        entities.length < total ? { shown: entities.length, total } : null,
    }
  })
}

/**
 * Fold the filtered rows into nodes and edges.
 *
 * Split out from the query so it can be tested on constructed rows without a
 * database, and so the union-find logic is readable without the SQL around it.
 */
export function assemble(
  boundaryChapter: number,
  entities: EntityRow[],
  labels: LabelRow[],
  assertions: AssertionRow[],
  nodeTypes?: string[],
): GraphProjection {
  const identity = new UnionFind()
  for (const entity of entities) identity.find(entity.id)

  /*
   * Only `same_as` merges. `maybe_same_as` is a proposal the user has not
   * confirmed as an identity, and folding on it would mean a suggestion changed
   * the graph — the exact failure the review step exists to prevent.
   */
  for (const assertion of assertions) {
    if (assertion.predicate !== 'same_as') continue
    if (!assertion.object_entity_id) continue
    identity.union(assertion.subject_entity_id, assertion.object_entity_id)
  }

  const groups = identity.members()
  const rootOf = new Map<string, string>()
  for (const [root, members] of groups) {
    for (const member of members) rootOf.set(member, root)
  }

  const entityById = new Map(entities.map((entity) => [entity.id, entity]))

  // Best visible label per entity. The rows arrive already ordered by
  // precedence then recency, so the first one wins.
  const labelOf = new Map<string, LabelRow>()
  for (const label of labels) {
    if (!labelOf.has(label.entity_id)) labelOf.set(label.entity_id, label)
  }

  const degree = new Map<string, number>()
  const edges: GraphEdge[] = []
  const edgeByPair = new Map<string, GraphEdge>()

  for (const assertion of assertions) {
    if (!assertion.object_entity_id) continue
    // A merge is what produced the node; drawing it as an edge would show a
    // self-loop on every merged character.
    if (assertion.predicate === 'same_as') continue

    const source = rootOf.get(assertion.subject_entity_id)
    const target = rootOf.get(assertion.object_entity_id)
    // An assertion whose endpoints are not both visible is not an error: the
    // boundary hid one of them, and the relation goes with it.
    if (!source || !target) continue
    if (source === target) continue

    const key = `${source}|${assertion.predicate}|${target}`
    const existing = edgeByPair.get(key)
    if (existing) {
      // Two assertions collapsed onto one node pair by a merge. Keeping both as
      // parallel edges would double every relation of a merged character.
      existing.weight++
      existing.confidence = Math.max(existing.confidence, assertion.confidence)
      existing.knowledgeFromChapter = Math.min(
        existing.knowledgeFromChapter,
        assertion.knowledge_from_chapter,
      )
      continue
    }

    const edge: GraphEdge = {
      id: assertion.id,
      source,
      target,
      predicate: assertion.predicate,
      epistemicStatus: assertion.epistemic_status,
      knowledgeFromChapter: assertion.knowledge_from_chapter,
      confidence: assertion.confidence,
      weight: 1,
    }
    edgeByPair.set(key, edge)
    edges.push(edge)

    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }

  const nodes: GraphNode[] = []
  let mergedAway = 0

  for (const [root, members] of groups) {
    const rootEntity = entityById.get(root)
    if (!rootEntity) continue

    mergedAway += members.length - 1

    if (nodeTypes && nodeTypes.length > 0 && !nodeTypes.includes(rootEntity.node_type)) {
      continue
    }

    /*
     * The label comes from the whole component, not just the representative.
     *
     * After a merge the true name may sit on the entity that is *not* the
     * representative — the representative is chosen by id, which has nothing to
     * do with which appearance carried the name. Taking the best label across
     * all members is what makes a merged character display as "Kaelo Renn"
     * rather than as whichever silhouette happened to sort first.
     */
    const best = bestLabel(members, labelOf)

    nodes.push({
      id: root,
      memberIds: members,
      nodeType: rootEntity.node_type,
      label: best?.label ?? 'entité sans nom révélé',
      labelKind: best?.kind ?? 'placeholder',
      // The earliest appearance in the component: when the reader first met
      // anyone who turns out to be this person.
      firstSeenChapter: Math.min(
        ...members.map((id) => entityById.get(id)?.first_seen_chapter ?? boundaryChapter),
      ),
      degree: degree.get(root) ?? 0,
    })
  }

  const visible = new Set(nodes.map((node) => node.id))

  return {
    boundaryChapter,
    nodes,
    // A type filter can hide one endpoint; the edge goes with it rather than
    // dangling.
    edges: edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
    mergedAway,
    // Set by projectGraph, which is the only caller that knows the true total.
    truncated: null,
  }
}

function bestLabel(
  members: string[],
  labelOf: Map<string, LabelRow>,
): LabelRow | undefined {
  let best: LabelRow | undefined
  for (const member of members) {
    const label = labelOf.get(member)
    if (!label) continue
    if (!best || label.precedence > best.precedence) best = label
  }
  return best
}

/**
 * The display name of one entity at one chapter.
 *
 * Separate from the projection because entity sheets and search need it without
 * building a graph, and because the rule — highest precedence among the labels
 * revealed so far — is the single most visible consequence of the whole design.
 * An alias holds until the chapter that gives the true name, and not one chapter
 * earlier.
 */
export async function displayLabel(
  userId: string,
  boundaryChapter: number,
  entityId: string,
): Promise<{ label: string; kind: string; revealedInChapter: number } | null> {
  return withBoundary({ userId, boundaryChapter }, async (db) => {
    const rows = await db.execute<LabelRow>(sql`
      SELECT entity_id, label, kind::text AS kind, precedence, revealed_in_chapter
      FROM entity_labels
      WHERE entity_id = ${entityId}
      ORDER BY precedence DESC, revealed_in_chapter DESC
      LIMIT 1
    `)
    const row = rows[0]
    return row
      ? { label: row.label, kind: row.kind, revealedInChapter: row.revealed_in_chapter }
      : null
  })
}

/**
 * Which entities are the same as this one, as far as the reader knows.
 *
 * Used by the entity sheet to say "also appears as…", and by search so that
 * looking up either half of a merged pair finds the same node.
 */
export async function identityComponent(
  userId: string,
  boundaryChapter: number,
  entityId: string,
): Promise<string[]> {
  return withBoundary({ userId, boundaryChapter }, async (db) => {
    return componentOf(db, entityId)
  })
}

/**
 * The same answer for many entities, in one read.
 *
 * `identityComponent()` reads every visible `same_as` to answer about one
 * entity; asking it about twenty entities reads that table twenty times. The
 * union-find it builds already knows about all of them, so this builds it once
 * and asks it repeatedly. Callers that resolve a whole page of entities — the
 * story thread looking for faces — need this shape rather than a loop.
 */
export async function identityComponents(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (entityIds.length === 0) return out

  return withBoundary({ userId, boundaryChapter }, async (db) => {
    const rows = await db.execute<{
      subject_entity_id: string
      object_entity_id: string | null
    }>(sql`
      SELECT subject_entity_id, object_entity_id
      FROM assertions
      WHERE predicate = 'same_as' AND object_entity_id IS NOT NULL
    `)

    const identity = new UnionFind()
    for (const id of entityIds) identity.find(id)
    for (const row of rows) {
      if (!row.object_entity_id) continue
      identity.union(row.subject_entity_id, row.object_entity_id)
    }

    const members = identity.members()
    for (const id of entityIds) {
      out.set(id, members.get(identity.find(id)) ?? [id])
    }
    return out
  })
}

async function componentOf(db: BoundaryDb, entityId: string): Promise<string[]> {
  const rows = await db.execute<{
    subject_entity_id: string
    object_entity_id: string | null
  }>(sql`
    SELECT subject_entity_id, object_entity_id
    FROM assertions
    WHERE predicate = 'same_as' AND object_entity_id IS NOT NULL
  `)

  const identity = new UnionFind()
  identity.find(entityId)
  for (const row of rows) {
    if (!row.object_entity_id) continue
    identity.union(row.subject_entity_id, row.object_entity_id)
  }

  const root = identity.find(entityId)
  return (identity.members().get(root) ?? [entityId]).sort()
}
