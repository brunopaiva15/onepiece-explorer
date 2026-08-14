import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { renameEntityLabel } from '@/domains/knowledge/rename.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  addQuote,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * The name you are allowed to be right about.
 *
 * Helmeppo is called Hermep in French. No chapter says so — it is a convention
 * the reader holds — and the only place the graph asked was the review queue, at
 * the instant the entity was proposed. Miss it there and the wrong name was
 * permanent: on the fiche, on every edge, in the assistant's answers.
 *
 * These tests pin the three properties that make a rename a correction rather
 * than a new revelation, because each has a failure that would be worse than
 * the wrong name: a name dated today opens a hole in the boundary slider where
 * the character had none; a name replaced outright takes the portrait and the
 * scan-reader's search with it; a name corrected without being recorded comes
 * back at the next chapter, and eventually as a second entity.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3])
})

afterAll(async () => {
  await closeDb()
})

async function labelIdOf(entityId: string, label: string): Promise<string> {
  const rows = await raw<Array<{ id: string }>>`
    SELECT id FROM entity_labels
    WHERE entity_id = ${entityId} AND label = ${label}
  `
  const id = rows[0]?.id
  if (!id) throw new Error(`Aucun label « ${label} » sur ${entityId}.`)
  return id
}

async function labelsOf(
  entityId: string,
): Promise<Array<{ label: string; kind: string; precedence: number; revealed: number }>> {
  return raw<Array<{ label: string; kind: string; precedence: number; revealed: number }>>`
    SELECT label, kind::text AS kind, precedence, revealed_in_chapter AS revealed
    FROM entity_labels WHERE entity_id = ${entityId}
    ORDER BY precedence DESC, label
  `
}

