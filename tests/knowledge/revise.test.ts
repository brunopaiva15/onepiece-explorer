import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { retractAssertion, reviseAssertion } from '@/domains/knowledge/revise.ts'
import { entityCandidates } from '@/domains/knowledge/candidates.ts'
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
 * The fact that was never true.
 *
 * Chapter 19 shows Shanks remembering Baggy — « He has a flashback about their
 * time as fellow pirates » — and the extraction wrote « Baggy appartient à
 * l'Équipage du Roux ». The two of them were cabin boys on Roger's ship;
 * Shanks' own crew does not exist yet and Baggy is never in it. Every check the
 * pipeline owns passed: `member_of` takes a group, the object is a group, the
 * excerpt is anchored word for word. The fiche then prints it as « affirmé »,
 * in the typeface of everything true.
 *
 * These tests pin the two answers the fiche now has, and what each one costs.
 * The claim stops being visible everywhere at once; the row survives with its
 * evidence, because a record that cannot be read is not a record; the reader's
 * chapter never moves, since correcting what a fact says does not change when
 * it could be known; and the verdict is filed against the proposal's
 * fingerprint, so re-importing the chapter does not ask the same question again.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([19, 60])
})

afterAll(async () => {
  await closeDb()
})

const QUOTE = 'He has a flashback about their time as fellow pirates.'
const FINGERPRINT = 'fp-ch19-baggy-member-of-red-hair'

interface Scene {
  baggy: string
  redHair: string
  rogerCrew: string
  assertionId: string
}

/** Chapter 19 as it was published: Baggy filed into the wrong crew. */
async function misreadFlashback(): Promise<Scene> {
  const baggy = await createEntity(world, 'character', 9)
  await addLabel(world, baggy, 'Baggy le Clown', 'true_name', 9, 100)

  const redHair = await createEntity(world, 'group', 1)
  await addLabel(world, redHair, 'Équipage du Roux', 'alias', 1, 50)

  const rogerCrew = await createEntity(world, 'group', 19)
  await addLabel(world, rogerCrew, 'Équipage de Roger', 'alias', 19, 50)

  const assertionId = await addAssertion(world, {
    subject: baggy,
    predicate: 'member_of',
    object: redHair,
    knowledgeFrom: 19,
  })
  await addQuote(world, { assertionId, chapterNumber: 19, text: QUOTE })

  await raw`
    UPDATE assertions SET proposal_fingerprint = ${FINGERPRINT}
     WHERE id = ${assertionId}
  `

  return { baggy, redHair, rogerCrew, assertionId }
}

async function statusOf(
  assertionId: string,
): Promise<{ review_status: string; superseded_by: string | null }> {
  const rows = await raw<Array<{ review_status: string; superseded_by: string | null }>>`
    SELECT review_status, superseded_by FROM assertions WHERE id = ${assertionId}
  `
  return rows[0]!
}

