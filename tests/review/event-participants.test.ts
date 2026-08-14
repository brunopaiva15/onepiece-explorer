import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * An event that knows who was in it.
 *
 * `participants` has been in the extraction schema since it was written, has
 * been anchored and filtered on every run since, and was then dropped on the
 * floor at publication — an event reached the graph knowing nobody, and no
 * character was recorded as having been anywhere near the scene it describes.
 *
 * What that costs is the question the library is for. A chapter whose facts are
 * events — which is what a written summary produces — put nothing at all
 * against its cast: « qu'est-ce que Nami fait au chapitre 14 » had nothing to
 * read, because every fact about her was an event and no event named her.
 *
 * The other half is that an event is a node. Half the ontology's temporal
 * predicates take one as their object, and publication created events *after*
 * the relations that name them, so « Zoro participe à <cette scène> » failed on
 * a subject the reviewer had just accepted.
 */

const SUMMARY = [
  'Buggy launches a Buggy ball that hits the mayor’s house where Zoro was sleeping.',
  '',
  'Nami has changed her mind about Luffy being a pirate.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string
let zoroId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  zoroId = await createEntity(world, 'character', 1)
  await addLabel(world, zoroId, 'Roronoa Zoro', 'true_name', 1, 100)

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 14,
    language: 'en',
    text: SUMMARY,
  })
  chapterId = imported.chapterId

  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
})

afterAll(async () => {
  await closeDb()
})

const EVIDENCE = [{ kind: 'text', ref: 'b1', excerpt: 'Buggy launches a Buggy ball' }]

