import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  devilFruitsFiledAsPowers,
  retypeDevilFruitsAsObjects,
  retypeEntity,
} from '@/domains/knowledge/retype.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The type you are allowed to be right about.
 *
 * The Bara Bara no Mi is a fruit — eaten, stolen, carried — and the graph filed
 * it as a power, beside the Bara Bara no Hou, which is the technique it grants.
 * Same chapter, same name, one of the two is a power. The type was decided at
 * extraction and there was nowhere to disagree with it afterwards.
 *
 * These tests pin what makes a retype a correction rather than a demolition:
 * the change reaches every row that is the same thing; a fact the new type
 * forbids is reported before anything is written, and rejected rather than
 * deleted when the reader goes ahead; and prose that only one type has a place
 * for is never orphaned by a change made in one click.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3])
})

afterAll(async () => {
  await closeDb()
})

async function typeOf(entityId: string): Promise<string> {
  const rows = await raw<Array<{ node_type: string }>>`
    SELECT node_type FROM entities WHERE id = ${entityId}
  `
  return rows[0]!.node_type
}

describe('changing what an entity is', () => {
  it('retypes the fruit and says so on the fiche', async () => {
    const fruit = await createEntity(world, 'power', 1)
    await addLabel(world, fruit, 'Bara Bara no Mi', 'true_name', 1, 100)

    const result = await retypeEntity(world.userId, {
      entityId: fruit,
      nodeType: 'object',
    })

    expect(result.applied).toBe(true)
    expect(result.previousNodeType).toBe('power')
    expect(result.conflicts).toHaveLength(0)

    const sheet = await getEntitySheet(world.userId, 3, fruit)
    expect(sheet!.nodeType).toBe('object')

    const audit = await raw<Array<{ action: string }>>`
      SELECT action FROM audit_log WHERE subject_id = ${fruit}
    `
    expect(audit.map((row) => row.action)).toContain('entity_retyped')
  })

  it('leaves the names, the first appearance and the facts where they were', async () => {
    const fruit = await createEntity(world, 'power', 1)
    await addLabel(world, fruit, 'Bara Bara no Mi', 'true_name', 2, 100)
    const baggy = await createEntity(world, 'character', 1)
    await addLabel(world, baggy, 'Baggy', 'true_name', 1, 100)
    await addAssertion(world, {
      subject: baggy,
      predicate: 'uses',
      object: fruit,
      knowledgeFrom: 2,
    })

    await retypeEntity(world.userId, { entityId: fruit, nodeType: 'object' })

    // A type is not a revelation: nothing about when this became knowable moved.
    const before = await getEntitySheet(world.userId, 1, fruit)
    expect(before!.labels).toHaveLength(0)

    const after = await getEntitySheet(world.userId, 2, fruit)
    expect(after!.displayLabel).toBe('Bara Bara no Mi')
    expect(after!.firstSeenChapter).toBe(1)
    // `uses` accepts an object and a power alike, so the fact is untouched.
    expect(after!.facts).toHaveLength(1)
    expect(after!.facts[0]!.predicate).toBe('uses')
  })

  it('reports the facts the new type forbids, and writes nothing yet', async () => {
    const fruit = await createEntity(world, 'object', 1)
    await addLabel(world, fruit, 'Bara Bara no Mi', 'true_name', 1, 100)
    const baggy = await createEntity(world, 'character', 1)
    await addLabel(world, baggy, 'Baggy', 'true_name', 1, 100)
    // `owns` accepts an object and refuses a power: filing the fruit back under
    // « Pouvoir » is exactly the change that cannot keep this.
    const owns = await addAssertion(world, {
      subject: baggy,
      predicate: 'owns',
      object: fruit,
      knowledgeFrom: 1,
    })

    const asked = await retypeEntity(world.userId, {
      entityId: fruit,
      nodeType: 'power',
    })

    expect(asked.applied).toBe(false)
    expect(asked.conflicts).toHaveLength(1)
    expect(asked.conflicts[0]).toMatchObject({
      assertionId: owns,
      predicate: 'owns',
      role: 'object',
      otherLabel: 'Baggy',
    })
    expect(asked.rejected).toBe(0)

    // Nothing moved. A question is not half a write.
    expect(await typeOf(fruit)).toBe('object')
    const [row] = await raw<Array<{ review_status: string }>>`
      SELECT review_status::text FROM assertions WHERE id = ${owns}
    `
    expect(row!.review_status).toBe('accepted')
  })

  it('rejects those facts when confirmed, and keeps their rows', async () => {
    const fruit = await createEntity(world, 'object', 1)
    const baggy = await createEntity(world, 'character', 1)
    await addLabel(world, baggy, 'Baggy', 'true_name', 1, 100)
    const owns = await addAssertion(world, {
      subject: baggy,
      predicate: 'owns',
      object: fruit,
      knowledgeFrom: 1,
    })

    const result = await retypeEntity(world.userId, {
      entityId: fruit,
      nodeType: 'power',
      confirm: true,
    })

    expect(result.applied).toBe(true)
    expect(result.rejected).toBe(1)
    expect(await typeOf(fruit)).toBe('power')

    /*
     * Rejected, not deleted. `review_status` is one of the two columns an
     * assertion may change after insertion, so the row, its provenance and its
     * evidence all survive a retype decided too fast.
     */
    const [row] = await raw<Array<{ review_status: string }>>`
      SELECT review_status::text FROM assertions WHERE id = ${owns}
    `
    expect(row!.review_status).toBe('rejected')

    const sheet = await getEntitySheet(world.userId, 3, fruit)
    expect(sheet!.facts).toHaveLength(0)

    // And the ids are in the audit entry, so it can be undone by hand.
    const [entry] = await raw<Array<{ detail: { rejectedAssertionIds: string[] } }>>`
      SELECT detail FROM audit_log
      WHERE subject_id = ${fruit} AND action = 'entity_retyped'
    `
    expect(entry!.detail.rejectedAssertionIds).toEqual([owns])
  })

  it('carries the change to every row that is the same thing', async () => {
    /*
     * A merge is a `same_as` assertion, not an operation on rows, so a fiche is
     * a component and « ceci est un objet » is true of all of it. Retyping only
     * the half the reader opened would leave the library holding two answers.
     */
    const seen = await createEntity(world, 'power', 1)
    const named = await createEntity(world, 'power', 2)
    await addAssertion(world, {
      subject: seen,
      predicate: 'same_as',
      object: named,
      knowledgeFrom: 3,
    })

    await retypeEntity(world.userId, { entityId: seen, nodeType: 'object' })

    expect(await typeOf(seen)).toBe('object')
    expect(await typeOf(named)).toBe('object')

    // Including from a boundary at which the two are still two nodes: the type
    // is a property of the thing, not of what has been read about it.
    const sheet = await getEntitySheet(world.userId, 1, seen)
    expect(sheet!.memberIds).toEqual([seen])
    expect(sheet!.nodeType).toBe('object')
  })

  it('refuses to strand an event summary or a mystery’s question', async () => {
    const battle = await createEntity(world, 'event', 1)
    await addEvent(world, battle, { summary: 'Baggy perd son chapiteau.' })

    await expect(
      retypeEntity(world.userId, { entityId: battle, nodeType: 'object' }),
    ).rejects.toThrow(/résumé d’événement/)

    // An event may still become a battle: the summary has somewhere to stay.
    const moved = await retypeEntity(world.userId, {
      entityId: battle,
      nodeType: 'battle',
    })
    expect(moved.applied).toBe(true)

    const question = await createEntity(world, 'mystery', 1)
    await addMystery(world, question, {
      question: 'Qui a dessiné la carte ?',
      openedIn: 1,
    })
    await expect(
      retypeEntity(world.userId, { entityId: question, nodeType: 'concept' }),
    ).rejects.toThrow(/question/)

    // And nothing becomes a mystery, because nothing here can write a question.
    const concept = await createEntity(world, 'concept', 1)
    await expect(
      retypeEntity(world.userId, { entityId: concept, nodeType: 'mystery' }),
    ).rejects.toThrow(/question/)
  })

  it('refuses an unknown type, a documentary node, and a change to nothing', async () => {
    const fruit = await createEntity(world, 'power', 1)

    await expect(
      retypeEntity(world.userId, { entityId: fruit, nodeType: 'fruit' }),
    ).rejects.toThrow(/inconnu/)

    await expect(
      retypeEntity(world.userId, { entityId: fruit, nodeType: 'power' }),
    ).rejects.toThrow(/déjà/)

    await expect(
      retypeEntity(world.userId, { entityId: fruit, nodeType: 'page' }),
    ).rejects.toThrow(/documents eux-mêmes|chapitre/i)

    const page = await createEntity(world, 'page', 1)
    await expect(
      retypeEntity(world.userId, { entityId: page, nodeType: 'object' }),
    ).rejects.toThrow(/documents eux-mêmes|chapitre/i)
  })

  it('refuses to retype somebody else’s entity', async () => {
    const stranger = await seedWorld([1])
    const theirs = await createEntity(stranger, 'power', 1)

    await expect(
      retypeEntity(world.userId, { entityId: theirs, nodeType: 'object' }),
    ).rejects.toThrow(/introuvable/)

    expect(await typeOf(theirs)).toBe('power')
  })

  it('counts a proposed fact as standing in the way', async () => {
    /*
     * The database validates an assertion's ends when it is inserted and never
     * looks again. A proposal accepted after a retype would therefore slip in
     * with ends the ontology forbids — so it is weighed here, while a rejected
     * one is not.
     */
    const fruit = await createEntity(world, 'object', 1)
    const baggy = await createEntity(world, 'character', 1)
    await addAssertion(world, {
      subject: baggy,
      predicate: 'owns',
      object: fruit,
      knowledgeFrom: 1,
      status: 'proposed',
    })
    await addAssertion(world, {
      subject: baggy,
      predicate: 'owns',
      object: fruit,
      knowledgeFrom: 2,
      status: 'rejected',
    })

    const asked = await retypeEntity(world.userId, {
      entityId: fruit,
      nodeType: 'power',
    })
    expect(asked.conflicts).toHaveLength(1)
  })
})

