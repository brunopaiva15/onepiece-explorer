import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { repointAssertion } from '@/domains/knowledge/repoint.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import {
  addAssertion,
  addLabel,
  addQuote,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The fact that was about someone else.
 *
 * Chapter 41 says Usopp should board « as captain, which Luffy instantly
 * states is his job », and the extraction read it correctly: Luffy leads the
 * crew. It then aimed that relation at « Équipage du Capitaine Usopp », the
 * band of children from chapter 27, because Luffy's own crew is not a node —
 * the story does not name it for another fifty chapters, so nothing ever
 * proposed one. Every mechanism the pipeline owns said yes: the predicate takes
 * a group, the object is a group, the excerpt is anchored word for word.
 *
 * These tests pin what makes the correction a correction. The wrong claim stops
 * being visible everywhere at once; the row itself survives with its evidence
 * intact, because a superseded assertion that cannot be read is not a record;
 * the reader's chapter is not moved, since correcting *who* a fact is about
 * does not change *when* it could be known; and the replacement is locked, so
 * re-importing the chapter cannot hand the graph back to the model.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([27, 41])
})

afterAll(async () => {
  await closeDb()
})

const QUOTE =
  'Luffy and Zoro tell him to get on board the ship with them as captain, ' +
  'which Luffy instantly states is his job.'

const FINGERPRINT = 'fp-ch41-luffy-leads-crew'

interface Scene {
  luffy: string
  usoppCrew: string
  luffyCrew: string
  assertionId: string
}

/** Chapter 41 as it was published: the relation aimed at the wrong crew. */
async function misfiledScene(): Promise<Scene> {
  const luffy = await createEntity(world, 'character', 1)
  await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

  const usoppCrew = await createEntity(world, 'group', 27)
  await addLabel(world, usoppCrew, 'Équipage du Capitaine Usopp', 'alias', 27, 50)

  const luffyCrew = await createEntity(world, 'group', 5)
  await addLabel(world, luffyCrew, 'Équipage de Luffy', 'placeholder', 5, 10)

  const assertionId = await addAssertion(world, {
    subject: luffy,
    predicate: 'leads',
    object: usoppCrew,
    knowledgeFrom: 41,
  })
  await addQuote(world, { assertionId, chapterNumber: 41, text: QUOTE })

  /*
   * The fingerprint the extraction step computes for a proposal, which the
   * fixture helper has no reason to write and which this repair depends on: it
   * is the key the decision is filed under, and the reason a re-import of
   * chapter 41 does not queue the same wrong relation all over again.
   */
  await raw`
    UPDATE assertions SET proposal_fingerprint = ${FINGERPRINT}
     WHERE id = ${assertionId}
  `

  return { luffy, usoppCrew, luffyCrew, assertionId }
}

async function statusOf(
  assertionId: string,
): Promise<{ review_status: string; superseded_by: string | null }> {
  const rows = await raw<Array<{ review_status: string; superseded_by: string | null }>>`
    SELECT review_status, superseded_by FROM assertions WHERE id = ${assertionId}
  `
  return rows[0]!
}

