import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withIngest } from '@/db/boundary.ts'
import { knownEntitiesFor } from '@/domains/pipeline/steps/extract.ts'
import {
  addEvent,
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * La phrase qui servait de personnage.
 *
 * The extraction is handed the nodes already in the graph, by id, under
 * « utilisez leur identifiant tel quel ». An event is a node — a relation has to
 * be able to point at one — but its *name is its summary*, so it arrived in that
 * list as a sentence with three characters in it, sitting among the people and
 * the places.
 *
 * « Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre la
 * mer, sous le regard de Makino, Hoop Slap et des villageois. » was picked out
 * of it twice, two chapters apart: once as the subject of « se trouve à la Base
 * de la Marine », once as the subject of « utilise Secousse mortelle » — where
 * the passage is about Kuro. It is the only line in the prompt that reads like a
 * person and is not one, and a model looking for a subject reaches for the words
 * it recognises.
 *
 * So it is not offered any more. What that costs is a relation between a scene
 * of this chapter and a scene of an earlier one; what it buys is that a sentence
 * cannot stand in for someone. The scenes of the chapter being read keep their
 * `local_id` and are reachable exactly as before — `tests/ai/misfiled-categories`
 * covers that end.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2])
})

afterAll(async () => {
  await closeDb()
})

const listedAt = (chapterNumber: number) =>
  withIngest((db) =>
    knownEntitiesFor(db, { workId: world.workId, userId: world.userId, chapterNumber }),
  )

describe('what the extraction is allowed to name', () => {
  it('leaves a scene out, whichever of the three sorts it is', async () => {
    const summary =
      'Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre la mer.'

    for (const [nodeType, text] of [
      ['event', summary],
      ['voyage', summary],
      ['battle', 'Zoro affronte Baggy en duel.'],
    ] as const) {
      const scene = await createEntity(world, nodeType, 1)
      await addEvent(world, scene, { summary: text, shownIn: 1 })
      await addLabel(world, scene, text, 'alias', 1, 10)
    }

    expect(await listedAt(2)).toEqual([])
  })

  it('keeps the people, the places and the questions', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

    const village = await createEntity(world, 'place', 1)
    await addLabel(world, village, 'Village de Fuchsia', 'alias', 1, 50)

    // A mystery is a question, which nobody mistakes for a character — and a
    // chapter answering one opened long before is exactly what its id is for.
    const mystery = await createEntity(world, 'mystery', 1)
    await addMystery(world, mystery, { question: 'Où est le One Piece ?', openedIn: 1 })
    await addLabel(world, mystery, 'Où est le One Piece ?', 'alias', 1, 10)

    const listed = await listedAt(2)
    expect(listed.map((entry) => entry.id).sort()).toEqual(
      [luffy, village, mystery].sort(),
    )
  })

  it('offers a character under the name the graph displays', async () => {
    /*
     * One row per entity, and with no ordering it was whichever the planner
     * returned first: the English wording kept for searching, or the
     * placeholder from before the name was revealed. The model then writes a
     * relation about « Foosha Village » while the fiche says « Village de
     * Fuchsia », and the next chapter proposes a second entity for it.
     */
    const zoro = await createEntity(world, 'character', 1)
    await addLabel(world, zoro, 'l’homme au bandana', 'placeholder', 1, 10)
    await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 1, 100)
    await addLabel(world, zoro, 'Zoro Roronoa', 'alias', 1, 5)

    expect((await listedAt(2))[0]?.label).toBe('Roronoa Zoro')
  })

  it('still offers a figure the chapter has not named', async () => {
    // The not-yet-named silhouette is precisely the one the model must be able
    // to reference rather than re-create.
    const silhouette = await createEntity(world, 'character', 1)

    const listed = await listedAt(2)
    expect(listed.map((entry) => entry.id)).toEqual([silhouette])
    expect(listed[0]?.label).toBe('entité sans nom révélé à ce chapitre')
  })

  it('never reaches past the chapter being processed', async () => {
    const later = await createEntity(world, 'character', 2)
    await addLabel(world, later, 'Nami', 'true_name', 2, 100)

    expect(await listedAt(1)).toEqual([])
    expect((await listedAt(2))[0]?.id).toBe(later)
  })
})
