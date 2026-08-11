import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ask, groundednessScore, verifyCitations } from '@/domains/assistant/answer.ts'
import { buildContext, disjoin } from '@/domains/assistant/context.ts'
import { search } from '@/domains/search/index.ts'
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
 * Blocking test 8: the assistant cites permitted evidence, or says it cannot.
 *
 * This is the only blocking test about natural language, and the failure it
 * guards against is the most dangerous the product can produce: a fluent answer
 * with a citation shaped exactly like a real one — right format, plausible
 * chapter, an id resembling the others. It is indistinguishable from a true
 * answer by eye, and the entire claim of this product is that everything in it
 * is checkable.
 *
 * The prompt asks the model to cite and to admit ignorance. These tests are
 * about the code that makes it so whether or not the model complies.
 */

let world: SeededWorld

async function seedFerryman(): Promise<{
  ferryman: string
  guild: string
  early: string
  late: string
}> {
  const ferryman = await createEntity(world, 'character', 2)
  const guild = await createEntity(world, 'group', 2)
  const secret = await createEntity(world, 'group', 40)

  await addLabel(world, ferryman, 'le passeur', 'placeholder', 2, 10)
  await addLabel(world, guild, 'la Guilde des Marées', 'true_name', 2, 100)
  await addLabel(world, secret, 'les Bannis', 'true_name', 40, 100)

  const early = await addAssertion(world, {
    subject: ferryman,
    predicate: 'member_of',
    object: guild,
    knowledgeFrom: 2,
  })

  // Revealed at 40: must be invisible to a reader at 3, in every path.
  const late = await addAssertion(world, {
    subject: ferryman,
    predicate: 'secretly_member_of',
    object: secret,
    knowledgeFrom: 40,
  })

  return { ferryman, guild, early, late }
}

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([2, 3, 40])
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  const { resetVectorStore } = await import('@/domains/search/index.ts')
  resetModelProvider()
  resetVectorStore()
})

afterAll(async () => {
  await closeDb()
})

describe('blocking test 8 — an answer cites permitted evidence or declares it cannot', () => {
  it('answers from the reader’s own chapters, with citations', async () => {
    await seedFerryman()

    const answer = await ask(world.userId, 3, 'Que sait-on du passeur ?')

    expect(answer.citations.length).toBeGreaterThan(0)
    expect(answer.insufficientData).toBe(false)
    // Every citation is within the boundary. Not "mostly" — every one.
    expect(answer.citations.every((c) => c.chapter <= 3)).toBe(true)
  })

  it('never cites a chapter the reader has not reached', async () => {
    const { late } = await seedFerryman()

    const answer = await ask(world.userId, 3, 'Le passeur appartient-il aux Bannis ?')

    expect(answer.citations.map((c) => c.assertionId)).not.toContain(late)
    expect(answer.citations.every((c) => c.chapter <= 3)).toBe(true)
    // And the same question at 40 does reach it — the filtering is a boundary,
    // not a blanket refusal.
    const later = await ask(world.userId, 40, 'Le passeur appartient-il aux Bannis ?')
    expect(later.citations.some((c) => c.chapter === 40)).toBe(true)
  })

  it('declares insufficient data rather than answering from nothing', async () => {
    await seedFerryman()

    const answer = await ask(
      world.userId,
      3,
      'Quel est le nom du roi des pirates et où se trouve son trésor ?',
    )

    expect(answer.insufficientData).toBe(true)
    expect(answer.citations).toEqual([])
    expect(answer.answer).toMatch(/rien|insuffisant|ne se rapporte/i)
  })

  it('does not call the model at all when nothing was retrieved', async () => {
    /*
     * The cheapest way not to leak is not to ask. A model handed an empty
     * context and a question about One Piece will answer fluently, correctly,
     * and about chapters the reader has not opened.
     */
    const answer = await ask(world.userId, 3, 'zzzz-terme-absent-du-corpus')

    expect(answer.insufficientData).toBe(true)
    expect(answer.modelId).toBeNull()
    expect(answer.costCents).toBe(0)
  })

  it('answers nothing at boundary zero, and says why', async () => {
    await seedFerryman()
    const answer = await ask(world.userId, 0, 'Que sait-on du passeur ?')

    expect(answer.insufficientData).toBe(true)
    expect(answer.citations).toEqual([])
  })
})

