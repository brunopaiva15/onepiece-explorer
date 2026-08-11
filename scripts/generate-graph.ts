/**
 * A synthetic graph at the scale the finished work reaches.
 *
 * ADR 0005 puts the target at roughly 20 000 nodes and 150 000 edges after
 * ~1 100 chapters. The performance budget is measured against 8 000 / 60 000,
 * which is around chapter 450 — far enough in that a design which only works
 * on three fixture chapters has already fallen over, and small enough that the
 * test stays runnable on every CI pass rather than becoming the one nobody
 * waits for.
 *
 * The shape matters as much as the size. A uniformly random graph is easy in
 * all the ways a story is not: real casts are scale-free (a handful of
 * characters appear everywhere, most appear twice), relations cluster by arc,
 * and identities merge late. All three are generated here, because a layout or
 * a query that is fast on a random graph and slow on a hub is fast on nothing
 * that matters.
 *
 *   TEST_DB=1 pnpm fixtures:graph
 */
import '../src/lib/load-env.ts'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const url =
  process.env.TEST_DB === '1'
    ? (process.env.TEST_DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
    : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error('Aucune connexion. Lancez avec TEST_DB=1, ou renseignez DIRECT_URL.')
  process.exit(1)
}

const NODES = Number(process.env.PERF_NODES ?? 8_000)
const EDGES = Number(process.env.PERF_EDGES ?? 60_000)
const CHAPTERS = Number(process.env.PERF_CHAPTERS ?? 450)
/** Identity merges, as a fraction of nodes. Rare in the work, and expensive. */
const MERGE_RATE = 0.02

const sql = postgres(url, { max: 4, onnotice: () => {} })

/**
 * Deterministic pseudo-randomness.
 *
 * A perf fixture regenerated differently on every run makes a regression
 * indistinguishable from a reshuffle — the number moves and nobody can say
 * whether the code or the data changed. Seeded, the graph is the same every
 * time and a slower run means slower code.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const random = makeRandom(20_260_811)

const NODE_TYPES = [
  'character', 'character', 'character', 'character',
  'place', 'place', 'group', 'object', 'power', 'event', 'battle', 'concept',
]

/**
 * Predicates are read from the database, not listed here.
 *
 * An integrity trigger validates every assertion's subject and object against
 * the predicate's declared types, and it caught the first version of this
 * generator immediately: pairing a random predicate with random endpoints
 * produces `member_of` between two places. Reading the ontology means the
 * fixture obeys the same rules the product does — which is the point of a
 * fixture, and the trigger was right to refuse the alternative.
 */
interface PredicateSpec {
  key: string
  subjectTypes: string[]
  objectTypes: string[]
}

async function loadPredicates(): Promise<PredicateSpec[]> {
  const rows = await sql<
    Array<{ key: string; subject_types: string[]; object_types: string[] }>
  >`
    SELECT key, subject_types, object_types
    FROM predicates
    WHERE is_identity = false AND cardinality(subject_types) > 0
  `
  return rows.map((row) => ({
    key: row.key,
    subjectTypes: row.subject_types,
    objectTypes: row.object_types,
  }))
}

