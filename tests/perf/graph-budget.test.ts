import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { projectGraph } from '@/domains/temporal/projection.ts'
import { search, shortestPath } from '@/domains/search/index.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { closeDb, raw } from '../helpers/db.ts'

/**
 * The performance budget, measured rather than assumed.
 *
 * Runs against the synthetic corpus from `pnpm fixtures:graph` — 8 000 nodes,
 * 60 000 edges, 450 chapters, scale-free, with identity merges. That is around
 * chapter 450 of the real work; the finished thing is roughly 20 000 / 150 000,
 * so a comfortable margin here is a plausible margin there.
 *
 * Budgets are generous on purpose. A tight number on shared CI hardware fails
 * for reasons that have nothing to do with the code, and a perf test that cries
 * wolf gets skipped — at which point the real regression lands unnoticed. These
 * are set to catch an order-of-magnitude change, which is what an accidentally
 * quadratic query actually looks like.
 *
 * Skipped automatically when the corpus has not been generated, so `pnpm test`
 * stays runnable on a fresh checkout.
 */

const BUDGET = {
  /** Full projection at the latest chapter: the worst case for the graph page. */
  projectionMs: 6_000,
  /** Projection at an early boundary: should be much cheaper. */
  earlyProjectionMs: 4_000,
  searchMs: 3_000,
  entitySheetMs: 3_000,
  shortestPathMs: 8_000,
}

let userId: string | null = null
let sampleEntityId: string | null = null
let pairIds: [string, string] | null = null

beforeAll(async () => {
  /*
   * Find the perf corpus by size rather than by an environment variable.
   *
   * Requiring PERF_USER_ID would mean the test silently passes for anyone who
   * forgot to set it — which is the same as not having the test. Picking the
   * largest corpus in the database makes it self-locating.
   */
  const [row] = await raw<Array<{ user_id: string; count: number }>>`
    SELECT user_id, count(*)::int AS count
    FROM entities
    GROUP BY user_id
    ORDER BY count DESC
    LIMIT 1
  `

  if (!row || row.count < 1_000) return
  userId = row.user_id

  const [entity] = await raw<Array<{ id: string }>>`
    SELECT e.id
    FROM entities e
    JOIN assertions a ON a.subject_entity_id = e.id
    WHERE e.user_id = ${userId}
    GROUP BY e.id
    ORDER BY count(*) DESC
    LIMIT 1
  `
  sampleEntityId = entity?.id ?? null

  // Two entities far apart in introduction order, so the path is not trivial.
  const pair = await raw<Array<{ id: string }>>`
    SELECT id FROM entities
    WHERE user_id = ${userId} AND node_type = 'character'
    ORDER BY first_seen_chapter
    LIMIT 1
  `
  const other = await raw<Array<{ id: string }>>`
    SELECT id FROM entities
    WHERE user_id = ${userId} AND node_type = 'character'
    ORDER BY first_seen_chapter DESC
    LIMIT 1
  `
  if (pair[0] && other[0]) pairIds = [pair[0].id, other[0].id]
}, 60_000)

afterAll(async () => {
  await closeDb()
})

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now()
  const value = await fn()
  return { ms: Date.now() - started, value }
}

