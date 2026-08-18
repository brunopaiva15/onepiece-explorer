import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ArbitrateRequest, ModelProvider } from '@/domains/ai/provider.ts'
import type { Arbitration } from '@/domains/ai/schemas.ts'
import type { Fetcher } from '@/domains/ingestion/fandom.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { arbitrateRun } from '@/domains/review/arbitrate.ts'
import { closeDb, raw, resetDatabase, seedWorld } from '../helpers/db.ts'

/**
 * La passe complète : la page va chercher, le modèle tranche, la base garde.
 *
 * `arbitration.test.ts` tient la règle sans base ni appel. Celui-ci tient tout
 * ce que la règle ne peut pas voir : que la décision passe bien par la porte du
 * graphe, que ce que le modèle a dit s'écrit sur la carte même quand rien n'est
 * appliqué, et qu'une passe sans page ne casse pas la file — elle s'ignore.
 */

const SUMMARY = [
  'The chapter opens on Fuchsia Village. A boy named Luffy begs a red-haired',
  'pirate to take him out to sea, and is refused with a laugh.',
].join('\n')

/** La page du wiki, telle que le modèle la lira. Contient la phrase citée. */
const PAGE_TEXT = [
  '## Long Summary',
  'The chapter opens on Fuchsia Village, where a boy named Luffy begs a pirate.',
  '## Chapter Notes',
  'Luffy is introduced in this chapter.',
].join('\n\n')

const QUOTE = 'The chapter opens on Fuchsia Village, where a boy named Luffy begs a pirate.'

function pageFetcher(pages: { fr?: string; en?: string }): Fetcher {
  return (async (url: string) => {
    const language = url.includes('/fr/api.php') ? 'fr' : 'en'
    const text = pages[language]
    if (text === undefined) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ error: { info: 'Page inexistante.' } }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ parse: { text: { '*': `<p>${text.replaceAll('\n\n', '</p><p>')}</p>` } } }),
    }
  }) as Fetcher
}

/**
 * Un fournisseur qui ne sait qu'arbitrer, et qui répond ce qu'on lui dit.
 *
 * Tout le reste jette : une passe qui appellerait `extract` d'ici serait un
 * défaut, et un stub complaisant le cacherait.
 */
function arbiter(answer: (request: ArbitrateRequest) => Arbitration): ModelProvider {
  const refuse = () => {
    throw new Error('Ce fournisseur n’arbitre que.')
  }

  return {
    name: 'anthropic',
    estimate: refuse,
    transcribe: refuse,
    describePanels: refuse,
    extract: refuse,
    resolve: refuse,
    summarize: refuse,
    answer: refuse,
    embed: refuse,
    arbitrate: async (request: ArbitrateRequest) => ({
      value: answer(request),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 0.5,
        modelId: 'claude-sonnet-5',
      },
    }),
  } as unknown as ModelProvider
}

async function prepared(): Promise<{ userId: string; chapterId: string; runId: string }> {
  const world = await seedWorld([])
  const { chapterId } = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 1,
    language: 'en',
    text: SUMMARY,
  })
  const runId = await createRun(world.userId, chapterId)
  await executeRun(world.userId, chapterId, runId)
  return { userId: world.userId, chapterId, runId }
}

async function items(runId: string): Promise<
  Array<{ id: string; category: string; status: string; arbitration: unknown }>
> {
  return raw`SELECT id, category, status, arbitration FROM review_items
              WHERE run_id = ${runId} ORDER BY priority DESC`
}

beforeEach(async () => {
  await resetDatabase()
  // Une revue manuelle : la passe automatique ne doit rien avoir tranché avant
  // l'arbitrage, sinon ce fichier testerait ce qu'elle a laissé.
  delete process.env.AUTO_REVIEW_NAMES_ONLY
  process.env.MODEL_PROVIDER = 'synthetic'
  const { resetModelProvider } = await import('@/domains/ai/index.ts')
  resetModelProvider()
})

afterAll(async () => {
  await closeDb()
})