describe('taking back a fact that is not one', () => {
  it('removes it from the sheet, in both directions', async () => {
    const scene = await misreadFlashback()

    const result = await retractAssertion(world.userId, {
      assertionId: scene.assertionId,
      comment: 'Ils naviguaient sous Roger, pas sous Shanks.',
    })

    expect(result.alreadyDone).toBe(false)
    expect(result.predicate).toBe('member_of')

    // The page the reader was looking at, and the crew's own page, which held
    // the same sentence from the other side.
    const baggy = await getEntitySheet(world.userId, 60, scene.baggy)
    expect(baggy!.facts).toHaveLength(0)

    const crew = await getEntitySheet(world.userId, 60, scene.redHair)
    expect(crew!.facts).toHaveLength(0)
  })

  it('keeps the row, its evidence and its provenance', async () => {
    const scene = await misreadFlashback()
    await retractAssertion(world.userId, { assertionId: scene.assertionId })

    /*
     * Rejected, not deleted. « The graph once said this, and here is the panel
     * it read » has to stay answerable — it is the difference between a
     * correction and a quiet rewrite.
     */
    expect((await statusOf(scene.assertionId)).review_status).toBe('rejected')

    const quotes = await raw<Array<{ excerpt: string }>>`
      SELECT excerpt FROM evidence WHERE assertion_id = ${scene.assertionId}
    `
    expect(quotes.map((row) => row.excerpt)).toEqual([QUOTE])

    const audit = await raw<Array<{ action: string; subject_id: string }>>`
      SELECT action, subject_id FROM audit_log WHERE user_id = ${world.userId}
    `
    expect(audit).toEqual([
      { action: 'assertion_retracted', subject_id: scene.assertionId },
    ])
  })

  it('files the verdict so a re-import does not propose it again', async () => {
    const scene = await misreadFlashback()
    await retractAssertion(world.userId, {
      assertionId: scene.assertionId,
      comment: 'Faux.',
    })

    const decisions = await raw<
      Array<{ decision: string; proposal_fingerprint: string; comment: string | null }>
    >`
      SELECT decision, proposal_fingerprint, comment FROM review_decisions
       WHERE user_id = ${world.userId}
    `
    expect(decisions).toEqual([
      { decision: 'reject', proposal_fingerprint: FINGERPRINT, comment: 'Faux.' },
    ])
  })

  it('is idempotent, and says so', async () => {
    const scene = await misreadFlashback()
    await retractAssertion(world.userId, { assertionId: scene.assertionId })
    const again = await retractAssertion(world.userId, {
      assertionId: scene.assertionId,
    })

    expect(again.alreadyDone).toBe(true)
  })

  it('refuses an assertion belonging to somebody else', async () => {
    const scene = await misreadFlashback()
    const stranger = await seedWorld([19])

    await expect(
      retractAssertion(stranger.userId, { assertionId: scene.assertionId }),
    ).rejects.toThrow('Assertion introuvable.')

    expect((await statusOf(scene.assertionId)).review_status).toBe('accepted')
  })

  it('sends the reader to the correction when one has already replaced it', async () => {
    const scene = await misreadFlashback()
    await reviseAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.rogerCrew,
    })

    // Retracting the superseded row would leave its replacement standing while
    // reporting success — the fact would still be on the page.
    await expect(
      retractAssertion(world.userId, { assertionId: scene.assertionId }),
    ).rejects.toThrow('déjà été remplacé')
  })
})