async function main(): Promise<void> {
  const started = Date.now()
  const userId = randomUUID()
  const workId = randomUUID()

  console.log(`Génération : ${NODES} nœuds, ${EDGES} arêtes, ${CHAPTERS} chapitres.`)

  await sql`INSERT INTO profiles (id) VALUES (${userId})`
  await sql`
    INSERT INTO works (id, user_id, slug, title)
    VALUES (${workId}, ${userId}, ${`perf-${workId.slice(0, 8)}`}, 'Corpus de performance')
  `

  // Chapters first: everything else references one.
  const chapterIds: string[] = []
  for (let n = 1; n <= CHAPTERS; n++) {
    chapterIds.push(randomUUID())
  }
  await sql`
    INSERT INTO chapters ${sql(
      chapterIds.map((id, index) => ({
        id,
        work_id: workId,
        user_id: userId,
        number: index + 1,
        status: 'published' as const,
        published_at: new Date(),
      })),
    )}
  `
  console.log(`  ${CHAPTERS} chapitres`)

  /*
   * Entity introduction follows the story's shape, not a uniform draw: early
   * chapters introduce the core cast, later ones add a long tail. A uniform
   * spread would make every boundary position equally cheap, which is exactly
   * the case a real corpus never presents.
   */
  const entityIds: string[] = []
  const firstSeen: number[] = []
  const entityTypes: string[] = []
  for (let i = 0; i < NODES; i++) {
    entityIds.push(randomUUID())
    const skew = Math.pow(random(), 0.6)
    firstSeen.push(Math.max(1, Math.ceil(skew * CHAPTERS)))
    entityTypes.push(NODE_TYPES[Math.floor(random() * NODE_TYPES.length)]!)
  }

  await insertInBatches(
    'entities',
    entityIds.map((id, i) => ({
      id,
      work_id: workId,
      user_id: userId,
      node_type: entityTypes[i]!,
      first_seen_chapter: firstSeen[i]!,
      review_status: 'accepted' as const,
    })),
  )
  console.log(`  ${NODES} entités`)

  // One label each, plus a later true name for some — so the label-precedence
  // path is exercised rather than every node having exactly one name.
  const labels = entityIds.flatMap((id, i) => {
    const base = {
      entity_id: id,
      user_id: userId,
      label: `entité ${i}`,
      normalized_label: `entite ${i}`,
      kind: 'placeholder' as const,
      revealed_in_chapter: firstSeen[i]!,
      precedence: 10,
    }
    if (random() > 0.7) {
      const revealed = Math.min(CHAPTERS, firstSeen[i]! + Math.ceil(random() * 100))
      return [
        base,
        {
          entity_id: id,
          user_id: userId,
          label: `Nom ${i}`,
          normalized_label: `nom ${i}`,
          kind: 'true_name' as const,
          revealed_in_chapter: revealed,
          precedence: 100,
        },
      ]
    }
    return [base]
  })
  await insertInBatches('entity_labels', labels)
  console.log(`  ${labels.length} libellés`)

  /*
   * Scale-free attachment.
   *
   * Picking both endpoints uniformly gives every node the same degree, and the
   * expensive cases in this product are all about hubs: the layout, the
   * neighbourhood expansion, the degree-based sizing. Preferential attachment —
   * drawing one endpoint from a list where each node appears once per existing
   * edge — reproduces the handful-of-hubs shape a cast actually has.
   */
  const predicates = await loadPredicates()
  if (predicates.length === 0) {
    throw new Error("Ontologie vide : lancez `pnpm db:push` avant de générer.")
  }

  // Index entities by type so a predicate can draw endpoints it accepts.
  const byType = new Map<string, number[]>()
  entityTypes.forEach((type, index) => {
    const list = byType.get(type)
    if (list) list.push(index)
    else byType.set(type, [index])
  })

  // Preferential attachment, kept per type so a hub stays a hub of the right
  // kind rather than being drawn for a predicate that would reject it.
  const hubs = new Map<string, number[]>()
  for (const [type, list] of byType) {
    hubs.set(type, list.slice(0, Math.max(1, Math.floor(list.length * 0.03))))
  }

  function pick(types: string[], preferHub: boolean): number | null {
    const candidates = types.flatMap((type) =>
      preferHub ? (hubs.get(type) ?? []) : (byType.get(type) ?? []),
    )
    if (candidates.length === 0) return null
    return candidates[Math.floor(random() * candidates.length)]!
  }

  const rows: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  let attempts = 0
  const maxAttempts = EDGES * 40

  while (rows.length < EDGES && attempts < maxAttempts) {
    attempts++
    const predicate = predicates[Math.floor(random() * predicates.length)]!

    const a = pick(predicate.subjectTypes, false)
    // 60% of objects drawn from the hub set: that is what produces the
    // handful-of-hubs shape a real cast has, and hubs are where every
    // expensive path in this product lives.
    const b = pick(predicate.objectTypes, random() < 0.6)
    if (a === null || b === null || a === b) continue

    const key = `${a}|${predicate.key}|${b}`
    if (seen.has(key)) continue
    seen.add(key)

    for (const type of [entityTypes[a]!, entityTypes[b]!]) {
      hubs.get(type)?.push(type === entityTypes[a]! ? a : b)
    }

    // An edge cannot be known before both its endpoints exist.
    const from = Math.max(firstSeen[a]!, firstSeen[b]!)
    const knowledgeFrom = Math.min(
      CHAPTERS,
      from + Math.floor(random() * (CHAPTERS - from + 1)),
    )

    rows.push({
      id: randomUUID(),
      work_id: workId,
      user_id: userId,
      subject_entity_id: entityIds[a]!,
      predicate: predicate.key,
      object_entity_id: entityIds[b]!,
      knowledge_from_chapter: knowledgeFrom,
      observed_in_chapter: knowledgeFrom,
      confidence: 0.5 + random() * 0.5,
      epistemic_status: random() > 0.85 ? 'inferred_strong' : 'explicit',
      review_status: 'accepted',
      proposed_by: 'ai',
    })
  }

  if (rows.length < EDGES) {
    console.log(
      `  note : ${rows.length}/${EDGES} arêtes — l'ontologie limite les paires valides`,
    )
  }

  // Identity merges, revealed late. These are what make the union-find do work.
  const merges = Math.floor(NODES * MERGE_RATE)
  let mergesMade = 0
  for (let i = 0; i < merges * 3 && mergesMade < merges; i++) {
    // Same type on both sides: `same_as` between a place and a character is
    // refused by the same trigger, and rightly.
    const characters = byType.get('character') ?? []
    if (characters.length < 2) break
    const a = characters[Math.floor(random() * characters.length)]!
    const b = characters[Math.floor(random() * characters.length)]!
    if (a === b) continue
    mergesMade++
    const from = Math.max(firstSeen[a]!, firstSeen[b]!)
    rows.push({
      id: randomUUID(),
      work_id: workId,
      user_id: userId,
      subject_entity_id: entityIds[a]!,
      predicate: 'same_as',
      object_entity_id: entityIds[b]!,
      knowledge_from_chapter: Math.min(
        CHAPTERS,
        from + Math.ceil(random() * (CHAPTERS - from + 1)),
      ),
      observed_in_chapter: from,
      confidence: 0.9,
      epistemic_status: 'explicit',
      review_status: 'accepted',
      proposed_by: 'user',
    })
  }

  await insertInBatches('assertions', rows)
  console.log(`  ${rows.length} assertions (dont ${mergesMade} fusions d'identité)`)

  await sql`ANALYZE entities, entity_labels, assertions`

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\nGénéré en ${seconds} s.`)
  console.log(`  user_id = ${userId}`)
  console.log(`  work_id = ${workId}`)
  console.log('\nÀ passer aux mesures :')
  console.log(`  PERF_USER_ID=${userId} pnpm test:perf`)

  await sql.end({ timeout: 10 })
}

/**
 * Insert in batches.
 *
 * 60 000 rows in one statement exceeds the parameter limit of the wire
 * protocol; one row per statement takes minutes. A few thousand at a time is
 * the flat part of the curve.
 */
async function insertInBatches(
  table: string,
  rows: Array<Record<string, unknown>>,
  size = 2_000,
): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    const batch = rows.slice(start, start + size)
    // The table name is a literal from this file, never user input.
    await sql`INSERT INTO ${sql(table)} ${sql(batch)}`
  }
}

main().catch((error: unknown) => {
  console.error('\nGénération impossible :', error)
  process.exit(1)
})
