import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getReviewQueue, referencedIds } from '@/domains/review/queue.ts'
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
 * A relation card has to say who it is about.
 *
 * What a proposal stores is an identifier, and which kind depends on when the
 * entity was published: `e3` for one proposed in the same model response, a
 * UUID for one already in the graph — including one accepted a few minutes
 * earlier in the same review. Displayed raw, the card reads
 * « 9fdd1160-… capture 5da604bb-… », and the reviewer is asked to accept a
 * relation between two things they cannot see. That is not a cosmetic defect:
 * an unreadable card is either accepted blind or deferred forever.
 *
 * The one thing the resolution must never do is guess. Local ids are scoped to
 * the response that produced them, so two slices both number a character `e1`;
 * putting the first slice's name on the second slice's relation would be a
 * confident lie, which is worse than the hex string it replaced.
 */

let world: SeededWorld
let chapterId: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1])
  chapterId = world.chapterIds.get(1)!
  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
})

afterAll(async () => {
  await closeDb()
})

let anchor = 0

async function propose(
  category: 'entity' | 'assertion' | 'event',
  payload: Record<string, unknown>,
  status: 'proposed' | 'accepted' = 'proposed',
): Promise<string> {
  const id = randomUUID()
  anchor++
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, ${category}, 50,
      ${JSON.stringify({
        evidence: [{ kind: 'text', ref: `b${anchor}`, excerpt: 'extrait' }],
        confidence: 0.85,
        ...payload,
      })},
      ${randomUUID()}, false, 0.85, ${status}::review_status
    )
  `
  return id
}

const entity = (localId: string, label: string) => ({
  local_id: localId,
  node_type: 'character',
  label,
  label_kind: 'alias',
  source_term: null,
  naming_confident: true,
})

const relation = (subject: string, object: string | null) => ({
  subject,
  predicate: 'captures',
  object,
  object_value: object === null ? 'une valeur' : null,
  epistemic_status: 'explicit',
})

describe('naming the ends of a relation', () => {
  it('names entities already in the graph', async () => {
    // The case from the screenshot: both ends were published in an earlier
    // batch of this same review, so both are UUIDs and neither is in the queue.
    const higuma = await createEntity(world, 'character', 1)
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, higuma, 'Higuma', 'alias', 1, 10)
    await addLabel(world, luffy, 'Luffy', 'true_name', 1, 10)

    const item = await propose('assertion', relation(higuma, luffy))

    const queue = await getReviewQueue(world.userId, runId)
    const names = queue!.items.find((row) => row.id === item)!.names

    expect(names[higuma]).toBe('Higuma')
    expect(names[luffy]).toBe('Luffy')
  })

  it('prefers the label of highest precedence when an entity has several', async () => {
    const entityId = await createEntity(world, 'character', 1)
    await addLabel(world, entityId, 'l’homme au foulard rayé', 'placeholder', 1, 1)
    await addLabel(world, entityId, 'Higuma', 'true_name', 1, 50)

    const item = await propose('assertion', relation(entityId, null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.find((row) => row.id === item)!.names[entityId]).toBe('Higuma')
  })

  it('names an entity still under review, from its own proposal', async () => {
    // Relation and subject are proposed together and reviewed together; the
    // subject has no UUID yet and will not have one until publication.
    await propose('entity', entity('e1', 'Le Seigneur de la Côte'))
    const item = await propose('assertion', relation('e1', null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.find((row) => row.id === item)!.names.e1).toBe(
      'Le Seigneur de la Côte',
    )
  })

  it('refuses to name a local id two slices disagree about', async () => {
    // `e1` is the first entity of *a response*, and a chapter is extracted in
    // several. Answering this one would put a name on the wrong character.
    await propose('entity', entity('e1', 'Shanks'))
    await propose('entity', entity('e1', 'Higuma'))
    const item = await propose('assertion', relation('e1', null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.find((row) => row.id === item)!.names.e1).toBeUndefined()
  })

  it('answers from a copy already published, which left the queue', async () => {
    await propose('entity', entity('e2', 'Makino'), 'accepted')
    const item = await propose('assertion', relation('e2', null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.map((row) => row.id)).toEqual([item])
    expect(queue!.items[0]!.names.e2).toBe('Makino')
  })

  it('leaves an identifier nothing accounts for unresolved', async () => {
    const item = await propose('assertion', relation('e9', null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.find((row) => row.id === item)!.names).toEqual({})
  })

  it('says which of them is a scene rather than someone', async () => {
    /*
     * A name is not enough to read a relation. An event is an entity with a
     * side table and its name *is* its summary, so an end that is a scene
     * arrives as a bare sentence: « Dix ans plus tard, Luffy quitte seul le
     * Village de Fuchsia… se trouve à la Base de la Marine » reads as a claim
     * about Luffy and is a claim about the scene that mentions him. Nothing
     * else on the card says otherwise — `located_at` accepts an occurrence, so
     * the relation is well typed and `typeMismatch` is silent.
     */
    const scene = await createEntity(world, 'voyage', 1)
    await addLabel(
      world,
      scene,
      'Dix ans plus tard, Luffy quitte seul le Village de Fuchsia.',
      'alias',
      1,
      10,
    )
    const base = await createEntity(world, 'place', 1)
    await addLabel(world, base, 'Base de la Marine', 'alias', 1, 10)

    const item = await propose('assertion', {
      ...relation(scene, base),
      predicate: 'located_at',
    })

    const row = (await getReviewQueue(world.userId, runId))!.items.find(
      (queued) => queued.id === item,
    )!

    expect(row.typeMismatch).toBeNull()
    expect(row.nodeTypes[scene]).toBe('voyage')
    expect(row.nodeTypes[base]).toBe('place')
  })

  it('names a scene proposed in the same run, which is not an entity proposal', async () => {
    /*
     * A local id is not the property of an entity proposal. An event carries
     * one too, and a scene the model filed as an entity of type `event` is
     * refiled into `events` on the way in — keeping the id every relation of
     * that slice already points at.
     *
     * The resolution looked at entity proposals only, so those relations found
     * nothing and the card read « entité 7d1b89b1… »: eight characters of the
     * slice hash, which is neither the scene nor anything the reviewer can look
     * up. The claim was then decided blind or deferred for ever.
     */
    await propose('event', {
      local_id: '7d1b89b1:e5',
      summary: 'Les Bananawani sortent du bassin et poursuivent Vivi.',
      kind: 'battle',
      participants: [],
      is_flashback: false,
    })
    const item = await propose('assertion', {
      ...relation('7d1b89b1:e5', null),
      predicate: 'located_at',
      object_value: 'Rainbase',
    })

    const row = (await getReviewQueue(world.userId, runId))!.items.find(
      (queued) => queued.id === item,
    )!

    expect(row.names['7d1b89b1:e5']).toBe(
      'Les Bananawani sortent du bassin et poursuivent Vivi.',
    )
    // And its type, which is what makes the card stack the relation instead of
    // running a sentence into a predicate.
    expect(row.nodeTypes['7d1b89b1:e5']).toBe('battle')
  })

  it('reads a scene that did not say which sort it was as the event it will become', async () => {
    await propose('event', {
      local_id: 'e7',
      summary: 'Crocodile reçoit un appel.',
      participants: [],
      is_flashback: false,
    })
    const item = await propose('assertion', relation('e7', null))

    const row = (await getReviewQueue(world.userId, runId))!.items.find(
      (queued) => queued.id === item,
    )!

    expect(row.names.e7).toBe('Crocodile reçoit un appel.')
    expect(row.nodeTypes.e7).toBe('event')
  })

  it('says it for an end still under review, too', async () => {
    await propose('entity', { ...entity('e1', 'Shanks'), node_type: 'character' })
    const item = await propose('assertion', relation('e1', null))

    const queue = await getReviewQueue(world.userId, runId)
    expect(queue!.items.find((row) => row.id === item)!.nodeTypes.e1).toBe('character')
  })
})

describe('which identifiers a payload mentions', () => {
  it('takes the two ends of a relation and an event’s participants', () => {
    expect(referencedIds(relation('e1', 'e2'))).toEqual(['e1', 'e2'])
    expect(referencedIds({ summary: 'Ils fuient.', participants: ['e1', 'e4'] })).toEqual([
      'e1',
      'e4',
    ])
  })

  it('mentions none for an entity, whose own id is what the others point at', () => {
    expect(referencedIds(entity('e1', 'Shanks'))).toEqual([])
    expect(referencedIds(null)).toEqual([])
  })
})
