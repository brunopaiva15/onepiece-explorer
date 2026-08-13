import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { fuzzySearch } from '@/domains/search/fuzzy.ts'
import { expandNeighbours } from '@/domains/search/graph.ts'
import { lexicalSearch } from '@/domains/search/lexical.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * « Dix ans plus tard, Luffy quitte seul le Village de Fuchsia… · ENTITÉ »
 *
 * That is what searching for « Makino » returned: a whole sentence, presented
 * as somebody's name, under the same word as the character standing next to it
 * in the list. It is not a stray row — an event *is* an entity with a side
 * table, and its label *is* its summary, so the query that finds a name finds a
 * scene by the names inside it and every mode announced it as an entity.
 *
 * What that costs is not cosmetic. The reader is shown a sentence and told it
 * is a thing in the graph with a name; the honest answer, « ceci est une
 * scène », is the one that lets them tell it apart from the character it
 * mentions — which is the confusion this whole family of bugs is made of.
 */

const VOYAGE =
  'Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre ' +
  'la mer, sous le regard de Makino, Hoop Slap et des villageois.'

let world: SeededWorld
let luffy: string
let scene: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1])

  luffy = await createEntity(world, 'character', 1)
  await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

  // A scene, published the way publication publishes one: an entity, a row in
  // `events`, and a label carrying the summary so the graph has a name to show.
  scene = await createEntity(world, 'voyage', 1)
  await addEvent(world, scene, { summary: VOYAGE, shownIn: 1 })
  await addLabel(world, scene, VOYAGE, 'alias', 1, 10)
})

afterAll(async () => {
  await closeDb()
})

describe('what a search result says it is', () => {
  it('calls a scene a scene, not an entity', async () => {
    const hits = await lexicalSearch(world.userId, 1, 'Makino')

    const found = hits.filter((hit) => hit.entityId === scene)
    expect(found.length).toBeGreaterThan(0)
    for (const hit of found) expect(hit.kind).toBe('event')
    // And says which text matched, rather than claiming the sentence is a name.
    expect(found.some((hit) => hit.reason.includes('résumé'))).toBe(true)
  })

  it('still calls a character an entity', async () => {
    const hits = await lexicalSearch(world.userId, 1, 'Luffy')
    const found = hits.find((hit) => hit.entityId === luffy)

    expect(found?.kind).toBe('entity')
    expect(found?.reason).toContain('nom')
  })

  it('answers with one scene where it used to answer with two', async () => {
    /*
     * The label query and the `events` query both match a scene whose summary
     * contains the words — one saying « entité », the other « événement ». The
     * fusion deduplicates on `kind:id`, so the two disagreeing on the kind is
     * exactly what made them survive as two results for one scene.
     */
    const hits = await lexicalSearch(world.userId, 1, 'Fuchsia')
    const keys = hits
      .filter((hit) => hit.entityId === scene)
      .map((hit) => `${hit.kind}:${hit.id}`)

    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys).size).toBe(1)
  })

  it('says the same thing when the spelling was approximate', async () => {
    const hits = await fuzzySearch(world.userId, 1, 'Monkey D. Lufy')
    expect(hits.find((hit) => hit.entityId === luffy)?.kind).toBe('entity')
  })

  it('says the same thing when the match was on meaning', async () => {
    /*
     * The fourth mode had the same blind spot, and its own consequence: the
     * fusion keys on the kind *and* the id, so a scene the full-text mode calls
     * an event and this one calls an entity survives as two results for one
     * scene.
     */
    const { vectorStore, resetVectorStore } = await import('@/domains/search/index.ts')
    resetVectorStore()
    const store = await vectorStore()

    const vector = [0.1, 0.2, 0.3]
    await store.upsert([
      {
        userId: world.userId,
        workId: world.workId,
        subjectKind: 'entity',
        subjectId: scene,
        chapterNumber: 1,
        modelId: 'test',
        content: VOYAGE,
        vector,
      },
    ])

    const found = await store.search(world.userId, 1, vector)
    expect(found.find((hit) => hit.subjectId === scene)?.nodeType).toBe('voyage')
  })

  it('says the same thing about a neighbour reached through the graph', async () => {
    // The scene is a legitimate neighbour — Luffy takes part in it — and it
    // arrived in the list looking like another character.
    await addAssertion(world, {
      subject: luffy,
      predicate: 'participates_in',
      object: scene,
      knowledgeFrom: 1,
    })

    const hits = await expandNeighbours(world.userId, 1, [luffy])
    expect(hits.find((hit) => hit.entityId === scene)?.kind).toBe('event')
  })
})
