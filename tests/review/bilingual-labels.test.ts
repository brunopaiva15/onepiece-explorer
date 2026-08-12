import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { lexicalSearch } from '@/domains/search/lexical.ts'
import { displayLabel } from '@/domains/temporal/projection.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
} from '../helpers/db.ts'

/**
 * English as a display layer, never a second canon.
 *
 * Migration 0019's contract, tested from both ends. On the way in: publication
 * writes an English twin label only when the system actually saw an English
 * form — the source wording of an English chapter — with the same kind, the
 * same precedence and the same reveal chapter as its French original, and the
 * glossary records the same fact in english_term. On the way out: display-name
 * selection prefers the reader's language and falls back to French rather than
 * to nothing, and lexical search stems each stored label in its own language,
 * so "Red-Haired Pirates" is findable by an English reader typing English.
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

async function topEntityItem(
  runId: string,
): Promise<{ id: string; payload: Record<string, unknown> }> {
  const [item] = await raw<Array<{ id: string; payload: Record<string, unknown> }>>`
    SELECT id, payload FROM review_items
      WHERE run_id = ${runId} AND category = 'entity'
      ORDER BY priority DESC LIMIT 1`
  if (!item) throw new Error('Aucune entité proposée : le run n’a rien produit.')
  return item
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

describe('publishing the English twin', () => {
  it('writes an English label beside the French one when the source supplied it', async () => {
    const prepared = await prepareRun(1)
    const item = await topEntityItem(prepared.runId)

    await raw`
      UPDATE review_items
         SET payload = ${raw.json({
           ...item.payload,
           source_term: 'Red-Haired Pirates',
           naming_confident: false,
         })},
             requires_explicit_review = true
       WHERE id = ${item.id}`

    await publishDecisions(prepared.userId, prepared.runId, [
      {
        reviewItemId: item.id,
        decision: 'correct',
        correctedPayload: {
          ...item.payload,
          source_term: 'Red-Haired Pirates',
          label: 'Équipage du Roux',
          naming_confident: true,
        },
      },
    ])

    const labels = await raw<
      Array<{ label: string; lang: string; kind: string; precedence: number; revealed_in_chapter: number }>
    >`SELECT label, lang, kind::text AS kind, precedence, revealed_in_chapter
        FROM entity_labels WHERE user_id = ${prepared.userId}
        ORDER BY lang`

    const french = labels.find((row) => row.label === 'Équipage du Roux')
    const english = labels.find((row) => row.label === 'Red-Haired Pirates')

    expect(french).toMatchObject({ lang: 'fr' })
    expect(english).toBeDefined()
    // The twin mirrors its original: same kind, same precedence, same reveal
    // chapter — a name unmet in one language is unmet in the other.
    expect(english).toMatchObject({
      lang: 'en',
      kind: french!.kind,
      precedence: french!.precedence,
      revealed_in_chapter: french!.revealed_in_chapter,
    })

    // And the glossary carries both sides of the decision.
    const [term] = await raw<Array<{ french_term: string; english_term: string | null }>>`
      SELECT french_term, english_term FROM glossary_terms
        WHERE work_id = ${prepared.workId}`
    expect(term).toMatchObject({
      french_term: 'Équipage du Roux',
      english_term: 'Red-Haired Pirates',
    })
  })

  it('writes no twin when the English form is the French form', async () => {
    const prepared = await prepareRun(1)
    const item = await topEntityItem(prepared.runId)

    // "Luffy" is "Luffy" in both languages: the source wording matches the
    // label, so a twin row would buy nothing — display falls back to French.
    await publishDecisions(prepared.userId, prepared.runId, [
      {
        reviewItemId: item.id,
        decision: 'correct',
        correctedPayload: {
          ...item.payload,
          source_term: String(item.payload.label),
          label: String(item.payload.label),
        },
      },
    ])

    const twins = await raw<Array<{ id: string }>>`
      SELECT id FROM entity_labels
        WHERE user_id = ${prepared.userId} AND lang = 'en'`
    expect(twins).toHaveLength(0)
  })
})

describe('reading in either language', () => {
  it('prefers the reader’s language and falls back to French', async () => {
    const world = await seedWorld([1])
    const entity = await createEntity(world, 'group', 1)
    await addLabel(world, entity, 'Équipage du Roux', 'alias', 1, 50, 'fr')
    await addLabel(world, entity, 'Red-Haired Pirates', 'alias', 1, 50, 'en')

    const french = await displayLabel(world.userId, 1, entity, 'fr')
    const english = await displayLabel(world.userId, 1, entity, 'en')
    expect(french?.label).toBe('Équipage du Roux')
    expect(english?.label).toBe('Red-Haired Pirates')

    // An entity whose English form was never seen keeps its French name.
    const frenchOnly = await createEntity(world, 'character', 1)
    await addLabel(world, frenchOnly, 'Le bandit des montagnes', 'alias', 1, 50, 'fr')
    const fallback = await displayLabel(world.userId, 1, frenchOnly, 'en')
    expect(fallback?.label).toBe('Le bandit des montagnes')
  })

  it('finds an English label with an English-stemmed query', async () => {
    const world = await seedWorld([1])
    const entity = await createEntity(world, 'group', 1)
    await addLabel(world, entity, 'Équipage du Roux', 'alias', 1, 50, 'fr')
    await addLabel(world, entity, 'Red-Haired Pirates', 'alias', 1, 50, 'en')

    // Singular query against a plural label: only the English stemmer folds
    // "pirate" and "Pirates" together, which is the whole point of en_unaccent.
    const hits = await lexicalSearch(world.userId, 1, 'red-haired pirate', 30, 'en')
    expect(hits.some((hit) => hit.entityId === entity)).toBe(true)

    // The French path is untouched: a French query still finds the French label.
    const frenchHits = await lexicalSearch(world.userId, 1, 'équipage roux', 30, 'fr')
    expect(frenchHits.some((hit) => hit.entityId === entity)).toBe(true)
  })
})