describe('renaming an entity', () => {
  it('changes the displayed name without moving its revelation chapter', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Helmeppo', 'true_name', 3, 100)
    const labelId = await labelIdOf(helmeppo, 'Helmeppo')

    const result = await renameEntityLabel(world.userId, {
      labelId,
      label: 'Hermep',
    })

    expect(result.previousLabel).toBe('Helmeppo')
    expect(result.revealedInChapter).toBe(3)

    const after = await getEntitySheet(world.userId, 3, helmeppo)
    expect(after!.displayLabel).toBe('Hermep')
    expect(after!.labels[0]!.revealedInChapter).toBe(3)

    // And not a chapter earlier. The correction is the same name, better spelt:
    // a reader at chapter 2 still has not been told it.
    const before = await getEntitySheet(world.userId, 2, helmeppo)
    expect(before!.labels).toHaveLength(0)
    expect(before!.displayLabel).toBe('entité sans nom révélé')

    const audit = await raw<Array<{ action: string }>>`
      SELECT action FROM audit_log WHERE subject_id = ${helmeppo}
    `
    expect(audit.map((row) => row.action)).toContain('entity_renamed')
  })

  it('keeps the previous wording findable but never displayed', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Helmeppo', 'true_name', 3, 100)

    await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Helmeppo'),
      label: 'Hermep',
    })

    const labels = await labelsOf(helmeppo)
    expect(labels).toHaveLength(2)
    // Below every displayed kind: the illustration catalogues and the scans are
    // in English, so the old form has to stay searchable — and has to lose.
    expect(labels).toContainEqual({
      label: 'Helmeppo',
      kind: 'alias',
      precedence: 5,
      revealed: 3,
    })

    const sheet = await getEntitySheet(world.userId, 3, helmeppo)
    expect(sheet!.displayLabel).toBe('Hermep')
  })

  it('forgets the previous wording when asked to', async () => {
    const koby = await createEntity(world, 'character', 1)
    await addLabel(world, koby, 'Kobi', 'true_name', 1, 100)

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(koby, 'Kobi'),
      label: 'Koby',
      keepPrevious: false,
    })

    expect(result.keptAsAlias).toBe(false)
    expect(await labelsOf(koby)).toHaveLength(1)
  })

  it('records the correction as vocabulary, for the source wordings too', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    // What publication writes when it translates: the French guess as the
    // displayed name, the source's own wording beside it at precedence 5.
    await addLabel(world, helmeppo, 'Hermepo', 'true_name', 3, 100)
    await addLabel(world, helmeppo, 'Helmeppo', 'alias', 3, 5)

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Hermepo'),
      label: 'Hermep',
    })

    expect(result.glossaryTerms).toBe(2)

    const terms = await raw<
      Array<{ source: string; french: string; decided: number }>
    >`
      SELECT normalized_source AS source, french_term AS french,
             decided_in_chapter AS decided
      FROM glossary_terms WHERE work_id = ${world.workId}
      ORDER BY normalized_source
    `

    // The English wording is the one a later chapter actually contains, so it
    // is the one that must point at the corrected name — mapping only the bad
    // French guess would let the source produce that guess again.
    expect(terms).toEqual([
      { source: 'helmeppo', french: 'Hermep', decided: 3 },
      { source: 'hermepo', french: 'Hermep', decided: 3 },
    ])
  })

  it('settles no vocabulary from a search-only wording', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Hermep', 'true_name', 3, 100)
    await addLabel(world, helmeppo, 'Helmepo', 'alias', 3, 5)

    // Fixing a typo in the English form the catalogues match on says nothing
    // about what the character is called: the glossary answers « comment on
    // l'appelle en français », and that name has not moved.
    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Helmepo'),
      label: 'Helmeppo',
    })

    expect(result.glossaryTerms).toBe(0)
    const terms = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM glossary_terms
      WHERE work_id = ${world.workId}
    `
    expect(terms[0]!.count).toBe(0)

    const sheet = await getEntitySheet(world.userId, 3, helmeppo)
    expect(sheet!.displayLabel).toBe('Hermep')
  })

  it('follows the name into the sentences that spell it out', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Helmeppo', 'true_name', 3, 100)

    // An event is named by its own summary, and a mystery by its question:
    // correcting the label alone leaves the timeline saying Helmeppo under a
    // fiche that says Hermep.
    const beat = await createEntity(world, 'event', 3)
    await addEvent(world, beat, {
      summary: 'Helmeppo détruit les boulettes de riz de Rika.',
      shownIn: 3,
    })
    await addLabel(
      world,
      beat,
      'Helmeppo détruit les boulettes de riz de Rika.',
      'alias',
      3,
      10,
    )

    const question = await createEntity(world, 'mystery', 3)
    await addMystery(world, question, {
      question: 'Pourquoi Helmeppo garde-t-il ce loup ?',
      openedIn: 3,
    })

    // Whole words only: the name inside a longer word is not this name.
    const other = await createEntity(world, 'event', 3)
    await addEvent(world, other, { summary: 'Les Helmeppos sont deux.', shownIn: 3 })

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Helmeppo'),
      label: 'Hermep',
    })

    expect(result.proseRewritten).toBe(2)

    const prose = await raw<Array<{ text: string }>>`
      SELECT summary AS text FROM events WHERE work_id = ${world.workId}
      UNION ALL
      SELECT question FROM mysteries WHERE work_id = ${world.workId}
      ORDER BY text
    `
    expect(prose.map((row) => row.text)).toEqual([
      'Hermep détruit les boulettes de riz de Rika.',
      'Les Helmeppos sont deux.',
      'Pourquoi Hermep garde-t-il ce loup ?',
    ])

    // The truncated copy the search indexes follows too.
    expect((await labelsOf(beat))[0]!.label).toBe(
      'Hermep détruit les boulettes de riz de Rika.',
    )

    // And the character's own name is not rewritten twice: the corrected label
    // is the rename itself, the old wording the search-only copy.
    expect((await labelsOf(helmeppo)).map((row) => row.label)).toEqual([
      'Hermep',
      'Helmeppo',
    ])
  })

  it('leaves the chapter’s own text alone', async () => {
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Helmeppo', 'true_name', 1, 100)

    // Two entities, because a relation joins two things: the database refuses
    // an edge from a row to itself since 0028. What is under test here is the
    // quote hanging off the relation, not the relation.
    const morgan = await createEntity(world, 'character', 1)
    await addLabel(world, morgan, 'Morgan', 'true_name', 1, 100)

    const quoted = 'Helmeppo rit très fort.'
    const assertionId = await addAssertion(world, {
      subject: helmeppo,
      predicate: 'related_to',
      object: morgan,
      knowledgeFrom: 1,
    })
    await addQuote(world, { assertionId, chapterNumber: 1, text: quoted })

    await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Helmeppo'),
      label: 'Hermep',
    })

    // Evidence is anchored by finding an excerpt inside this text. Rewriting a
    // word here would either break every quote citing the block or, worse,
    // succeed quietly and have the graph claim a wording the source never used.
    const blocks = await raw<Array<{ text: string; excerpt: string }>>`
      SELECT b.text, e.excerpt FROM text_blocks b
      JOIN evidence e ON e.text_block_id = b.id
      WHERE b.user_id = ${world.userId}
    `
    expect(blocks[0]!.text).toBe(quoted)
    expect(blocks[0]!.excerpt).toBe(quoted)
  })

  it('promotes the display when the kind changes', async () => {
    const koby = await createEntity(world, 'character', 1)
    await addLabel(world, koby, 'le mousse', 'placeholder', 1, 10)
    await addLabel(world, koby, 'Coby', 'alias', 1, 50)

    await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(koby, 'le mousse'),
      label: 'Koby',
      kind: 'true_name',
    })

    const sheet = await getEntitySheet(world.userId, 1, koby)
    expect(sheet!.displayLabel).toBe('Koby')
    expect(sheet!.displayKind).toBe('true_name')
  })

  it('treats an accent as the same name rather than a second one', async () => {
    const entity = await createEntity(world, 'place', 1)
    await addLabel(world, entity, 'Village de Fuchsia', 'true_name', 1, 100)

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(entity, 'Village de Fuchsia'),
      label: 'Village de Fuschia',
    })

    expect(result.keptAsAlias).toBe(true)

    const again = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(entity, 'Village de Fuschia'),
      label: 'village de fuschia',
    })

    // Same normalised form: keeping the old spelling as a search name would
    // duplicate the row it was just rewritten from, and would find nothing new.
    expect(again.keptAsAlias).toBe(false)
    expect(again.glossaryTerms).toBe(0)
  })

  it('folds a duplicate into the name the entity already carries', async () => {
    /*
     * The ordinary case, not the exotic one. The character was corrected to
     * « Hermep » at chapter 1; chapter 3 reproposed « Helmeppo » and it was
     * published as a second name. Asking for the same correction again used to
     * be refused — « corrigez plutôt celui-là », about a row already right,
     * with nothing to do to it and the duplicate left where it was.
     */
    const helmeppo = await createEntity(world, 'character', 1)
    await addLabel(world, helmeppo, 'Hermep', 'true_name', 1, 100)
    await addLabel(world, helmeppo, 'Helmeppo', 'alias', 3, 50)

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(helmeppo, 'Helmeppo'),
      label: 'Hermep',
    })

    expect(result.folded).toBe(true)
    // The strongest of the pair survives, so a fold never demotes a display the
    // reader chose, and the earliest revelation with it: the entity really was
    // named this at chapter 1.
    expect(result.kind).toBe('true_name')
    expect(result.revealedInChapter).toBe(1)

    expect(await labelsOf(helmeppo)).toEqual([
      { label: 'Hermep', kind: 'true_name', precedence: 100, revealed: 1 },
      { label: 'Helmeppo', kind: 'alias', precedence: 5, revealed: 3 },
    ])

    const sheet = await getEntitySheet(world.userId, 3, helmeppo)
    expect(sheet!.displayLabel).toBe('Hermep')
    expect(sheet!.labels).toHaveLength(2)
  })

  it('keeps the earlier revelation when the duplicate is the older name', async () => {
    const koby = await createEntity(world, 'character', 1)
    await addLabel(world, koby, 'Kobi', 'alias', 1, 50)
    await addLabel(world, koby, 'Koby', 'true_name', 3, 100)

    const result = await renameEntityLabel(world.userId, {
      labelId: await labelIdOf(koby, 'Kobi'),
      label: 'Koby',
      keepPrevious: false,
    })

    expect(result.folded).toBe(true)
    // The name was given at chapter 1, misspelt. Dating it from 3 would hide a
    // name the reader had.
    expect(result.revealedInChapter).toBe(1)
    expect(await labelsOf(koby)).toEqual([
      { label: 'Koby', kind: 'true_name', precedence: 100, revealed: 1 },
    ])
  })

  it('refuses an empty name', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Higuma', 'true_name', 1, 100)

    await expect(
      renameEntityLabel(world.userId, {
        labelId: await labelIdOf(entity, 'Higuma'),
        label: '   ',
      }),
    ).rejects.toThrow(/vide/)
  })

  it('refuses a kind that is not one', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Higuma', 'true_name', 1, 100)

    await expect(
      renameEntityLabel(world.userId, {
        labelId: await labelIdOf(entity, 'Higuma'),
        label: 'Higuma le bandit',
        // What a POST can send, whatever the type says at the call site.
        kind: 'chef' as never,
      }),
    ).rejects.toThrow(/Nature de nom inconnue/)
  })

  it('refuses to rename another reader’s label', async () => {
    const entity = await createEntity(world, 'character', 1)
    await addLabel(world, entity, 'Helmeppo', 'true_name', 3, 100)
    const labelId = await labelIdOf(entity, 'Helmeppo')

    const stranger = await seedWorld([1])

    // The label id is the only thing an action takes from the browser, and the
    // ingestion role bypasses row-level security: ownership is a clause in the
    // query or it is nothing.
    await expect(
      renameEntityLabel(stranger.userId, { labelId, label: 'Hermep' }),
    ).rejects.toThrow(/introuvable/)

    expect((await labelsOf(entity))[0]!.label).toBe('Helmeppo')
  })
})
