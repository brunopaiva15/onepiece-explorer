import 'server-only'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  emptyUsage,
  modelFor,
  type AnswerRequest,
  type ArbitrateRequest,
  type DescribeRequest,
  type EmbedRequest,
  type ExtractRequest,
  type ModelProvider,
  type ModelTier,
  type ProviderResult,
  type ResolveRequest,
  type SummarizeRequest,
  type TranscribeRequest,
} from './provider.ts'
import type {
  Answer,
  Arbitration,
  Extraction,
  PanelDescription,
  Resolution,
  Summary,
  Transcription,
} from './schemas.ts'

/**
 * Recorded responses, replayed.
 *
 * This is what lets the eight anti-spoiler tests be a *gate* rather than a
 * suite people learn to ignore. A test that calls a real model is
 * non-deterministic, costs money per run, and needs a key in CI — three
 * separate reasons to mark it as "flaky, skip for now", which is the exact
 * moment an anti-spoiler guarantee stops being a guarantee.
 *
 * Responses are keyed by a hash of the request. A missing recording is a loud
 * failure with the command to fix it, never a silent fallback to a plausible
 * answer: a replay provider that improvised would make the recordings
 * decorative.
 *
 * Record against a real model:  RECORD=1 CLAUDE_CODE_OAUTH_TOKEN=... pnpm test
 * (ANTHROPIC_API_KEY still works, and is used only when no subscription token
 * is configured — see `baseProvider`.)
 */

const CASSETTE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'model-responses')

export class ReplayProvider implements ModelProvider {
  readonly name = 'replay' as const

  constructor(
    private readonly options: {
      /** When set, unknown requests are delegated and the answer written down. */
      recorder?: ModelProvider
      directory?: string
    } = {},
  ) {}

  private get directory(): string {
    return this.options.directory ?? CASSETTE_DIR
  }

  async estimate(
    tier: ModelTier,
    request: unknown,
  ): Promise<{ inputTokens: number; costCents: number }> {
    // Deterministic and free: an estimate must not depend on a recording, or
    // adding a test would change the numbers another test asserts.
    const size = JSON.stringify(request).length
    void tier
    return { inputTokens: Math.ceil(size / 4), costCents: 0 }
  }

  transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>> {
    return this.replay('transcribe', request, (p) => p.transcribe(request))
  }

  describePanels(request: DescribeRequest): Promise<ProviderResult<PanelDescription[]>> {
    return this.replay('describePanels', request, (p) => p.describePanels(request))
  }

  extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    return this.replay('extract', request, (p) => p.extract(request))
  }

  resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    return this.replay('resolve', request, (p) => p.resolve(request))
  }

  summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>> {
    return this.replay('summarize', request, (p) => p.summarize(request))
  }

  answer(request: AnswerRequest): Promise<ProviderResult<Answer>> {
    return this.replay('answer', request, (p) => p.answer(request))
  }

  arbitrate(request: ArbitrateRequest): Promise<ProviderResult<Arbitration>> {
    return this.replay('arbitrate', request, (p) => p.arbitrate(request))
  }

  embed(request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    return this.replay('embed', request, (p) => p.embed(request))
  }

  private async replay<T>(
    operation: string,
    request: unknown,
    live: (provider: ModelProvider) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const key = cassetteKey(operation, request)
    const file = path.join(this.directory, `${operation}-${key}.json`)

    try {
      const recorded = JSON.parse(await readFile(file, 'utf8')) as ProviderResult<T>
      return { ...recorded, usage: { ...recorded.usage, costCents: 0 } }
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    const recorder = this.options.recorder
    if (!recorder) {
      throw new Error(
        `Aucune réponse enregistrée pour « ${operation} » (clé ${key}).\n` +
          `Fichier attendu : ${path.relative(process.cwd(), file)}\n\n` +
          `Pour enregistrer :  RECORD=1 CLAUDE_CODE_OAUTH_TOKEN=… pnpm test\n` +
          `Le fournisseur de rejeu n'improvise jamais : une réponse inventée ici ` +
          `rendrait les enregistrements décoratifs et les tests anti-spoiler inutiles.`,
      )
    }

    const result = await live(recorder)
    await mkdir(this.directory, { recursive: true })
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  }
}

/**
 * The cassette key.
 *
 * Hashes the request, with the volatile parts removed. Image bytes are replaced
 * by their own digest so a recording survives a change in WebP encoder version
 * — otherwise upgrading sharp would invalidate every cassette at once and turn
 * a dependency bump into an afternoon of re-recording.
 */
export function cassetteKey(operation: string, request: unknown): string {
  const canonical = JSON.stringify(
    { operation, model: modelFor('extract'), request: stabilise(request) },
    orderedKeys,
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

function stabilise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilise)
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'data' && typeof entry === 'string' && entry.length > 256) {
      out[key] = `sha256:${createHash('sha256').update(entry).digest('hex').slice(0, 16)}`
      continue
    }
    out[key] = stabilise(entry)
  }
  return out
}

/** JSON.stringify replacer that sorts object keys, so key order cannot matter. */
function orderedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]))
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  )
}

export const replayUsage = emptyUsage
