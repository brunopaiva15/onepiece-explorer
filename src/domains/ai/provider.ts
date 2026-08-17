/**
 * The model boundary.
 *
 * Three implementations sit behind this: Anthropic in production, a replay
 * provider that answers from recorded responses, and a synthetic one that
 * derives answers from fixture ground truth. The replay provider is what lets
 * the anti-spoiler tests be *blocking* in CI — hermetic, free, deterministic —
 * and that in turn is the only reason those tests can be trusted as a gate
 * rather than tolerated as flaky.
 *
 * Every call here is deliberately toolless. The pages come from an untrusted
 * file: a document that could ask the model to fetch a URL, and a model that
 * could comply, is a server-side request forgery with extra steps. Extraction
 * calls pass no tools at all, and no URL found in a document is ever followed.
 */

import type { SourceKind } from './prompts.ts'
import type {
  Answer,
  Extraction,
  PanelDescription,
  Resolution,
  Summary,
  Transcription,
} from './schemas.ts'

export type { SourceKind }

/** Where a request sits on the cost/quality ladder. */
export type ModelTier = 'classify' | 'describe' | 'extract' | 'escalate'

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costCents: number
  modelId: string
}

export interface ProviderResult<T> {
  value: T
  usage: Usage
  /** Set when the model declined; callers must not read `value`. */
  refusal?: string
}

/** An image, already downscaled by the caller. */
export interface ImageInput {
  /** Base64, no data: prefix. */
  data: string
  mediaType: 'image/webp' | 'image/png' | 'image/jpeg'
  /** The ref the model must use when citing this image. */
  ref: string
}

export interface TranscribeRequest {
  chapterNumber: number
  images: ImageInput[]
  /** Panel refs the model may cite. Anything else is quarantined. */
  allowedRefs: string[]
  language: string
}

export interface DescribeRequest {
  chapterNumber: number
  images: ImageInput[]
  allowedRefs: string[]
  /** OCR text per panel ref, passed as untrusted data. */
  text: Record<string, string>
}

export interface ExtractRequest {
  chapterNumber: number
  /**
   * What the model is reading: drawn pages, or a text you wrote.
   *
   * Changes the wording of the system prompt, and nothing else. A model told to
   * consult "les pages fournies" while holding paragraphs of prose is a model
   * invited to picture the pages — which is exactly the door this project keeps
   * shut.
   */
  source: SourceKind
  /** The ontology, as the stable cacheable prefix. */
  ontology: string
  /**
   * Entities already validated and visible at this chapter.
   *
   * `group` says which part of the prompt's list each belongs in — the
   * provisional designations a revelation could name, the questions still open,
   * and everyone else. Optional so a caller that has no ranking still renders a
   * flat list, which is what the older recorded responses were built from.
   */
  knownEntities: Array<{
    id: string
    label: string
    nodeType: string
    group?: 'unnamed' | 'question' | 'other'
  }>
  /**
   * How many entities are visible at this chapter, before the list was cut.
   *
   * Sent so the prompt can say it is showing a subset. A truncation the model
   * cannot see is one it reads as « this thing does not exist », and the wrong
   * conclusion from that is a relation pointed at the nearest listed line.
   */
  knownEntitiesTotal?: number
  /**
   * Entities this same chapter has already proposed, in earlier slices.
   *
   * A chapter is read in slices, and a slice sees only its own passages. A
   * relation between someone introduced in the first slice and someone in the
   * third therefore could not be expressed at all: the model had no way to name
   * the first — it is not in `knownEntities`, which holds *accepted* entities,
   * and nothing is accepted mid-run.
   *
   * Omitted rather than sent empty when there is nothing yet, so the first
   * slice's request — and the recorded response keyed on it — is byte for byte
   * what it was before this existed.
   */
  proposedSoFar?: Array<{ id: string; label: string; nodeType: string }>
  /**
   * Naming decisions already made, visible at this chapter.
   *
   * Settled vocabulary, so the model stops re-inventing a French form every
   * chapter and producing two entities where there is one person. Filtered by
   * the boundary before it arrives, like knownEntities: a term settled at
   * chapter 500 is a chapter-500 revelation.
   */
  glossary: Array<{ sourceTerm: string; frenchTerm: string; note: string | null }>
  /** Panel descriptions produced in this run. */
  descriptions: PanelDescription[]
  /** Text blocks, quoted verbatim, in an untrusted-data envelope. */
  textBlocks: Array<{ ref: string; text: string; panelRef: string | null }>
  allowedRefs: string[]
  /**
   * The same chapter in the other language, windowed to this slice.
   *
   * A naming aid and strictly that. Its passages carry no refs, so they are
   * absent from `allowedRefs` and a proposal quoting one is quarantined by the
   * anchoring filter like any other invented citation. That is the mechanism,
   * not a promise: the prompt says the text is not citable, and the filter is
   * what makes it true whatever the model does with the instruction.
   *
   * Absent when the chapter has no second text — and absent rather than empty,
   * so a request that could have been made before this existed still hashes to
   * what it hashed to then.
   */
  parallel?: { language: string; passages: string[] }
}

export interface ResolveRequest {
  chapterNumber: number
  source: SourceKind
  /** The newly seen figure, described visually. */
  candidate: { label: string; nodeType: string; description: string }
  /** Existing entities that trigram blocking flagged as worth comparing. */
  existing: Array<{
    id: string
    label: string
    nodeType: string
    firstSeenChapter: number
    description: string
  }>
}