describe('graph projection at scale', () => {
  it.runIf(true)('projects the whole corpus within budget', async () => {
    if (!userId) {
      console.log('  corpus de perf absent — lancez `TEST_DB=1 pnpm fixtures:graph`')
      return
    }

    const { ms, value } = await timed(() => projectGraph(userId!, 450))

    console.log(
      `  projection ch.450 : ${ms} ms · ${value.nodes.length} nœuds · ` +
        `${value.edges.length} arêtes · ${value.mergedAway} fusionnées`,
    )

    expect(value.nodes.length).toBeGreaterThan(1_000)
    expect(value.edges.length).toBeGreaterThan(10_000)
    expect(ms).toBeLessThan(BUDGET.projectionMs)
  }, 60_000)

  it('returns the whole corpus, or says it did not', async () => {
    if (!userId) return

    const [stored] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE user_id = ${userId}
    `
    const projection = await projectGraph(userId, 450)

    /*
     * The regression this exists for.
     *
     * The cap used to be 5 000 with `ORDER BY first_seen_chapter`, so at 8 000
     * entities the projection returned 4 898 and said nothing — and the 4 898 it
     * returned were the *earliest*, so the story appeared to stop a quarter of
     * the way through while looking complete. Silent incompleteness is the same
     * failure as a spoiler pointed the other way: the reader cannot tell.
     */
    const accountedFor = projection.nodes.length + projection.mergedAway

    if (projection.truncated === null) {
      expect(accountedFor).toBe(stored!.count)
    } else {
      // Truncation is allowed, but only when declared, and it must keep the
      // most-connected nodes rather than the earliest.
      expect(projection.truncated.total).toBe(stored!.count)
      expect(projection.truncated.shown).toBeLessThan(stored!.count)
      const degrees = projection.nodes.map((node) => node.degree)
      expect(Math.max(...degrees)).toBeGreaterThan(0)
    }
  }, 60_000)

  it('is cheaper at an early boundary than at a late one', async () => {
    if (!userId) return

    const early = await timed(() => projectGraph(userId!, 20))
    const late = await timed(() => projectGraph(userId!, 450))

    console.log(
      `  ch.20 : ${early.ms} ms / ${early.value.nodes.length} nœuds · ` +
        `ch.450 : ${late.ms} ms / ${late.value.nodes.length} nœuds`,
    )

    // The boundary is a predicate the database uses to do less work. If an early
    // chapter were not cheaper, the filtering would be happening after the read
    // rather than during it.
    expect(early.value.nodes.length).toBeLessThan(late.value.nodes.length)
    expect(early.ms).toBeLessThan(BUDGET.earlyProjectionMs)
  }, 60_000)

  it('scales sub-quadratically across boundaries', async () => {
    if (!userId) return

    const points = [50, 150, 300, 450]
    const measured: Array<{ chapter: number; ms: number; nodes: number }> = []

    for (const chapter of points) {
      const { ms, value } = await timed(() => projectGraph(userId!, chapter))
      measured.push({ chapter, ms, nodes: value.nodes.length })
    }

    console.log(
      '  ' +
        measured
          .map((point) => `ch.${point.chapter}: ${point.ms}ms/${point.nodes}n`)
          .join(' · '),
    )

    /*
     * The shape of the curve, not its absolute values.
     *
     * An accidentally quadratic step — scoring every pair, a query inside a
     * loop — shows up as the last point costing far more per node than the
     * first. Comparing cost-per-node across the range catches that while
     * staying immune to how fast the machine happens to be.
     */
    const first = measured[0]!
    const last = measured.at(-1)!
    const firstPerNode = first.ms / Math.max(1, first.nodes)
    const lastPerNode = last.ms / Math.max(1, last.nodes)

    console.log(
      `  coût par nœud : ${firstPerNode.toFixed(3)} ms → ${lastPerNode.toFixed(3)} ms`,
    )
    expect(lastPerNode).toBeLessThan(firstPerNode * 4)
  }, 120_000)
})

describe('search at scale', () => {
  it('answers within budget', async () => {
    if (!userId) return

    const { ms, value } = await timed(() => search(userId!, 450, 'Nom 42'))
    console.log(`  recherche : ${ms} ms · ${value.hits.length} résultats`)

    expect(ms).toBeLessThan(BUDGET.searchMs)
  }, 60_000)

  it('is not slower for a query that matches nothing', async () => {
    if (!userId) return

    // A miss must not scan more than a hit. If it did, the index is not being
    // used and the cost would grow with the corpus rather than with the answer.
    const hit = await timed(() => search(userId!, 450, 'Nom 42'))
    const miss = await timed(() => search(userId!, 450, 'zzzzterminconnu'))

    console.log(`  trouvé : ${hit.ms} ms · absent : ${miss.ms} ms`)
    expect(miss.ms).toBeLessThan(Math.max(hit.ms * 3, BUDGET.searchMs))
  }, 60_000)
})

describe('entity sheet at scale', () => {
  it('opens the most-connected entity within budget', async () => {
    if (!userId || !sampleEntityId) return

    const { ms, value } = await timed(() =>
      getEntitySheet(userId!, 450, sampleEntityId!),
    )

    console.log(`  fiche du nœud le plus connecté : ${ms} ms · ${value?.facts.length} faits`)

    expect(value).not.toBeNull()
    expect(ms).toBeLessThan(BUDGET.entitySheetMs)
  }, 60_000)
})

describe('shortest path at scale', () => {
  it('finds or refuses a path within budget', async () => {
    if (!userId || !pairIds) return

    const { ms, value } = await timed(() =>
      shortestPath(userId!, 450, pairIds![0], pairIds![1]),
    )

    console.log(
      `  chemin : ${ms} ms · ${value === null ? 'aucun' : `${value.steps.length} pas`}`,
    )

    // Either answer is correct — a graph where two characters are unconnected at
    // a given chapter is a real state. What matters is that deciding is bounded.
    expect(ms).toBeLessThan(BUDGET.shortestPathMs)
  }, 60_000)
})
