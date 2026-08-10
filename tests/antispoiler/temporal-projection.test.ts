import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  displayLabel,
  identityComponent,
  projectGraph,
} from '@/domains/temporal/projection.ts'
import {
  addAssertion,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Blocking tests 1, 2 and 3, against a real database.
 *
 * These are the ones the whole product is for. Each describes a way a wiki gets
 * it wrong, and each has to fail loudly rather than degrade quietly, because a
 * spoiler cannot be un-read.
 *
 *   1. An identity revealed at chapter 30 must be invisible at chapter 29 — and
 *      not merely unlabelled: the two figures must still be two nodes.
 *   2. A true name given at chapter 50 must not displace the alias at 49.
 *   3. A belief refuted later must remain visible in the past where it was held.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 20, 29, 30, 40, 49, 50])
})

afterAll(async () => {
  await closeDb()
})

describe('blocking test 1 — an identity revealed at 30 is invisible at 29', () => {
  /*
   * Two silhouettes seen separately, revealed at chapter 30 to be one person.
   * A wiki merges the pages and destroys the chapter-29 view. Here the merge is
   * an assertion dated to 30, so lowering the slider brings both back — not as a
   * historical note, but as two live nodes in the graph.
   */
  async function twoSilhouettesMergedAt(chapter: number): Promise<{
    scarf: string
    hood: string
  }> {
    const scarf = await createEntity(world, 'character', 12)
    const hood = await createEntity(world, 'character', 18)

    await addLabel(world, scarf, 'la silhouette au foulard', 'placeholder', 12, 10)
    await addLabel(world, hood, 'la silhouette encapuchonnée', 'placeholder', 18, 10)

    await addAssertion(world, {
      subject: scarf,
      predicate: 'same_as',
      object: hood,
      knowledgeFrom: chapter,
    })

    return { scarf, hood }
  }

  it('shows two nodes at 29 and one at 30', async () => {
    await twoSilhouettesMergedAt(30)

    const before = await projectGraph(world.userId, 29)
    expect(before.nodes).toHaveLength(2)
    expect(before.mergedAway).toBe(0)

    const after = await projectGraph(world.userId, 30)
    expect(after.nodes).toHaveLength(1)
    expect(after.mergedAway).toBe(1)
  })

  it('folds both entities into one component only from chapter 30', async () => {
    const { scarf, hood } = await twoSilhouettesMergedAt(30)

    expect(await identityComponent(world.userId, 29, scarf)).toEqual([scarf])
    expect(await identityComponent(world.userId, 30, scarf)).toEqual(
      [scarf, hood].sort(),
    )
  })

  it('keeps each silhouette its own name at 29', async () => {
    const { scarf, hood } = await twoSilhouettesMergedAt(30)

    const scarfLabel = await displayLabel(world.userId, 29, scarf)
    const hoodLabel = await displayLabel(world.userId, 29, hood)

    expect(scarfLabel?.label).toBe('la silhouette au foulard')
    expect(hoodLabel?.label).toBe('la silhouette encapuchonnée')
    expect(scarfLabel?.label).not.toBe(hoodLabel?.label)
  })

  it('does not fold on a merge the user has not confirmed', async () => {
    /*
     * `maybe_same_as` is a proposal sitting in the review queue. If the
     * projection folded on it, a suggestion would change the graph — which is
     * precisely the failure the review step exists to prevent, and it would be
     * invisible because the merged graph looks perfectly plausible.
     */
    const a = await createEntity(world, 'character', 5)
    const b = await createEntity(world, 'character', 6)
    await addLabel(world, a, 'le passeur', 'placeholder', 5, 10)
    await addLabel(world, b, 'le batelier', 'placeholder', 6, 10)

    await addAssertion(world, {
      subject: a,
      predicate: 'maybe_same_as',
      object: b,
      knowledgeFrom: 6,
    })

    const graph = await projectGraph(world.userId, 40)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.mergedAway).toBe(0)
  })

  it('carries the relations of both halves onto the merged node', async () => {
    const { scarf, hood } = await twoSilhouettesMergedAt(30)
    const port = await createEntity(world, 'place', 10)
    await addLabel(world, port, 'le port de Sarn', 'true_name', 10, 100)

    await addAssertion(world, {
      subject: scarf,
      predicate: 'located_at',
      object: port,
      knowledgeFrom: 12,
    })
    await addAssertion(world, {
      subject: hood,
      predicate: 'located_at',
      object: port,
      knowledgeFrom: 18,
    })

    const before = await projectGraph(world.userId, 29)
    // Two people, two separate visits to the same place.
    expect(before.edges).toHaveLength(2)

    const after = await projectGraph(world.userId, 30)
    // One person who went there twice: one edge, weight two. Two parallel edges
    // would double every relation of every merged character.
    expect(after.edges).toHaveLength(1)
    expect(after.edges[0]!.weight).toBe(2)
  })
})

