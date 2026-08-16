import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { checkTypes, alternativesFor } from '@/domains/knowledge/ontology.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
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
 * « Le prédicat member_of n'accepte pas un objet de type place ».
 *
 * The database is right to refuse it — a predicate carries the node types it
 * accepts and enforcing that is ADR 0004. What was wrong was the moment the
 * reviewer found out: after « Publier », in a red block, among twenty
 * successes, with nothing left to do about it. And the fact was not even false.
 * Luffy really does live in Fuchsia; `member_of` is simply the wrong shape for
 * saying it, and the graph ended up without the link.
 *
 * So the disagreement is computed while the card is still on screen, and the
 * card offers the predicates that would accept these two ends. What these tests
 * pin: that the check agrees with the trigger, that the queue carries it, that
 * choosing an alternative really writes that predicate, and that a bulk pass
 * never queues one up.
 *
 * And the case where forwards has no answer at all. « Les Toubibs 20
 * appartiennent à Wapol » is a group filed under a person: `member_of` is for
 * crews, and every predicate that does accept a group and a character says
 * something else — allié, ennemi, parle à. The reviewer was left choosing
 * between writing something false and rejecting something the chapter states in
 * as many words. Turned round it is ordinary — « Wapol dirige les Toubibs 20 »
 * — so the same two ends are offered the other way, and choosing one swaps
 * them.
 */

const SUMMARY = [
  'Au Partys Bar, Shanks refuse d’emmener Luffy en mer, jugeant qu’il ne sait',
  'pas nager et qu’il est bien trop jeune pour prendre le large avec eux.',
  '',
  'Plus tard, les pirates lèvent l’ancre et quittent le village de Fuchsia',
  'pour la dernière fois, sans que personne au bar ne s’en doute encore.',
].join('\n')

let world: SeededWorld
let chapterId: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 1,
    language: 'fr',
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

const EVIDENCE = [{ kind: 'text', ref: 'b1', excerpt: 'Au Partys Bar' }]

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

