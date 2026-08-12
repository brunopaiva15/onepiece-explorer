import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * The French name, asked once and never again.
 *
 * A model authoring French labels from an English source hits a class of
 * question it cannot answer from the text: is «  Going Merry » translated, or
 * kept? That is a convention held by the reader, not a fact in the chapter, and
 * a model left to decide it decides differently each time — producing two
 * honestly-anchored labels for one person, a split evidence anchoring cannot
 * catch because both labels are anchored.
 *
 * So it declares `naming_confident: false`, the item goes to explicit review
 * with an editable name, and the answer is recorded against the source wording.
 * These tests cover the two halves of that promise: the answer is stored when
 * you give it, and it is bounded by the chapter you gave it in.
 */

const SUMMARY = [
  'The chapter opens on Fuchsia Village, a quiet place by the sea. A boy named',
  'Luffy begs a red-haired pirate to take him along, and is refused with a laugh.',
  '',
  'Later the crew of the Red-Haired Pirates drinks in the tavern while the boy',
  'sulks in a corner, and a mountain bandit walks in looking for trouble.',
].join('\n')

async function prepareRun(chapterNumber: number): Promise<{
  userId: string
  workId: string
  chapterId: string
  runId: string
}> {
  const world = await seedWorld([])
  const { chapterId } = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber,
    language: 'en',
    text: SUMMARY,
  })
  const runId = await createRun(world.userId, chapterId)
  await executeRun(world.userId, chapterId, runId)
  return { userId: world.userId, workId: world.workId, chapterId, runId }
}

/**
 * Mark a queued entity as one the model could not name.
 *
 * The synthetic provider copies labels straight out of the source, so it has no
 * naming judgement to offer and never sets the flag. Setting it here is honest
 * about what is under test: not whether a model raises its hand, but what
 * happens to the answer when it does.
 */
async function flagAsUnsure(runId: string, sourceTerm: string): Promise<string> {
  const [item] = await raw<Array<{ id: string; payload: Record<string, unknown> }>>`
    SELECT id, payload FROM review_items
      WHERE run_id = ${runId} AND category = 'entity'
      ORDER BY priority DESC LIMIT 1`
  if (!item) throw new Error('Aucune entité proposée : le run n’a rien produit.')

  const payload = { ...item.payload, source_term: sourceTerm, naming_confident: false }
  // raw.json, not a stringified object: postgres.js encodes a *string* bound to
  // a jsonb column as a JSON string scalar, which stores `"{\"label\":…}"` and
  // silently turns the payload into text nothing can read a field out of.
  await raw`
    UPDATE review_items
       SET payload = ${raw.json(payload)}, requires_explicit_review = true
     WHERE id = ${item.id}`
  return item.id
}

beforeEach(async () => {
  await resetDatabase()
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
})

afterAll(async () => {
  await closeDb()
})

describe('answering a naming question', () => {
  it('records the answer against the source wording', async () => {
    const prepared = await prepareRun(1)
    const itemId = await flagAsUnsure(prepared.runId, 'Red-Haired Pirates')

    const [before] = await raw<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM review_items WHERE id = ${itemId}`

    await publishDecisions(prepared.userId, prepared.runId, [
      {
        reviewItemId: itemId,
        decision: 'correct',
        correctedPayload: {
          ...before!.payload,
          label: 'Équipage du Roux',
          naming_confident: true,
        },
      },
    ])

    const terms = await raw<
      Array<{ source_term: string; french_term: string; decided_in_chapter: number }>
    >`SELECT source_term, french_term, decided_in_chapter FROM glossary_terms
        WHERE work_id = ${prepared.workId}`

    expect(terms).toHaveLength(1)
    expect(terms[0]).toMatchObject({
      source_term: 'Red-Haired Pirates',
      french_term: 'Équipage du Roux',
      // The chapter you decided in, which is also the chapter from which the
      // term may be used — a naming reveal is dated like any other.
      decided_in_chapter: 1,
    })

    // And the entity carries the name you chose, not the one proposed.
    const labels = await raw<Array<{ label: string }>>`
      SELECT label FROM entity_labels WHERE user_id = ${prepared.userId}`
    expect(labels.map((row) => row.label)).toContain('Équipage du Roux')
  })

  it('learns nothing from an acceptance you did not edit', async () => {
    const prepared = await prepareRun(1)
    const itemId = await flagAsUnsure(prepared.runId, 'Red-Haired Pirates')

    // Accepting the proposal unchanged means "close enough here", not "this is
    // the form, use it for the whole work". Recording it would settle a
    // question you never actually answered.
    await publishDecisions(prepared.userId, prepared.runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    const terms = await raw<Array<{ id: string }>>`
      SELECT id FROM glossary_terms WHERE work_id = ${prepared.workId}`
    expect(terms).toHaveLength(0)
  })

  it('replaces an answer rather than accumulating rivals', async () => {
    const first = await prepareRun(1)
    const firstItem = await flagAsUnsure(first.runId, 'Going Merry')
    const [payload] = await raw<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM review_items WHERE id = ${firstItem}`

    await publishDecisions(first.userId, first.runId, [
      {
        reviewItemId: firstItem,
        decision: 'correct',
        correctedPayload: { ...payload!.payload, label: 'Le Vogue Merry' },
      },
    ])

    // A second chapter of the same work, answered differently: the glossary is
    // a decision, and a decision can be changed. Two rows would mean the prompt
    // received contradictory vocabulary.
    const { chapterId } = await importSummary({
      userId: first.userId,
      workId: first.workId,
      chapterNumber: 2,
      language: 'en',
      text: SUMMARY.replace('Fuchsia Village', 'Shells Town'),
    })
    const secondRun = await createRun(first.userId, chapterId)
    await executeRun(first.userId, chapterId, secondRun)
    const secondItem = await flagAsUnsure(secondRun, 'Going Merry')
    const [secondPayload] = await raw<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM review_items WHERE id = ${secondItem}`

    await publishDecisions(first.userId, secondRun, [
      {
        reviewItemId: secondItem,
        decision: 'correct',
        correctedPayload: { ...secondPayload!.payload, label: 'Vogue Merry' },
      },
    ])

    const terms = await raw<Array<{ french_term: string }>>`
      SELECT french_term FROM glossary_terms WHERE work_id = ${first.workId}`
    expect(terms).toHaveLength(1)
    expect(terms[0]!.french_term).toBe('Vogue Merry')
  })
})
