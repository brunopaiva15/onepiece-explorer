import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAnchorSources,
  filterExtraction,
  type OntologyView,
} from '@/domains/ai/anchoring.ts'
import type { Extraction } from '@/domains/ai/schemas.ts'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { closeDb, raw, resetDatabase, seedWorld, type SeededWorld } from '../helpers/db.ts'

/**
 * « Kaloo blesse », and then nothing.
 *
 * Chapter 183: a stray bullet hits the duck as he crosses the battlefield. The
 * model read it correctly, quoted it exactly — « a passing bullet hits Karoo
 * and Karoo falls to the ground painfully » — and wrote a relation with a
 * subject, a predicate, and both object fields null. Nobody fired the bullet in
 * the text, so there was no second entity to point at, and the model wrote the
 * verb anyway.
 *
 * Every check agreed. The predicate is in the ontology, the subject resolves,
 * the excerpt anchors, and the types cannot disagree because there is only one
 * type. So the card reached the review centre reading « Kaloo blesse » with an
 * « Accepter » button under it, and pressing « Publier » returned:
 *
 *     2 n'ont pas pu être appliquée(s) :
 *     new row for relation "assertions" violates check constraint
 *     "assertion_has_object"
 *
 * The database was right and it had been right since the first migration:
 * `assertion_has_object` demands an entity or a value. What was wrong is that
 * it was the *only* thing that knew, and it said so by its own name, after the
 * decision, to someone who was asked about a duck.
 *
 * What this pins, in the three places the rule now lives: extraction never
 * proposes one again, a card already in a queue says so before the button is
 * pressed, and publication refuses it in French rather than in SQL.
 */

const ONTOLOGY: OntologyView = {
  nodeTypes: new Set(NODE_TYPES.map((t) => t.key)),
  predicates: new Set(PREDICATES.map((p) => p.key)),
  // `injures` names the entity types its object may have, like every predicate
  // we ship. A user-defined one declaring none may carry a value — never
  // nothing.
  literalObjects: new Set<string>(),
}

const SUMMARY = [
  'Vivi demande à Kaloo s’il peut traverser le champ de bataille, et Kaloo',
  's’élance entre les soldats sans attendre la réponse.',
  '',
  'Une balle perdue atteint Kaloo, qui tombe lourdement ; Vivi crie, et Kaloo',
  'lui répond de se dépêcher pendant que Bon Kurei approche.',
].join('\n')

const EXCERPT = 'Vivi demande à Kaloo'

function sources() {
  return buildAnchorSources({
    textBlocks: [{ ref: 'b1', text: `${EXCERPT} s’il peut traverser le champ de bataille.` }],
    descriptions: [],
    allowedRefs: ['b1'],
    tolerateNoise: false,
  })
}

/** The duck, and the verb with nothing after it. */
function theDuck(object: string | null, value: string | null): Extraction {
  return {
    entities: [
      {
        local_id: 'e1',
        node_type: 'character',
        label: 'Kaloo',
        label_kind: 'true_name',
        source_term: null,
        naming_confident: true,
        evidence: [{ ref: 'b1', kind: 'text', excerpt: EXCERPT }],
        confidence: 0.9,
      },
      {
        local_id: 'e2',
        node_type: 'character',
        label: 'Vivi',
        label_kind: 'true_name',
        source_term: null,
        naming_confident: true,
        evidence: [{ ref: 'b1', kind: 'text', excerpt: EXCERPT }],
        confidence: 0.9,
      },
    ],
    assertions: [
      {
        subject: 'e1',
        predicate: 'injures',
        object,
        object_value: value,
        epistemic_status: 'explicit',
        evidence: [{ ref: 'b1', kind: 'text', excerpt: EXCERPT }],
        confidence: 0.5,
      },
    ],
    events: [],
    mysteries: [],
  }
}

