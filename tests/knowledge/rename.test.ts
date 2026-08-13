import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { renameEntityLabel } from '@/domains/knowledge/rename.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
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

  it('refuses a name the entity already carries', async () => {
    const zoro = await createEntity(world, 'character', 1)
    await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 1, 100)
    await addLabel(world, zoro, 'Zoro', 'alias', 1, 50)

    await expect(
      renameEntityLabel(world.userId, {
        labelId: await labelIdOf(zoro, 'Zoro'),
        label: 'Roronoa Zoro',
      }),
    ).rejects.toThrow(/porte déjà le nom/)

    expect((await labelsOf(zoro)).map((row) => row.label)).toEqual([
      'Roronoa Zoro',
      'Zoro',
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
