import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import {
  addAssertion,
  addLabel,
  addQuote,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The other end of a fact, named.
 *
 * A sheet reading « fights · entité sans nom révélé » about a character whose
 * link, clicked, lands on a page titled « Higuma » is not a missing name — it
 * is the same name, fetched twice, once successfully. The reader is told the
 * graph knows less than it does, which is the one thing this product must never
 * get wrong in that direction.
 *
 * The fallback itself is right and stays: an entity really can have no name
 * revealed at the boundary, and inventing one would be worse. What these tests
 * pin is that it appears only then.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2])
})

afterAll(async () => {
  await closeDb()
})

describe('a sheet’s related entities', () => {
  it('names the other end of every fact', async () => {
    const luffy = await createEntity(world, 'character', 1)
    const higuma = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addLabel(world, higuma, 'Higuma', 'true_name', 1, 100)
    await addAssertion(world, {
      subject: luffy,
      predicate: 'fights',
      object: higuma,
      knowledgeFrom: 1,
    })

    const sheet = await getEntitySheet(world.userId, 2, luffy)

    expect(sheet).not.toBeNull()
    expect(sheet!.displayLabel).toBe('Monkey D. Luffy')
    expect(sheet!.facts).toHaveLength(1)
    expect(sheet!.facts[0]!.otherLabel).toBe('Higuma')
  })

  it('names it on an incoming fact too', async () => {
    const luffy = await createEntity(world, 'character', 1)
    const shanks = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addLabel(world, shanks, 'Shanks', 'true_name', 1, 100)
    await addAssertion(world, {
      subject: shanks,
      predicate: 'protects',
      object: luffy,
      knowledgeFrom: 1,
    })

    const sheet = await getEntitySheet(world.userId, 2, luffy)

    expect(sheet!.facts[0]!.direction).toBe('incoming')
    expect(sheet!.facts[0]!.otherLabel).toBe('Shanks')
  })

  it('says nothing rather than a later name when none is revealed yet', async () => {
    // The fallback earning its place: the entity is known at this boundary, the
    // name it will be given is not.
    const luffy = await createEntity(world, 'character', 1)
    const mystery = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addLabel(world, mystery, 'Dragon', 'true_name', 2, 100)
    await addAssertion(world, {
      subject: luffy,
      predicate: 'speaks_to',
      object: mystery,
      knowledgeFrom: 1,
    })

    const early = await getEntitySheet(world.userId, 1, luffy)
    expect(early!.facts[0]!.otherLabel).toBeNull()

    const later = await getEntitySheet(world.userId, 2, luffy)
    expect(later!.facts[0]!.otherLabel).toBe('Dragon')
  })

  it('dates a quotation by the chapter it was quoted from', async () => {
    // The chapter came from the panel and only from the panel, so evidence
    // anchored to a text block — most of what extraction produces — arrived
    // with none, and the sheet printed « · page 1 » under the excerpt: a
    // separator with nothing in front of it, on the line whose whole job is to
    // say where the fact was proved.
    const luffy = await createEntity(world, 'character', 1)
    const shanks = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addLabel(world, shanks, 'Shanks', 'true_name', 1, 100)
    const assertionId = await addAssertion(world, {
      subject: shanks,
      predicate: 'protects',
      object: luffy,
      knowledgeFrom: 1,
    })
    await addQuote(world, {
      assertionId,
      chapterNumber: 1,
      text: 'Shanks perd un bras pour sauver Luffy.',
    })

    const sheet = await getEntitySheet(world.userId, 2, luffy)

    expect(sheet!.facts[0]!.evidence[0]!.chapterNumber).toBe(1)
  })

  it('prefers the strongest name the other end carries', async () => {
    const luffy = await createEntity(world, 'character', 1)
    const zoro = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)
    await addLabel(world, zoro, 'le chasseur de pirates', 'placeholder', 1, 10)
    await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 1, 100)
    await addAssertion(world, {
      subject: luffy,
      predicate: 'seeks',
      object: zoro,
      knowledgeFrom: 1,
    })

    const sheet = await getEntitySheet(world.userId, 2, luffy)
    expect(sheet!.facts[0]!.otherLabel).toBe('Roronoa Zoro')
  })
})