describe('sending a relation to the entity it was about', () => {
  it('moves the fact off the wrong crew and onto the right one', async () => {
    const scene = await misfiledScene()

    const result = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    expect(result.alreadyDone).toBe(false)
    expect(result.predicate).toBe('leads')
    expect(result.fromEntityId).toBe(scene.usoppCrew)
    expect(result.toEntityId).toBe(scene.luffyCrew)

    // The sheet is the place the defect was visible, so it is the place the
    // correction has to show. « Appartenances » must name one crew, the right one.
    const sheet = await getEntitySheet(world.userId, 41, scene.luffy)
    const crews = sheet!.facts.filter((fact) => fact.predicate === 'leads')
    expect(crews).toHaveLength(1)
    expect(crews[0]!.otherId).toBe(scene.luffyCrew)
  })

  it('keeps the superseded row, with the evidence still under it', async () => {
    const scene = await misfiledScene()

    const result = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    const previous = await statusOf(scene.assertionId)
    expect(previous.review_status).toBe('superseded')
    expect(previous.superseded_by).toBe(result.assertionId)

    /*
     * Copied, not moved. The old row is kept so « the graph once said this »
     * stays answerable, and an assertion whose citation has been taken away
     * cannot be checked — which would make keeping it pointless.
     */
    expect(result.evidenceCopied).toBe(1)
    const quotes = await raw<Array<{ assertion_id: string; excerpt: string }>>`
      SELECT assertion_id, excerpt FROM evidence
       WHERE assertion_id IN (${scene.assertionId}, ${result.assertionId})
    `
    expect(quotes).toHaveLength(2)
    expect(new Set(quotes.map((row) => row.excerpt))).toEqual(new Set([QUOTE]))
  })

  it('leaves the reader’s chapter where it was', async () => {
    const scene = await misfiledScene()
    const result = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    const rows = await raw<
      Array<{ knowledge_from_chapter: number; observed_in_chapter: number }>
    >`
      SELECT knowledge_from_chapter, observed_in_chapter
        FROM assertions WHERE id = ${result.assertionId}
    `
    expect(rows[0]!.knowledge_from_chapter).toBe(41)
    expect(rows[0]!.observed_in_chapter).toBe(41)

    // And nothing of it reaches a reader who has not got there.
    const early = await getEntitySheet(world.userId, 27, scene.luffy)
    expect(early!.facts.filter((fact) => fact.predicate === 'leads')).toHaveLength(0)
  })

  it('writes the correction as the reader’s own, and locks it', async () => {
    const scene = await misfiledScene()
    const result = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
      comment: 'Le chapitre parle de l’équipage de Luffy.',
    })

    const rows = await raw<
      Array<{ proposed_by: string; locked: boolean; epistemic_status: string }>
    >`
      SELECT proposed_by, locked, epistemic_status
        FROM assertions WHERE id = ${result.assertionId}
    `
    expect(rows[0]).toMatchObject({
      proposed_by: 'user',
      locked: true,
      epistemic_status: 'user_validated',
    })

    /*
     * The decision, filed against the original proposal's fingerprint. This is
     * what makes the correction survive a re-import: the extraction step
     * recomputes the same fingerprint, finds a decision, and does not ask again.
     */
    const decisions = await raw<
      Array<{ decision: string; proposal_fingerprint: string }>
    >`
      SELECT decision, proposal_fingerprint FROM review_decisions
       WHERE user_id = ${world.userId}
    `
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.decision).toBe('correct')
    expect(decisions[0]!.proposal_fingerprint).toBe(FINGERPRINT)
  })

  it('still repoints a row too old to carry a fingerprint', async () => {
    const scene = await misfiledScene()
    await raw`
      UPDATE assertions SET proposal_fingerprint = NULL WHERE id = ${scene.assertionId}
    `

    const result = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    // The correction lands; there is simply no fingerprint to file a decision
    // under, and inventing one would key it to a proposal that never existed.
    expect(result.toEntityId).toBe(scene.luffyCrew)
    const decisions = await raw<Array<{ decision: string }>>`
      SELECT decision FROM review_decisions WHERE user_id = ${world.userId}
    `
    expect(decisions).toHaveLength(0)
  })

  it('runs twice without stacking a second correction', async () => {
    const scene = await misfiledScene()
    const first = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    const second = await repointAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.luffyCrew,
    })

    expect(second.alreadyDone).toBe(true)
    expect(second.assertionId).toBe(first.assertionId)

    const rows = await raw<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM assertions
       WHERE subject_entity_id = ${scene.luffy} AND predicate = 'leads'
    `
    expect(rows[0]!.count).toBe('2')
  })

  it('refuses a target the ontology does not accept at that end', async () => {
    const scene = await misfiledScene()
    const koby = await createEntity(world, 'character', 2)

    // `leads` takes a group. The database refuses the insert, and the refusal
    // is what stops a repoint being a way around ADR 0004.
    await expect(
      repointAssertion(world.userId, {
        assertionId: scene.assertionId,
        objectEntityId: koby,
      }),
    ).rejects.toThrow()

    expect((await statusOf(scene.assertionId)).review_status).toBe('accepted')
  })

  it('refuses an assertion belonging to somebody else', async () => {
    const scene = await misfiledScene()
    const stranger = await seedWorld([41])

    await expect(
      repointAssertion(stranger.userId, {
        assertionId: scene.assertionId,
        objectEntityId: scene.luffyCrew,
      }),
    ).rejects.toThrow('Assertion introuvable.')
  })
})