describe('extraction', () => {
  it('quarantines a relation whose object is absent from both fields', () => {
    const result = filterExtraction(theDuck(null, null), sources(), ONTOLOGY, new Set())

    expect(result.accepted.assertions).toHaveLength(0)
    expect(result.quarantined).toHaveLength(1)
    expect(result.quarantined[0]!.reason).toBe('missing_object')
    // The reason has to teach, like every other one: where the fact belongs
    // when the other end has no name in the chapter.
    expect(result.quarantined[0]!.detail).toContain('événement')
  })

  it('treats a blank value as no object at all', () => {
    // `{ value: '' }` satisfies the constraint and states nothing. The column
    // being non-null is not the point; the relation having two ends is.
    const result = filterExtraction(theDuck(null, '   '), sources(), ONTOLOGY, new Set())

    expect(result.accepted.assertions).toHaveLength(0)
    expect(result.quarantined[0]!.reason).toBe('missing_object')
  })

  it('accepts the same relation once it has someone at the other end', () => {
    const result = filterExtraction(theDuck('e2', null), sources(), ONTOLOGY, new Set())

    expect(result.quarantined).toHaveLength(0)
    expect(result.accepted.assertions).toHaveLength(1)
  })
})

let world: SeededWorld
let chapterId: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 183,
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
      ${raw.json({
        evidence: [{ kind: 'text', ref: 'b1', excerpt: EXCERPT }],
        confidence: 0.5,
        ...payload,
      })},
      ${randomUUID()}, false, 0.5, 'proposed'
    )
  `
  return id
}

/** The cards as they sat in the queue of chapter 183. */
async function proposeTheDuck(object: string | null = null) {
  const duck = await propose('entity', {
    local_id: 'e1',
    node_type: 'character',
    label: 'Kaloo',
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })
  const relation = await propose('assertion', {
    subject: 'e1',
    predicate: 'injures',
    object,
    object_value: null,
    epistemic_status: 'explicit',
  })
  return { duck, relation }
}

describe('the review queue', () => {
  it('marks the card, so the reviewer knows before pressing Publier', async () => {
    await proposeTheDuck()

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.missingObject).toBe(true)
    // Nothing for the type check to say: there is no second type. That is
    // exactly why this signal had to exist next to it.
    expect(relation.typeMismatch).toBeNull()
  })

  it('says nothing about a relation that has both its ends', async () => {
    const target = await propose('entity', {
      local_id: 'e2',
      node_type: 'character',
      label: 'Vivi',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    expect(target).toBeTruthy()

    await proposeTheDuck('e2')

    const queue = await getReviewQueue(world.userId, runId)
    const relation = queue!.items.find((item) => item.category === 'assertion')!

    expect(relation.missingObject).toBe(false)
  })
})

describe('publishing', () => {
  it('refuses it in French, naming what is missing instead of the constraint', async () => {
    const items = await proposeTheDuck()

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: items.duck, decision: 'accept' },
      { reviewItemId: items.relation, decision: 'accept' },
    ])

    // The entity is published: one unwritable relation must not cost the
    // chapter everything else it proposed.
    expect(result.entitiesCreated).toBe(1)
    expect(result.assertionsCreated).toBe(0)
    expect(result.failures).toHaveLength(1)

    const reason = result.failures[0]!.reason
    expect(reason).not.toContain('assertion_has_object')
    expect(reason).not.toContain('violates check constraint')
    expect(reason).toContain('objet')
    // What to do about it, since nothing here is repairable.
    expect(reason).toContain('rejetez')
  })

  it('writes the relation once the object is there', async () => {
    await propose('entity', {
      local_id: 'e2',
      node_type: 'character',
      label: 'Vivi',
      label_kind: 'true_name',
      source_term: null,
      naming_confident: true,
    })
    const items = await proposeTheDuck('e2')

    const queue = await getReviewQueue(world.userId, runId)
    const result = await publishDecisions(
      world.userId,
      runId,
      queue!.items.map((item) => ({ reviewItemId: item.id, decision: 'accept' as const })),
    )

    expect(result.failures).toHaveLength(0)
    expect(result.assertionsCreated).toBe(1)
    expect(items.relation).toBeTruthy()
  })
})