/**
 * The eighty nobody is going to click through.
 *
 * The ontology said a Devil Fruit *was* a power, in the description handed to
 * the extraction step, so a library imported before that was corrected has all
 * of them in the wrong place. One fiche at a time is right for one fruit.
 */
describe('reclassifying the Devil Fruits', () => {
  it('finds the fruits still filed as powers, and only those', async () => {
    const fruit = await createEntity(world, 'power', 1)
    await addLabel(world, fruit, 'Bara Bara no Mi', 'true_name', 1, 100)

    const technique = await createEntity(world, 'power', 1)
    await addLabel(world, technique, 'Bara Bara no Hou', 'true_name', 1, 100)

    const already = await createEntity(world, 'object', 1)
    await addLabel(world, already, 'Gomu Gomu no Mi', 'true_name', 1, 100)

    const found = await devilFruitsFiledAsPowers(world.userId)
    expect(found).toEqual([{ entityId: fruit, label: 'Bara Bara no Mi' }])
  })

  it('names a fruit once, however many names it carries', async () => {
    const fruit = await createEntity(world, 'power', 1)
    await addLabel(world, fruit, 'Bara Bara no Mi', 'true_name', 1, 100)
    // The English wording publication keeps so a catalogue can still match.
    await addLabel(world, fruit, 'Chop Chop no Mi', 'alias', 1, 5)

    const found = await devilFruitsFiledAsPowers(world.userId)
    expect(found).toHaveLength(1)
    // The name it is called by, not the search-only one.
    expect(found[0]!.label).toBe('Bara Bara no Mi')
  })

  it('moves them all and leaves the ones that would cost a fact', async () => {
    const clean = await createEntity(world, 'power', 1)
    await addLabel(world, clean, 'Gomu Gomu no Mi', 'true_name', 1, 100)

    const contested = await createEntity(world, 'power', 1)
    await addLabel(world, contested, 'Bara Bara no Mi', 'true_name', 1, 100)
    const baggy = await createEntity(world, 'character', 1)

    /*
     * A predicate of the reader's own, accepting a power and nothing else.
     *
     * The shipped ontology has no such relation — every predicate that takes a
     * power takes an object too, which is precisely why moving the fruits is
     * safe. But the ontology lives in data so that a user-created predicate
     * works like a built-in one (ADR 0004), and the whole point of reading the
     * `predicates` table rather than the shipped list is that this case is seen
     * at all.
     */
    await raw`
      INSERT INTO predicates (key, label_fr, subject_types, object_types, builtin)
      VALUES ('exerce_sur', 'exerce sur', ARRAY['power'], ARRAY['character'], false)
      ON CONFLICT (key) DO NOTHING
    `
    try {
      await addAssertion(world, {
        subject: contested,
        predicate: 'exerce_sur',
        object: baggy,
        knowledgeFrom: 1,
      })

      const report = await retypeDevilFruitsAsObjects(world.userId)

      expect(report.retyped).toEqual([{ entityId: clean, label: 'Gomu Gomu no Mi' }])
      expect(report.blocked).toEqual([
        { entityId: contested, label: 'Bara Bara no Mi', conflicts: 1 },
      ])
      expect(report.failed).toHaveLength(0)

      expect(await typeOf(clean)).toBe('object')
      // Untouched, fact included: a bulk pass never rejects one.
      expect(await typeOf(contested)).toBe('power')
      const [row] = await raw<Array<{ review_status: string }>>`
        SELECT review_status::text FROM assertions
        WHERE subject_entity_id = ${contested}
      `
      expect(row!.review_status).toBe('accepted')
    } finally {
      /*
       * `predicates` is ontology rather than data, so resetDatabase() does not
       * truncate it and this row would outlive the test that needed it. The
       * assertion pointing at it goes first, behind the same destructive
       * opt-in the reset uses: assertions are append-only, deleting one is
       * deliberate, and the database says so.
       */
      await raw.begin(async (tx) => {
        await tx`SELECT set_config('app.allow_destructive', 'on', true)`
        await tx`DELETE FROM assertions WHERE predicate = 'exerce_sur'`
        await tx`DELETE FROM predicates WHERE key = 'exerce_sur'`
      })
    }
  })

  it('counts a merged pair once', async () => {
    const seen = await createEntity(world, 'power', 1)
    await addLabel(world, seen, 'le fruit que Baggy a mangé no Mi', 'placeholder', 1, 10)
    const named = await createEntity(world, 'power', 2)
    await addLabel(world, named, 'Bara Bara no Mi', 'true_name', 2, 100)
    await addAssertion(world, {
      subject: seen,
      predicate: 'same_as',
      object: named,
      knowledgeFrom: 3,
    })

    const report = await retypeDevilFruitsAsObjects(world.userId)

    expect(report.retyped).toHaveLength(1)
    expect(report.failed).toHaveLength(0)
    expect(await typeOf(seen)).toBe('object')
    expect(await typeOf(named)).toBe('object')
  })
})