describe('blocking test 2 — a true name at 50 does not displace the alias at 49', () => {
  async function characterNamedAt(chapter: number): Promise<string> {
    const entity = await createEntity(world, 'character', 20)
    await addLabel(world, entity, "l'homme au sabre ébréché", 'placeholder', 20, 10)
    await addLabel(world, entity, 'le Passeur', 'alias', 22, 50)
    await addLabel(world, entity, 'Kaelo Renn', 'true_name', chapter, 100)
    return entity
  }

  it('shows the alias at 49 and the true name at 50', async () => {
    const entity = await characterNamedAt(50)

    const before = await displayLabel(world.userId, 49, entity)
    expect(before?.label).toBe('le Passeur')
    expect(before?.kind).toBe('alias')

    const after = await displayLabel(world.userId, 50, entity)
    expect(after?.label).toBe('Kaelo Renn')
    expect(after?.kind).toBe('true_name')
  })

  it('falls back to the placeholder before the alias is given', async () => {
    const entity = await characterNamedAt(50)
    const early = await displayLabel(world.userId, 21, entity)
    expect(early?.label).toBe("l'homme au sabre ébréché")
  })

  it('uses the same rule in the graph', async () => {
    // The projection and the entity sheet must not disagree about a name; a
    // graph labelled from a different rule than the sheet it links to is worse
    // than either being wrong on its own.
    await characterNamedAt(50)
    const other = await createEntity(world, 'place', 1)
    await addLabel(world, other, 'Sarn', 'true_name', 1, 100)

    const before = await projectGraph(world.userId, 49)
    expect(before.nodes.map((n) => n.label).sort()).toEqual(['Sarn', 'le Passeur'])

    const after = await projectGraph(world.userId, 50)
    expect(after.nodes.map((n) => n.label).sort()).toEqual(['Kaelo Renn', 'Sarn'])
  })

  it('labels a merged node from whichever half carries the true name', async () => {
    /*
     * The representative is chosen by id, which has nothing to do with which
     * appearance was named. Reading the label from the representative alone
     * would display a merged character as whichever silhouette happened to sort
     * first — right about half the time, and confusing the rest.
     */
    const named = await createEntity(world, 'character', 12)
    const anonymous = await createEntity(world, 'character', 18)
    await addLabel(world, named, 'Kaelo Renn', 'true_name', 30, 100)
    await addLabel(world, anonymous, 'la silhouette encapuchonnée', 'placeholder', 18, 10)
    await addAssertion(world, {
      subject: anonymous,
      predicate: 'same_as',
      object: named,
      knowledgeFrom: 30,
    })

    const graph = await projectGraph(world.userId, 30)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]!.label).toBe('Kaelo Renn')
  })
})

describe('blocking test 3 — a refuted belief stays true in the past', () => {
  it('keeps the belief visible before the refutation and hides it after', async () => {
    /*
     * The reader believed the ferryman worked for the Guild from chapter 10.
     * Chapter 40 refutes it. Both rows exist forever; the boundary chooses.
     * Overwriting — a wiki's instinct — would make chapter 39 unreachable.
     */
    const ferryman = await createEntity(world, 'character', 10)
    const guild = await createEntity(world, 'group', 8)
    const rival = await createEntity(world, 'group', 35)

    await addLabel(world, ferryman, 'le passeur', 'placeholder', 10, 10)
    await addLabel(world, guild, 'la Guilde des Marées', 'true_name', 8, 100)
    await addLabel(world, rival, 'les Bannis', 'true_name', 35, 100)

    const belief = await addAssertion(world, {
      subject: ferryman,
      predicate: 'member_of',
      object: guild,
      knowledgeFrom: 10,
      knowledgeUntil: 40,
    })

    await addAssertion(world, {
      subject: ferryman,
      predicate: 'member_of',
      object: rival,
      knowledgeFrom: 40,
    })

    const before = await projectGraph(world.userId, 39)
    const beforeEdge = before.edges.find((edge) => edge.id === belief)
    expect(beforeEdge, 'la croyance doit être visible au chapitre 39').toBeDefined()

    const after = await projectGraph(world.userId, 40)
    expect(after.edges.find((edge) => edge.id === belief)).toBeUndefined()
    // And the replacement is there instead — not nothing.
    expect(after.edges).toHaveLength(1)
  })

  it('never deletes the refuted row', async () => {
    const ferryman = await createEntity(world, 'character', 10)
    const guild = await createEntity(world, 'group', 8)
    const belief = await addAssertion(world, {
      subject: ferryman,
      predicate: 'member_of',
      object: guild,
      knowledgeFrom: 10,
      knowledgeUntil: 40,
    })

    // Visible to nobody at chapter 40, still present in the table. That is what
    // makes "what did I believe, and until when" answerable at all.
    const [row] = await raw<Array<{ knowledge_until_chapter: number }>>`
      SELECT knowledge_until_chapter FROM assertions WHERE id = ${belief}
    `
    expect(row?.knowledge_until_chapter).toBe(40)
  })
})

describe('the boundary applies to existence, not only to names', () => {
  it('hides an entity whose first appearance is beyond the boundary', async () => {
    /*
     * An unnamed node is not harmless. Its count leaks ("87 characters you have
     * not met"), and `first_seen_chapter` is a readable column that answers
     * "when does this one show up". Migration 0009 exists because the original
     * policy filtered an entity's labels and relations while leaving the entity
     * itself ownership-scoped.
     */
    const early = await createEntity(world, 'character', 2)
    await createEntity(world, 'character', 300)
    await addLabel(world, early, 'le passeur', 'placeholder', 2, 10)

    const graph = await projectGraph(world.userId, 3)
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]!.firstSeenChapter).toBe(2)
  })

  it('hides a node that only exists as a proposal', async () => {
    const proposed = randomUUID()
    await raw`
      INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
      VALUES (${proposed}, ${world.workId}, ${world.userId}, 'character', 1, 'proposed')
    `
    const graph = await projectGraph(world.userId, 40)
    expect(graph.nodes.map((n) => n.id)).not.toContain(proposed)
  })

  it('returns nothing at all for another user', async () => {
    const mine = await createEntity(world, 'character', 1)
    await addLabel(world, mine, 'le passeur', 'placeholder', 1, 10)

    const stranger = await seedWorld([1])
    const graph = await projectGraph(stranger.userId, 40)
    expect(graph.nodes).toEqual([])
  })
})
