import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  addEvent,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Le voyage qui était resté une entité.
 *
 * Migration 0023 put back the scenes proposed as entities of type `event`. It
 * knew that one word. The ontology carries three occurrence types — `event`,
 * `battle`, `voyage` — and the model writes all three in an entity's
 * `node_type`, for the best of reasons: it classified the scene better. So the
 * *more precise* answer was the one nothing caught.
 *
 * « Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre la
 * mer » is a voyage. What it left behind is an `entities` row with no row in
 * `events`: absent from the chronology and from story mode, which read that
 * table, and present everywhere a node is offered — the search calls it
 * « entité », and the next chapter's extraction is handed a sentence naming
 * three characters as something a relation may point at.
 *
 * The migration is applied by `pnpm db:push` before this suite runs, so these
 * rows are inserted after the fact and it is re-run here. It is written to be
 * re-runnable: every clause is a `NOT EXISTS`, and the insert lands on a
 * primary key with `ON CONFLICT DO NOTHING`.
 */

const REPAIR = path.join(process.cwd(), 'drizzle', '0024_a_voyage_is_a_scene_too.sql')

const VOYAGE =
  'Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre ' +
  'la mer, sous le regard de Makino, Hoop Slap et des villageois.'

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1])
})

afterAll(async () => {
  await closeDb()
})

async function repair(): Promise<void> {
  await raw.unsafe(await readFile(REPAIR, 'utf8')).simple()
}

async function eventRow(
  entityId: string,
): Promise<{ summary: string | null; is_flashback: boolean; shown_in_chapter: number | null } | null> {
  const rows = await raw<
    Array<{ summary: string | null; is_flashback: boolean; shown_in_chapter: number | null }>
  >`
    SELECT summary, is_flashback, shown_in_chapter FROM events WHERE entity_id = ${entityId}
  `
  return rows[0] ?? null
}

describe('a scene the model named more precisely', () => {
  it('gains the events row it never had, keeping its name and its type', async () => {
    const scene = await createEntity(world, 'voyage', 1)
    await addLabel(world, scene, VOYAGE, 'alias', 1, 10)

    expect(await eventRow(scene)).toBeNull()

    await repair()

    const row = await eventRow(scene)
    // The sentence *is* the summary: that is how an event is named here.
    expect(row?.summary).toBe(VOYAGE)
    // Nothing in an entity proposal ever said this was a memory, and guessing
    // it from the wording would put the scene at the wrong place on the story
    // axis — the one thing the two-axis timeline exists to get right.
    expect(row?.is_flashback).toBe(false)
    expect(row?.shown_in_chapter).toBe(1)

    // Nothing is renamed and nothing is retyped: `voyage` is what the model
    // said after reading the passage, and re-guessing it is what migration 0022
    // explains at length that we do not do.
    const [entity] = await raw<Array<{ node_type: string }>>`
      SELECT node_type FROM entities WHERE id = ${scene}
    `
    expect(entity?.node_type).toBe('voyage')
  })

  it('repairs a combat the same way', async () => {
    const fight = await createEntity(world, 'battle', 1)
    await addLabel(world, fight, 'Zoro affronte Baggy en duel.', 'alias', 1, 10)

    await repair()

    expect((await eventRow(fight))?.summary).toBe('Zoro affronte Baggy en duel.')
  })

  it('leaves a scene that already has its row alone', async () => {
    const scene = await createEntity(world, 'battle', 1)
    await addLabel(world, scene, 'Zoro affronte Baggy en duel.', 'alias', 1, 10)
    await addEvent(world, scene, {
      summary: 'Zoro affronte Baggy et le découpe en morceaux.',
      isFlashback: true,
      shownIn: 1,
    })

    await repair()

    const row = await eventRow(scene)
    // The published summary and the flashback marker both survive: this row was
    // never the failure, and overwriting it would be inventing a correction
    // nobody asked for.
    expect(row?.summary).toBe('Zoro affronte Baggy et le découpe en morceaux.')
    expect(row?.is_flashback).toBe(true)
  })

  it('leaves a type someone chose by hand alone', async () => {
    /*
     * A retype from the fiche is a decision, not a misfiling — and writing a
     * summary for it would lock the node into the occurrence types, because
     * `retypeEntity` refuses to move a node that carries one. Nobody asked for
     * that, so the trace the retype leaves is read before anything is written.
     */
    const node = await createEntity(world, 'voyage', 1)
    await addLabel(world, node, 'Le Vogue Merry', 'true_name', 1, 100)
    await raw`
      INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
      VALUES (${world.userId}, 'entity_retyped', 'entity', ${node},
              ${raw.json({ from: 'object', to: 'voyage' })})
    `

    await repair()

    expect(await eventRow(node)).toBeNull()
  })

  it('leaves a node with no name at all alone', async () => {
    // An event is named by its summary, and a null summary would show as a
    // blank line in the chronology.
    const nameless = await createEntity(world, 'voyage', 1)

    await repair()

    expect(await eventRow(nameless)).toBeNull()
  })
})