/** The character, the village, and the relation the model got wrong. */
async function proposeTheVillage(predicate = 'member_of') {
  const character = await propose('entity', {
    local_id: 'e1',
    node_type: 'character',
    label: 'Monkey D. Luffy',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const place = await propose('entity', {
    local_id: 'e2',
    node_type: 'place',
    label: 'Village de Fuchsia',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const relation = await propose('assertion', {
    subject: 'e1',
    predicate,
    object: 'e2',
    object_value: null,
    epistemic_status: 'inferred_strong',
  })
  return { character, place, relation }
}

/**
 * The Isshi-20 and the king who kept them: a group filed under a person.
 *
 * Nothing in the ontology joins a group to a character in that order without
 * changing what is being said, which is what makes this the case the forward
 * list cannot repair.
 */
async function proposeTheDoctors() {
  const doctors = await propose('entity', {
    local_id: 'e1',
    node_type: 'group',
    label: 'Toubibs 20',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const king = await propose('entity', {
    local_id: 'e2',
    node_type: 'character',
    label: 'Wapol',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const relation = await propose('assertion', {
    subject: 'e1',
    predicate: 'member_of',
    object: 'e2',
    object_value: null,
    epistemic_status: 'inferred_strong',
  })
  return { doctors, king, relation }
}

describe('the ontology check itself', () => {
  it('refuses what the database refuses, and says which end is at fault', () => {
    const mismatch = checkTypes('member_of', 'character', 'place')

    expect(mismatch).not.toBeNull()
    expect(mismatch!.subjectAccepted).toBe(true)
    expect(mismatch!.objectAccepted).toBe(false)
    expect(mismatch!.expectedObjectTypes).toEqual(['group'])
  })

  it('says nothing when the relation agrees', () => {
    expect(checkTypes('located_at', 'character', 'place')).toBeNull()
    expect(checkTypes('member_of', 'character', 'group')).toBeNull()
  })

  it('says nothing about a predicate it has never heard of', () => {
    // The ontology is stored as data so a reader may add a predicate; this
    // module must not declare one it does not know to be wrong.
    expect(checkTypes('boit_un_verre_avec', 'character', 'place')).toBeNull()
  })

  it('says nothing about a literal object, which the trigger does not check either', () => {
    expect(checkTypes('travels_to', 'character', null)).toBeNull()
  })

  it('offers a way out, with the spatial predicates first for a place', () => {
    const alternatives = alternativesFor('character', 'place')
    const keys = alternatives.map((a) => a.key)

    expect(keys).toContain('located_at')
    expect(keys).not.toContain('member_of')
    // Ontology order, not alphabetical: grouped by meaning, so the one the
    // reviewer wants is near the top rather than buried under `confirms`.
    expect(keys.indexOf('located_at')).toBeLessThan(keys.indexOf('same_as'))
  })

  it('offers the relation the other way round when this way round has no honest answer', () => {
    const mismatch = checkTypes('member_of', 'group', 'character')!

    expect(mismatch).not.toBeNull()
    // Forwards, everything on offer says something else: a group is not allied
    // to its master, and « appartient à » has no counterpart in this direction.
    expect(mismatch.alternatives.map((a) => a.key)).not.toContain('leads')
    // Backwards it is a sentence the graph has always been able to hold.
    expect(mismatch.reversedAlternatives.map((a) => a.key)).toContain('leads')
  })

  it('has nothing to reverse when the far end is a literal', () => {
    // « le Village de Fuchsia se rend à "la base de la Marine" » — the subject
    // is the end at fault here, and there is no node on the other side to make
    // a subject of. A real mismatch with an empty reversal, not no mismatch.
    const mismatch = checkTypes('travels_to', 'place', null)

    expect(mismatch).not.toBeNull()
    expect(mismatch!.subjectAccepted).toBe(false)
    expect(mismatch!.reversedAlternatives).toEqual([])
  })
})

describe('the review queue', () => {
  it('marks the relation before it is published, naming both types', async () => {
    await proposeTheVillage()

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.typeMismatch).not.toBeNull()
    expect(relation.typeMismatch!.predicate).toBe('member_of')
    expect(relation.typeMismatch!.subjectType).toBe('character')
    expect(relation.typeMismatch!.objectType).toBe('place')
    expect(relation.typeMismatch!.alternatives.map((a) => a.key)).toContain(
      'located_at',
    )
  })

  it('carries the reversed reading to the card', async () => {
    await proposeTheDoctors()

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.typeMismatch!.reversedAlternatives.map((a) => a.key)).toContain(
      'leads',
    )
  })

  it('leaves a well-typed relation alone', async () => {
    await proposeTheVillage('located_at')

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.typeMismatch).toBeNull()
  })

  it('reads the type of an end already in the graph, not only of one proposed here', async () => {
    const existing = await createEntity(world, 'place', 1)
    await addLabel(world, existing, 'Village de Fuchsia', 'true_name', 1, 100)

    await propose('entity', {
      local_id: 'e1',
      node_type: 'character',
      label: 'Monkey D. Luffy',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    await propose('assertion', {
      subject: 'e1',
      predicate: 'member_of',
      object: existing,
      object_value: null,
      epistemic_status: 'inferred_strong',
    })

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.typeMismatch?.objectType).toBe('place')
  })

  it('says nothing when a local id is claimed by two proposals of different types', async () => {
    // Slices number their entities independently, so `e1` in one is not `e1` in
    // the next. Putting a red block on a card because of the other slice's
    // entity would be worse than staying quiet.
    await propose('entity', {
      local_id: 'e1',
      node_type: 'character',
      label: 'Monkey D. Luffy',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    await propose('entity', {
      local_id: 'e1',
      node_type: 'group',
      label: 'Équipage du Roux',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    await propose('entity', {
      local_id: 'e2',
      node_type: 'place',
      label: 'Village de Fuchsia',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    await propose('assertion', {
      subject: 'e1',
      predicate: 'member_of',
      object: 'e2',
      object_value: null,
      epistemic_status: 'inferred_strong',
    })

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.typeMismatch).toBeNull()
  })
})

describe('publishing', () => {
  it('still refuses the relation as proposed — the database is the guarantee', async () => {
    const items = await proposeTheVillage()

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.character, decision: 'accept' },
      { reviewItemId: items.place, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    expect(result.entitiesCreated).toBe(2)
    expect(result.assertionsCreated).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toMatch(/member_of/)
  })

  it('writes the predicate the reviewer chose instead, and the link exists', async () => {
    const items = await proposeTheVillage()
    const payload = await payloadOf(items.relation)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.character, decision: 'accept' },
      { reviewItemId: items.place, decision: 'accept' },
      {
        reviewItemId: items.relation,
        decision: 'correct',
        correctedPayload: { ...payload, predicate: 'located_at' },
      },
    ])

    expect(result.failures).toEqual([])
    expect(result.assertionsCreated).toBe(1)

    const stored = await raw<Array<{ predicate: string; proposed_by: string }>>`
      SELECT predicate, proposed_by FROM assertions WHERE user_id = ${world.userId}`
    expect(stored).toHaveLength(1)
    expect(stored[0]!.predicate).toBe('located_at')
    // The model found the fact; the reviewer chose the shape. The row says so.
    expect(stored[0]!.proposed_by).toBe('user')
  })

  it('writes the relation the other way round when the reviewer turned it round', async () => {
    const items = await proposeTheDoctors()
    const payload = await payloadOf(items.relation)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.doctors, decision: 'accept' },
      { reviewItemId: items.king, decision: 'accept' },
      {
        reviewItemId: items.relation,
        decision: 'correct',
        // What the card sends when « Wapol dirige Toubibs 20 » is chosen: the
        // ends change places and the predicate with them.
        correctedPayload: {
          ...payload,
          predicate: 'leads',
          subject: payload.object,
          object: payload.subject,
        },
      },
    ])

    expect(result.failures).toEqual([])
    expect(result.assertionsCreated).toBe(1)

    const stored = await raw<Array<{ predicate: string; subject: string; object: string }>>`
      SELECT a.predicate,
             s.label AS subject,
             o.label AS object
        FROM assertions a
        JOIN entity_labels s ON s.entity_id = a.subject_entity_id
        JOIN entity_labels o ON o.entity_id = a.object_entity_id
       WHERE a.user_id = ${world.userId}`

    expect(stored).toHaveLength(1)
    expect(stored[0]!.predicate).toBe('leads')
    // The king commands the doctors, not the other way about.
    expect(stored[0]!.subject).toBe('Wapol')
    expect(stored[0]!.object).toBe('Toubibs 20')
  })
})

async function payloadOf(itemId: string): Promise<Record<string, unknown>> {
  const rows = await raw<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM review_items WHERE id = ${itemId}`
  return rows[0]!.payload
}