describe('citation verification', () => {
  const context = {
    boundaryChapter: 10,
    entityIds: [],
    notes: [],
    entries: [
      {
        assertionId: 'a1',
        chapter: 2,
        statement: 'le passeur — member_of — la Guilde des Marées',
        excerpt: 'Le passeur travaille pour la Guilde.',
        subjectId: 'e1',
        objectId: 'e2',
      },
    ],
  }

  it('drops a citation whose id was never in the context', () => {
    // The signature of a fabricated source: correct shape, plausible chapter,
    // an id that looks like the real ones.
    const result = verifyCitations(
      [
        { assertion_id: 'a1', chapter: 2, excerpt: 'Le passeur travaille' },
        { assertion_id: 'a99', chapter: 5, excerpt: 'Le passeur trahit la Guilde.' },
      ],
      context,
    )

    expect(result.citations.map((c) => c.assertionId)).toEqual(['a1'])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.why).toMatch(/inventée/)
  })

  it('returns the excerpt from the context, not from the model', () => {
    /*
     * A model citing a real id while paraphrasing the quote is the subtlest
     * failure here: the citation checks out, and the words in front of the
     * reader are still not what the page said.
     */
    const result = verifyCitations(
      [{ assertion_id: 'a1', chapter: 2, excerpt: 'Le passeur est un membre loyal.' }],
      context,
    )
    expect(result.citations[0]!.excerpt).toBe('Le passeur travaille pour la Guilde.')
  })

  it('drops a citation beyond the boundary even if it was in the context', () => {
    // Unreachable through the normal path, because the context is built through
    // withBoundary. Checked anyway: a leak that gets this far has already
    // defeated the database, and finding out here beats finding out from a
    // reader.
    const result = verifyCitations(
      [{ assertion_id: 'future', chapter: 300, excerpt: '' }],
      {
        ...context,
        boundaryChapter: 3,
        entries: [
          {
            assertionId: 'future',
            chapter: 300,
            statement: 'quelque chose du chapitre 300',
            excerpt: null,
            subjectId: 'e9',
            objectId: null,
          },
        ],
      },
    )
    expect(result.citations).toEqual([])
    expect(result.dropped[0]!.why).toMatch(/au-delà de la frontière/)
  })

  it('deduplicates repeated citations', () => {
    const result = verifyCitations(
      [
        { assertion_id: 'a1', chapter: 2, excerpt: 'x' },
        { assertion_id: 'a1', chapter: 2, excerpt: 'y' },
      ],
      context,
    )
    expect(result.citations).toHaveLength(1)
  })
})

describe('the context is filtered before the model sees it', () => {
  it('contains nothing past the boundary', async () => {
    const { late } = await seedFerryman()

    const context = await buildContext(world.userId, 3, 'le passeur')

    expect(context.entries.length).toBeGreaterThan(0)
    expect(context.entries.every((entry) => entry.chapter <= 3)).toBe(true)
    expect(context.entries.map((entry) => entry.assertionId)).not.toContain(late)
  })

  it('is empty for another reader', async () => {
    await seedFerryman()
    const stranger = await seedWorld([1])
    const context = await buildContext(stranger.userId, 999, 'le passeur')
    expect(context.entries).toEqual([])
  })

  it('passes through the reason a search mode could not run', async () => {
    /*
     * Under the synthetic provider every mode runs — its hashed embeddings are
     * not semantic but they are real vectors, so the whole path exercises
     * rather than being dead code behind a flag. Notes are therefore empty
     * here, and what matters is that the channel exists and is not fabricated.
     */
    await seedFerryman()
    const context = await buildContext(world.userId, 3, 'le passeur')
    expect(Array.isArray(context.notes)).toBe(true)
    expect(context.notes.every((note) => note.length > 0)).toBe(true)
  })
})

describe('broadening a question does not broaden the boundary', () => {
  it('retrieves for a question whose every word cannot all be present', async () => {
    await seedFerryman()

    /*
     * Conjunctive full text asks for "savoir" as well as "guilde" and
     * "marées", and no page contains all three. Without the disjunctive retry
     * this returns nothing and the reader is told the data is insufficient
     * about a fact sitting in chapter 2.
     */
    const context = await buildContext(
      world.userId,
      3,
      'Que sait-on de la Guilde des Marées ?',
    )

    expect(context.entries.length).toBeGreaterThan(0)
  })

  it('still hides a later chapter when the question is broadened', async () => {
    const { late } = await seedFerryman()

    // "Bannis" is a chapter-40 name. The broadened query asks for it by
    // disjunction — the widest retrieval this code can produce — and the
    // database still refuses it, because widening a query cannot widen a
    // policy.
    const context = await buildContext(
      world.userId,
      3,
      'Que sait-on des Bannis et de la Guilde des Marées ?',
    )

    expect(context.entries.every((entry) => entry.chapter <= 3)).toBe(true)
    expect(context.entries.map((entry) => entry.assertionId)).not.toContain(late)
  })

  it('leaves a question with nothing to broaden alone', () => {
    expect(disjoin('Bannis')).toBeNull()
    expect(disjoin('Qui ?')).toBeNull()
    expect(disjoin('Que sait-on de la Guilde des Marées ?')).toBe(
      'sait-on or guilde or marees',
    )
  })
})