async function propose(
  category: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, ${category}, 50,
      ${raw.json({ evidence: EVIDENCE, confidence: 0.9, ...payload })},
      ${randomUUID()}, false, 0.9, 'proposed'
    )
  `
  return id
}

function scene(participants: string[]): Record<string, unknown> {
  return {
    local_id: 'ev1',
    summary: 'Baggy tire un Buggy Ball sur la maison du maire où dormait Zoro.',
    participants,
    is_flashback: false,
  }
}

async function presenceOf(entityId: string): Promise<Array<{ kind: string; stated: boolean }>> {
  return raw<Array<{ kind: string; stated: boolean }>>`
    SELECT kind, stated FROM occurrences
     WHERE user_id = ${world.userId} AND entity_id = ${entityId}`
}

interface Edge {
  subject_entity_id: string
  predicate: string
  object_entity_id: string
  epistemic_status: string
}

async function edges(): Promise<Edge[]> {
  return raw<Edge[]>`
    SELECT subject_entity_id, predicate, object_entity_id, epistemic_status::text AS epistemic_status
      FROM assertions
     WHERE user_id = ${world.userId}
     ORDER BY predicate`
}

async function sceneId(): Promise<string> {
  const [row] = await raw<Array<{ entity_id: string }>>`
    SELECT entity_id FROM events WHERE user_id = ${world.userId}`
  return row!.entity_id
}

describe('publishing an event', () => {
  it('records every participant as present in the chapter', async () => {
    const nami = await propose('entity', {
      local_id: 'e1',
      node_type: 'character',
      label: 'Nami',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    // One end proposed in this run, one already in the graph: the two shapes a
    // participant identifier takes, and both have to resolve.
    const event = await propose('event', scene(['e1', zoroId]))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.eventsCreated).toBe(1)

    const [namiRow] = await raw<Array<{ id: string }>>`
      SELECT e.id FROM entities e
        JOIN entity_labels l ON l.entity_id = e.id
       WHERE e.user_id = ${world.userId} AND l.label = 'Nami'`

    // « appearance », not « mention »: an event is a thing that happens on the
    // page and its participants are the people it happens to.
    expect(await presenceOf(namiRow!.id)).toContainEqual({ kind: 'appearance', stated: true })
    expect(await presenceOf(zoroId)).toContainEqual({ kind: 'appearance', stated: true })
  })

  it('says nothing about a participant whose own proposal was refused', async () => {
    const nami = await propose('entity', {
      local_id: 'e1',
      node_type: 'character',
      label: 'Nami',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    const event = await propose('event', scene(['e1', zoroId]))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'reject' },
      { reviewItemId: event, decision: 'accept' },
    ])

    // The event still publishes — it is a real scene whichever of its cast the
    // reviewer kept — and the rejected end simply records nothing.
    expect(result.failures).toEqual([])
    expect(result.eventsCreated).toBe(1)
    expect(await presenceOf(zoroId)).toContainEqual({ kind: 'appearance', stated: true })
  })

  it('lets a relation name the event, whichever order the cards are in', async () => {
    /*
     * The relation card can sit anywhere in the queue and publication walks the
     * categories, not the queue — so this is about which loop runs first, and
     * the event's has to.
     */
    const event = await propose('event', scene([zoroId]))
    const relation = await propose('assertion', {
      subject: zoroId,
      predicate: 'participates_in',
      object: 'ev1',
      object_value: null,
      epistemic_status: 'explicit',
    })

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: event, decision: 'accept' },
      { reviewItemId: relation, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.assertionsCreated).toBe(1)

    const edges = await raw<Array<{ predicate: string; object_entity_id: string }>>`
      SELECT a.predicate, a.object_entity_id
        FROM assertions a
       WHERE a.user_id = ${world.userId} AND a.predicate = 'participates_in'`
    expect(edges).toHaveLength(1)

    const [target] = await raw<Array<{ entity_id: string }>>`
      SELECT entity_id FROM events WHERE user_id = ${world.userId}`
    expect(edges[0]!.object_entity_id).toBe(target!.entity_id)
  })

  it('joins the scene to its cast, so it is not a node of degree zero', async () => {
    /*
     * The failure the graph showed: several hundred events and combats drawn as
     * a halo of loose dots around everything else, reachable from no character.
     * Their cast was known the whole time — stated by the extraction, listed on
     * the review card, accepted by the reviewer — and recorded only as presence,
     * which names a chapter and never the scene.
     */
    const nami = await propose('entity', {
      local_id: 'e1',
      node_type: 'character',
      label: 'Nami',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    const event = await propose('event', scene(['e1', zoroId]))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: nami, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])

    const [namiRow] = await raw<Array<{ id: string }>>`
      SELECT e.id FROM entities e
        JOIN entity_labels l ON l.entity_id = e.id
       WHERE e.user_id = ${world.userId} AND l.label = 'Nami'`

    const target = await sceneId()
    const drawn = await edges()
    expect(drawn).toHaveLength(2)
    for (const edge of drawn) {
      expect(edge.predicate).toBe('participates_in')
      expect(edge.object_entity_id).toBe(target)
      // Stated by the extraction in the same answer that stated the scene, and
      // accepted as such: a fact affirmed, not a deduction.
      expect(edge.epistemic_status).toBe('explicit')
    }
    expect(drawn.map((edge) => edge.subject_entity_id).sort()).toEqual(
      [namiRow!.id, zoroId].sort(),
    )
  })

  it('cites the passage the scene was read from', async () => {
    /*
     * An event proposal's evidence had nowhere to live — the table hangs off an
     * assertion — so the link is the first row that makes a scene traceable.
     */
    const event = await propose('event', scene([zoroId]))
    await publishDecisions(world.userId, runId, [
      { reviewItemId: event, decision: 'accept' },
    ])

    const cited = await raw<Array<{ excerpt: string }>>`
      SELECT ev.excerpt
        FROM evidence ev
        JOIN assertions a ON a.id = ev.assertion_id
       WHERE a.user_id = ${world.userId} AND a.predicate = 'participates_in'`
    expect(cited).toHaveLength(1)
    expect(cited[0]!.excerpt).toBe('Buggy launches a Buggy ball')
  })

  it('draws the link once when the chapter already stated it', async () => {
    /*
     * The prompt asks for both — « nommez ses acteurs dans participants et
     * écrivez participe à vers ce même identifiant » — so a compliant chapter
     * arrives with the relation as well as the cast. Assertions are append-only,
     * so a duplicate written here could never be taken back.
     */
    const event = await propose('event', scene([zoroId]))
    const relation = await propose('assertion', {
      subject: zoroId,
      predicate: 'participates_in',
      object: 'ev1',
      object_value: null,
      epistemic_status: 'explicit',
    })

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: event, decision: 'accept' },
      { reviewItemId: relation, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(await edges()).toHaveLength(1)
  })

  it('places the scene when the cast names where it happened', async () => {
    // A place cannot « participate »; the ontology puts the scene at it instead,
    // which is the direction `located_at` is written in.
    const village = await propose('entity', {
      local_id: 'p1',
      node_type: 'place',
      label: 'Village d’Orange',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    const event = await propose('event', scene(['p1']))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: village, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])

    const drawn = await edges()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.predicate).toBe('located_at')
    expect(drawn[0]!.subject_entity_id).toBe(await sceneId())
  })

  it('publishes the scene whole when a participant fits no predicate', async () => {
    /*
     * A fruit among the participants is not a mistake — the scene really is
     * about it — but no predicate in the ontology carries « an object took part
     * in an event », and the publication must not fail over one. The presence
     * row still says the object was there.
     */
    const fruit = await propose('entity', {
      local_id: 'o1',
      node_type: 'object',
      label: 'Fruit du Bara Bara',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    const event = await propose('event', scene(['o1', zoroId]))

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: fruit, decision: 'accept' },
      { reviewItemId: event, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.eventsCreated).toBe(1)

    const drawn = await edges()
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.subject_entity_id).toBe(zoroId)

    const [fruitRow] = await raw<Array<{ id: string }>>`
      SELECT e.id FROM entities e
        JOIN entity_labels l ON l.entity_id = e.id
       WHERE e.user_id = ${world.userId} AND l.label = 'Fruit du Bara Bara'`
    expect(await presenceOf(fruitRow!.id)).toContainEqual({
      kind: 'appearance',
      stated: true,
    })
  })

  it('lands the scene in the events table, not merely in entities', async () => {
    /*
     * The failure this whole change is about. An `entities` row of type `event`
     * with no row in `events` is absent from the chronology, absent from story
     * mode's « il arrive », and shown instead as « entre en scène · Événement »
     * — a scene announced like a character walking on.
     */
    const event = await propose('event', scene([]))

    await publishDecisions(world.userId, runId, [
      { reviewItemId: event, decision: 'accept' },
    ])

    const orphans = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM entities en
       WHERE en.user_id = ${world.userId}
         AND en.node_type = 'event'
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id = en.id)`
    expect(orphans[0]!.count).toBe(0)
  })
})