export interface SummarizeRequest {
  chapterNumber: number
  assertions: Array<{ id: string; statement: string }>
}

export interface AnswerRequest {
  question: string
  /** Already filtered by the boundary, server-side, before it got here. */
  context: Array<{
    assertionId: string
    chapter: number
    statement: string
    excerpt: string | null
  }>
  boundaryChapter: number
}

export interface EmbedRequest {
  texts: string[]
}

export interface ModelProvider {
  readonly name: 'anthropic' | 'local' | 'replay' | 'synthetic'

  /**
   * Cost of a request before making it, from a real countTokens call rather
   * than a hard-coded constant. Shown in the import wizard so nobody discovers
   * the price from a bill.
   */
  estimate(tier: ModelTier, request: unknown): Promise<{ inputTokens: number; costCents: number }>

  transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>>
  describePanels(request: DescribeRequest): Promise<ProviderResult<PanelDescription[]>>
  extract(request: ExtractRequest): Promise<ProviderResult<Extraction>>
  resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>>
  summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>>
  answer(request: AnswerRequest): Promise<ProviderResult<Answer>>
  embed(request: EmbedRequest): Promise<ProviderResult<number[][]>>
}

/**
 * Per-million-token prices, used to turn usage into a number the user sees.
 *
 * Hard-coded and dated on purpose: a wrong price is better than no price, and a
 * stale one is visible in a diff. Cache reads are a tenth of the input rate,
 * cache writes are 1.25× — which is why a prefix has to be reused three times
 * before caching pays for itself.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  // Verified 2026-08-10. Sonnet 5 is on introductory pricing until 2026-08-31,
  // after which it returns to $3 / $15.
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
}

export function costCents(
  modelId: string,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): number {
  const price = PRICING[modelId]
  if (!price) return 0

  const dollars =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * price.input * 0.1 +
      (usage.cacheWriteTokens ?? 0) * price.input * 1.25) /
    1_000_000

  return Math.round(dollars * 100_000) / 1_000
}

/**
 * How much reasoning a tier is allowed to buy before answering.
 *
 * Absent fields mean "the model's own posture", which on Sonnet 5 and Opus 5 is
 * adaptive thinking — on by default, billed as output tokens, and invisible in
 * the answer.
 */
export interface Reasoning {
  /** Only ever used to turn thinking off; enabling it is the default. */
  thinking?: { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Bound the thinking on extraction, and only there.
 *
 * Measured on chapter 1: a 1 774-character summary produced 23 190 output
 * tokens for a few dozen proposals, took two minutes and cost 24 cents. The
 * proposals themselves are a few thousand tokens; the rest was reasoning, which
 * on Sonnet 5 runs by default and is billed at the output rate. Over eleven
 * hundred chapters that difference is the budget of the project, and the two
 * minutes matter for a second reason: a run is executed inside a serverless
 * invocation that is killed at five.
 *
 * Extraction is the tier where that trade is defensible. The reasoning it
 * spends is not what keeps the graph honest — anchoring is, and it runs after
 * the answer whatever the model thought on the way there. A shallower pass
 * finds a little less; it cannot invent more.
 *
 * `escalate` is left alone deliberately: it decides whether two appearances are
 * the same character, which is the one question in this pipeline where thinking
 * is the product. `classify` and `describe` run on Haiku, where there is no
 * adaptive thinking to bound.
 *
 * EXTRACT_EFFORT overrides the level, and the value `adaptive` restores the
 * model's default posture — the escape hatch for measuring this decision again
 * rather than trusting the paragraph above.
 */
export function reasoningFor(tier: ModelTier): Reasoning {
  if (tier !== 'extract') return {}

  const chosen = process.env.EXTRACT_EFFORT?.trim()
  if (chosen === 'adaptive') return {}

  const effort = EFFORTS.find((level) => level === chosen) ?? 'medium'
  return { thinking: { type: 'disabled' }, effort }
}

export function modelFor(tier: ModelTier): string {
  switch (tier) {
    case 'classify':
      return process.env.MODEL_CLASSIFY ?? 'claude-haiku-4-5'
    case 'describe':
      /*
       * The bulk of the spend, and the least demanding work in the pipeline.
       *
       * Describing a panel is "say what is drawn, in the present tense, without
       * interpreting" — the prompt forbids naming anyone, forbids inference, and
       * the answer is checked against a schema. There are a hundred of these per
       * chapter, each carrying an image, which makes this step most of the bill
       * on its own. Haiku 4.5 is a third of Sonnet 5's price on input and half on
       * output, and this is the step where that trade is cheapest to make: a
       * flatter description costs a little recall at extraction, where the
       * stronger model still reads it.
       */
      return process.env.MODEL_DESCRIBE ?? 'claude-haiku-4-5'
    case 'extract':
      /*
       * The reasoning, and where the money is worth spending. Entities,
       * relations and events against an ontology, each anchored to a real panel
       * or text block. A weaker model here does not hallucinate into the graph —
       * anchoring stops that — it simply finds less, and what it misses nobody
       * ever learns was there.
       */
      return process.env.MODEL_EXTRACT ?? 'claude-sonnet-5'
    case 'escalate':
      return process.env.MODEL_ESCALATE ?? 'claude-opus-5'
  }
}

export const emptyUsage = (modelId: string): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costCents: 0,
  modelId,
})