describe('l’arbitrage d’un traitement', () => {
  it('accepte ce que la page dit, et l’écrit sur la carte', async () => {
    const run = await prepared()

    const outcome = await arbitrateRun({
      userId: run.userId,
      runId: run.runId,
      chapterNumber: 1,
      provider: arbiter((request) => ({
        verdicts: request.cards.map((card) => ({
          card: card.id,
          // Seules les entités : accepter une relation dont le sujet n'est pas
          // encore publié échouerait, et ce n'est pas ce qui est testé ici.
          verdict: card.category === 'ENTITÉ' ? ('accept' as const) : ('undecided' as const),
          quote: card.category === 'ENTITÉ' ? QUOTE : '',
          reason: 'La page du chapitre le dit.',
        })),
      })),
      fetcher: pageFetcher({ en: PAGE_TEXT }),
    })

    expect(outcome.skipped).toBeNull()
    expect(outcome.result.accepted).toBeGreaterThan(0)
    expect(outcome.costCents).toBeGreaterThan(0)

    const rows = await items(run.runId)
    const entities = rows.filter((row) => row.category === 'entity')
    expect(entities.length).toBeGreaterThan(0)
    expect(entities.every((row) => row.status === 'accepted')).toBe(true)

    // Ce que le modèle a répondu est gardé, décidé ou non.
    for (const row of rows) {
      expect(row.arbitration).not.toBeNull()
    }
    const record = entities[0]!.arbitration as { applied: boolean; quote: string }
    expect(record.applied).toBe(true)
    expect(record.quote).toBe(QUOTE)

    // La porte du graphe est la seule : les entités acceptées y sont entrées.
    const [count] = await raw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM entities WHERE user_id = ${run.userId}`
    expect(count!.count).toBeGreaterThan(0)
  })

  it('garde en file, avec l’avis, ce dont la citation ne tient pas', async () => {
    const run = await prepared()

    const outcome = await arbitrateRun({
      userId: run.userId,
      runId: run.runId,
      chapterNumber: 1,
      provider: arbiter((request) => ({
        verdicts: request.cards.map((card) => ({
          card: card.id,
          verdict: 'accept' as const,
          // Une phrase parfaitement plausible, absente de la page.
          quote: 'Shanks offre son chapeau de paille à Luffy avant de reprendre la mer.',
          reason: 'La page le dit.',
        })),
      })),
      fetcher: pageFetcher({ en: PAGE_TEXT }),
    })

    expect(outcome.result.accepted).toBe(0)
    expect(outcome.result.advisory).toBe(outcome.result.submitted)

    const rows = await items(run.runId)
    expect(rows.every((row) => row.status === 'proposed')).toBe(true)

    const record = rows[0]!.arbitration as { applied: boolean; held: string }
    expect(record.applied).toBe(false)
    expect(record.held).toMatch(/introuvable/i)
  })

  it('s’ignore quand le wiki n’a pas la page, et laisse la file intacte', async () => {
    const run = await prepared()

    const outcome = await arbitrateRun({
      userId: run.userId,
      runId: run.runId,
      chapterNumber: 1,
      provider: arbiter(() => {
        throw new Error('Le modèle ne doit pas être appelé sans page.')
      }),
      fetcher: pageFetcher({}),
    })

    expect(outcome.skipped).toMatch(/introuvable sur le Fandom/)
    expect(outcome.result.submitted).toBe(0)

    const rows = await items(run.runId)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.status === 'proposed')).toBe(true)
    expect(rows.every((row) => row.arbitration === null)).toBe(true)
  })

  it('ne perd pas une tranche parce qu’une autre a échoué', async () => {
    const run = await prepared()

    let calls = 0
    const outcome = await arbitrateRun({
      userId: run.userId,
      runId: run.runId,
      chapterNumber: 1,
      provider: arbiter(() => {
        calls += 1
        throw new Error('Overloaded')
      }),
      fetcher: pageFetcher({ en: PAGE_TEXT }),
    })

    expect(calls).toBeGreaterThan(0)
    expect(outcome.failures[0]).toMatch(/Overloaded/)
    expect(outcome.result.submitted).toBe(0)

    const rows = await items(run.runId)
    expect(rows.every((row) => row.status === 'proposed')).toBe(true)
  })
})