describe('correcting what a fact says', () => {
  it('moves it to the crew it was about, keeping the chapter and the proof', async () => {
    const scene = await misreadFlashback()

    const result = await reviseAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.rogerCrew,
    })

    expect(result.changed).toEqual(['object'])
    expect(result.evidenceCopied).toBe(1)

    const sheet = await getEntitySheet(world.userId, 60, scene.baggy)
    expect(sheet!.facts).toHaveLength(1)
    expect(sheet!.facts[0]!.otherId).toBe(scene.rogerCrew)
    expect(sheet!.facts[0]!.knowledgeFromChapter).toBe(19)
    expect(sheet!.facts[0]!.evidence[0]!.excerpt).toBe(QUOTE)

    // And nothing of it reaches a reader who has not got there.
    const early = await getEntitySheet(world.userId, 9, scene.baggy)
    expect(early!.facts).toHaveLength(0)
  })

  it('changes the relation when the fact was right and the verb was not', async () => {
    const scene = await misreadFlashback()

    const result = await reviseAssertion(world.userId, {
      assertionId: scene.assertionId,
      predicate: 'allied_with',
    })

    expect(result.changed).toEqual(['predicate'])
    expect(result.previousPredicate).toBe('member_of')

    const sheet = await getEntitySheet(world.userId, 60, scene.baggy)
    expect(sheet!.facts).toHaveLength(1)
    expect(sheet!.facts[0]!.predicate).toBe('allied_with')
    // Still about the same crew: one thing changed, and only one.
    expect(sheet!.facts[0]!.otherId).toBe(scene.redHair)
  })

  it('rewrites a literal value without touching the entity it belongs to', async () => {
    const scene = await misreadFlashback()
    const spoken = await addAssertion(world, {
      subject: scene.baggy,
      predicate: 'travels_to',
      objectValue: { value: 'la base de la Marne' },
      knowledgeFrom: 19,
    })

    const result = await reviseAssertion(world.userId, {
      assertionId: spoken,
      objectValue: 'la base de la Marine',
    })

    expect(result.changed).toEqual(['value'])
    expect(result.value).toBe('la base de la Marine')

    const sheet = await getEntitySheet(world.userId, 60, scene.baggy)
    const literal = sheet!.facts.find((fact) => fact.predicate === 'travels_to')
    expect(literal!.literalValue).toBe('la base de la Marine')
  })

  it('writes the correction as the reader’s own, and locks it', async () => {
    const scene = await misreadFlashback()
    const result = await reviseAssertion(world.userId, {
      assertionId: scene.assertionId,
      objectEntityId: scene.rogerCrew,
      comment: 'Roger, pas Shanks.',
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

    expect((await statusOf(scene.assertionId)).superseded_by).toBe(result.assertionId)

    const decisions = await raw<
      Array<{ decision: string; corrected_payload: { objectEntityId?: string } }>
    >`
      SELECT decision, corrected_payload FROM review_decisions
       WHERE user_id = ${world.userId}
    `
    expect(decisions[0]!.decision).toBe('correct')
    expect(decisions[0]!.corrected_payload.objectEntityId).toBe(scene.rogerCrew)
  })

  it('refuses a relation the ontology does not accept at that end', async () => {
    const scene = await misreadFlashback()

    // `owns` takes an object, not a group. The database refuses the insert, and
    // the refusal is what stops a correction being a way around ADR 0004.
    await expect(
      reviseAssertion(world.userId, {
        assertionId: scene.assertionId,
        predicate: 'owns',
      }),
    ).rejects.toThrow()

    expect((await statusOf(scene.assertionId)).review_status).toBe('accepted')
  })

  it('refuses a predicate the ontology has never heard of', async () => {
    const scene = await misreadFlashback()

    await expect(
      reviseAssertion(world.userId, {
        assertionId: scene.assertionId,
        predicate: 'sails_with_probably',
      }),
    ).rejects.toThrow('Prédicat inconnu')
  })

  it('does not turn a relation into a sentence, or the reverse', async () => {
    const scene = await misreadFlashback()

    await expect(
      reviseAssertion(world.userId, {
        assertionId: scene.assertionId,
        objectValue: 'l’équipage de Roger',
      }),
    ).rejects.toThrow('pointe vers une entité')
  })

  it('says nothing changed rather than writing a second identical row', async () => {
    const scene = await misreadFlashback()

    await expect(
      reviseAssertion(world.userId, {
        assertionId: scene.assertionId,
        objectEntityId: scene.redHair,
      }),
    ).rejects.toThrow('pointe déjà vers cette entité')

    const rows = await raw<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM assertions WHERE subject_entity_id = ${scene.baggy}
    `
    expect(rows[0]!.count).toBe('1')
  })

  it('refuses to correct a fact that has been taken back', async () => {
    const scene = await misreadFlashback()
    await retractAssertion(world.userId, { assertionId: scene.assertionId })

    await expect(
      reviseAssertion(world.userId, {
        assertionId: scene.assertionId,
        objectEntityId: scene.rogerCrew,
      }),
    ).rejects.toThrow('a été retiré')
  })
})

describe('which entity did you mean', () => {
  it('offers only what the relation accepts, and only what has been read', async () => {
    const scene = await misreadFlashback()

    const groups = await entityCandidates(world.userId, 60, {
      query: 'equipage',
      accepts: ['group'],
      exclude: [scene.redHair],
    })
    expect(groups.map((row) => row.entityId)).toEqual([scene.rogerCrew])

    /*
     * The same search at chapter 19's own eve. « Équipage de Roger » is named at
     * 19, so a reader at 10 has no right target — which is the answer, not a
     * failure: the fact is to be retracted, not repointed.
     */
    const early = await entityCandidates(world.userId, 10, {
      query: 'equipage',
      accepts: ['group'],
      exclude: [scene.redHair],
    })
    expect(early).toEqual([])
  })

  it('finds a name through an accent and a misspelling', async () => {
    const scene = await misreadFlashback()

    const byAccent = await entityCandidates(world.userId, 60, { query: 'Équipage de Roger' })
    expect(byAccent.map((row) => row.entityId)).toContain(scene.rogerCrew)

    // Baggy, Buggy: the two spellings every scanlation disagrees about.
    const misspelt = await entityCandidates(world.userId, 60, { query: 'Buggy' })
    expect(misspelt.map((row) => row.entityId)).toContain(scene.baggy)
  })

  it('keeps another library’s entities out of the list', async () => {
    await misreadFlashback()
    const stranger = await seedWorld([19])
    const theirs = await createEntity(stranger, 'group', 1)
    await addLabel(stranger, theirs, 'Équipage du Roux', 'alias', 1, 50)

    const mine = await entityCandidates(world.userId, 60, { query: 'roux' })
    expect(mine.map((row) => row.entityId)).not.toContain(theirs)
  })
})