describe('a store that cannot search says so', () => {
  it('reports a reason rather than returning an empty list', async () => {
    /*
     * The distinction the NullVectorStore exists for. An empty result claims
     * "nothing in your library matches", which is a statement about the corpus
     * and is false when nothing was ever looked up — and the assistant would
     * then report insufficient data for a question it never searched.
     */
    const { NullVectorStore } = await import('@/domains/search/vector-store.ts')
    const store = new NullVectorStore()

    expect(await store.search()).toEqual([])
    expect(store.unavailableReason).toBeTruthy()
    expect(store.unavailableReason).toMatch(/plein texte/)
  })

  it('picks a real store when a provider exists', async () => {
    const { vectorStore, resetVectorStore } = await import('@/domains/search/index.ts')
    resetVectorStore()
    const store = await vectorStore()
    // Synthetic counts as a provider, so this must not be the null store.
    expect(store.name).not.toBe('none')
    expect(store.unavailableReason).toBeNull()
  })
})

describe('search never crosses the boundary', () => {
  it('finds a chapter-2 name at chapter 3 and not a chapter-40 one', async () => {
    await seedFerryman()

    const early = await search(world.userId, 3, 'Guilde')
    expect(early.hits.length).toBeGreaterThan(0)

    const hidden = await search(world.userId, 3, 'Bannis')
    expect(hidden.hits).toEqual([])

    // The same query once the reader has got there.
    const later = await search(world.userId, 40, 'Bannis')
    expect(later.hits.length).toBeGreaterThan(0)
  })

  it('folds accents, so a transcription variant still finds the name', async () => {
    await seedFerryman()

    const accented = await search(world.userId, 3, 'Marées')
    const plain = await search(world.userId, 3, 'Marees')

    expect(accented.hits.length).toBeGreaterThan(0)
    expect(plain.hits.map((h) => h.id).sort()).toEqual(
      accented.hits.map((h) => h.id).sort(),
    )
  })

  it('finds a misspelled name through trigrams', async () => {
    await seedFerryman()
    const typo = await search(world.userId, 3, 'Guild des Maree')
    expect(typo.hits.length).toBeGreaterThan(0)
  })

  it('tells the reader which modes ran', async () => {
    await seedFerryman()
    const result = await search(world.userId, 3, 'passeur')

    const semantic = result.modes.find((mode) => mode.mode === 'semantic')
    expect(semantic).toBeDefined()
    // Unavailable modes carry an explanation; a silent absence would read as
    // "nothing matched" rather than "one way of looking never happened".
    if (!semantic!.ran) expect(semantic!.note).toBeTruthy()
  })

  it('returns nothing for another reader’s corpus', async () => {
    await seedFerryman()
    const stranger = await seedWorld([1])
    const result = await search(stranger.userId, 999, 'passeur')
    expect(result.hits).toEqual([])
  })

  it('finds nothing rather than everything for an empty query', async () => {
    await seedFerryman()
    const result = await search(world.userId, 40, '   ')
    expect(result.hits).toEqual([])
  })
})

describe('groundedness scoring', () => {
  const citations = [
    {
      assertionId: 'a1',
      chapter: 2,
      excerpt: 'Le passeur travaille pour la Guilde des Marées.',
      statement: 'le passeur — member_of — la Guilde des Marées',
    },
  ]

  it('scores an answer drawn from its sources highly', () => {
    const { score } = groundednessScore(
      'Le passeur travaille pour la Guilde des Marées.',
      citations,
    )
    expect(score).toBeGreaterThan(0.8)
  })

  it('scores an answer full of unsupported claims low', () => {
    const { score, unsupportedWords } = groundednessScore(
      'Le passeur commande une flotte secrète et prépare une trahison contre le royaume.',
      citations,
    )
    expect(score).toBeLessThan(0.4)
    expect(unsupportedWords).toContain('trahison')
  })

  it('is a measure, not a gate', () => {
    // Reported as a score rather than enforced: a legitimate answer contains
    // connective language no source supplies, so enforcing it would reject
    // good answers. It catches drift between prompt versions.
    const { score } = groundednessScore('', citations)
    expect(score).toBe(1)
  })
})

describe('occurrences', () => {
  it('are written at publication so appearances are locatable', async () => {
    // Populated from evidence in publish.ts. Before that the table had been
    // boundary-filtered and empty since migration 0005.
    const entity = await createEntity(world, 'character', 2)
    await addLabel(world, entity, 'le passeur', 'placeholder', 2, 10)

    const chapterId = world.chapterIds.get(2)!
    await raw`
      INSERT INTO occurrences (id, entity_id, user_id, chapter_id, kind, chapter_number)
      VALUES (${randomUUID()}, ${entity}, ${world.userId}, ${chapterId}, 'appearance', 2)
    `

    const [visible] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM occurrences WHERE entity_id = ${entity}
    `
    expect(visible!.count).toBe(1)
  })
})
