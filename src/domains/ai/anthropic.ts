import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type {
  ContentBlockParam,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import type { z } from 'zod'
import {
  answerSystem,
  descriptionSystem,
  extractionSystem,
  refList,
  resolutionSystem,
  summarySystem,
  transcriptionSystem,
  untrusted,
} from './prompts.ts'
import {
  answerSchema,
  extractionSchema,
  panelDescriptionsSchema,
  resolutionSchema,
  summarySchema,
  transcriptionSchema,
  type Answer,
  type Extraction,
  type PanelDescription,
  type Resolution,
  type Summary,
  type Transcription,
} from './schemas.ts'
import {
  costCents,
  emptyUsage,
  modelFor,
  type AnswerRequest,
  type DescribeRequest,
  type EmbedRequest,
  type ExtractRequest,
  type ImageInput,
  type ModelProvider,
  type ModelTier,
  type ProviderResult,
  type ResolveRequest,
  type SummarizeRequest,
  type TranscribeRequest,
  type Usage,
} from './provider.ts'

/**
 * The real provider.
 *
 * Four cost levers, all of them on by default:
 *
 *   Prompt caching. The system prompt, the ontology and the list of already
 *   validated entities form a prefix that every panel of a chapter reuses. With
 *   ~100 panels per chapter, a cached prefix pays for itself after the third
 *   request. The trap: parallel requests cannot read a cache entry that is still
 *   being written, so a chapter's first request is sent alone as a warm-up
 *   before the rest go out together.
 *
 *   Batching. Import is asynchronous by design — the user walks away and comes
 *   back to a notification — which makes bulk panel work a textbook case for the
 *   Message Batches API at half price. USE_BATCH_API=false switches to
 *   interactive priority for a chapter someone is waiting on.
 *
 *   Conditional escalation. The strong model is called only for panels the
 *   workhorse was unsure about. Expected to be 5-15% of them.
 *
 *   Measured estimates. `estimate()` calls countTokens, which is free, rather
 *   than multiplying by a constant somebody guessed in a planning document.
 *
 * Three API details that are easy to get wrong and expensive to discover late:
 * `output_config.format` is the current shape (`output_format` is deprecated);
 * `temperature` and `top_p` are rejected outright by Sonnet 5 and Opus 5; and
 * on Opus 5 extended thinking is on by default, so `max_tokens` has to leave
 * room for it or the answer arrives truncated.
 */

const IMAGE_TOKEN_ESTIMATE = 1_600
const CACHE_TTL = '1h' as const

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic' as const
  private readonly client: Anthropic
  /** Prefixes already warmed this process, keyed by their own hash. */
  private readonly warmed = new Set<string>()

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async estimate(
    tier: ModelTier,
    request: unknown,
  ): Promise<{ inputTokens: number; costCents: number }> {
    const model = modelFor(tier)
    const probe = describeForEstimate(request)

    try {
      const counted = await this.client.messages.countTokens({
        model,
        system: probe.system,
        messages: [{ role: 'user', content: probe.text }],
      })
      // Images are not sent to countTokens — uploading a chapter's pages just to
      // price them would cost more time than the estimate saves. A page reduced
      // to ~1568px is about 1 600 tokens, which is close enough for a figure
      // shown before launch and is corrected by the real per-step cost after.
      const inputTokens = counted.input_tokens + probe.images * IMAGE_TOKEN_ESTIMATE
      return {
        inputTokens,
        costCents: costCents(model, { inputTokens, outputTokens: probe.expectedOutput }),
      }
    } catch {
      // An estimate is a courtesy; failing to produce one must not block a run.
      return { inputTokens: 0, costCents: 0 }
    }
  }

  async transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>> {
    const system = cacheable(transcriptionSystem())
    await this.warm(modelFor('extract'), system)

    return this.structured({
      tier: 'extract',
      system,
      schema: transcriptionSchema,
      maxTokens: 8_000,
      content: [
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: `Chapitre ${request.chapterNumber}, langue attendue : ${request.language}.`,
        },
        ...imageBlocks(request.images),
      ],
    })
  }

  async describePanels(
    request: DescribeRequest,
  ): Promise<ProviderResult<PanelDescription[]>> {
    const system = cacheable(descriptionSystem())
    await this.warm(modelFor('extract'), system)

    const transcribed = Object.entries(request.text)
      .map(([ref, text]) => `${ref} : ${text}`)
      .join('\n')

    const result = await this.structured({
      tier: 'extract',
      system,
      schema: panelDescriptionsSchema,
      maxTokens: 12_000,
      content: [
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, transcribed),
        },
        ...imageBlocks(request.images),
      ],
    })

    return { ...result, value: result.value.panels }
  }

  async extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    /*
     * The cacheable prefix is the system prompt plus the ontology plus the
     * validated entities: stable for the whole chapter, and by far the largest
     * part of the request. What changes per call — the descriptions and the text
     * blocks — goes after the cache breakpoint.
     */
    const system = cacheable(extractionSystem(request.ontology))
    await this.warm(modelFor('extract'), system)

    const known =
      request.knownEntities.length === 0
        ? 'Aucune entité déjà validée à ce stade.'
        : [
            'Entités déjà validées et visibles à ce chapitre (utilisez leur identifiant tel quel) :',
            ...request.knownEntities.map(
              (e) => `  - ${e.id} · ${e.nodeType} · « ${e.label} »`,
            ),
          ].join('\n')

    const blocks = request.textBlocks
      .map((b) => `[${b.ref}${b.panelRef ? ` dans ${b.panelRef}` : ' hors case'}] ${b.text}`)
      .join('\n')

    return this.structured({
      tier: 'extract',
      system,
      schema: extractionSchema,
      maxTokens: 16_000,
      content: [
        { type: 'text', text: known, cache_control: { type: 'ephemeral', ttl: CACHE_TTL } },
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: describePanelsForPrompt(request.descriptions),
        },
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, blocks),
        },
      ],
    })
  }

  async resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    // Identity is where a wrong answer costs most, so this one escalates by
    // default rather than on low confidence.
    return this.structured({
      tier: 'escalate',
      system: cacheable(resolutionSystem()),
      schema: resolutionSchema,
      maxTokens: 6_000,
      content: [
        {
          type: 'text',
          text: [
            `Apparition à rapprocher (chapitre ${request.chapterNumber}) :`,
            `  type : ${request.candidate.nodeType}`,
            `  désignation actuelle : « ${request.candidate.label} »`,
            `  description visuelle : ${request.candidate.description}`,
            '',
            'Entités déjà validées à comparer :',
            ...request.existing.map(
              (e) =>
                `  - ${e.id} · ${e.nodeType} · « ${e.label} » · vue pour la première fois au ch. ${e.firstSeenChapter}\n` +
                `    ${e.description}`,
            ),
          ].join('\n'),
        },
      ],
    })
  }

  async summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>> {
    return this.structured({
      tier: 'extract',
      system: cacheable(summarySystem()),
      schema: summarySchema,
      maxTokens: 6_000,
      content: [
        {
          type: 'text',
          text: [
            `Assertions validées du chapitre ${request.chapterNumber} :`,
            ...request.assertions.map((a) => `  - ${a.id} : ${a.statement}`),
          ].join('\n'),
        },
      ],
    })
  }

  async answer(request: AnswerRequest): Promise<ProviderResult<Answer>> {
    const context =
      request.context.length === 0
        ? 'Aucune assertion disponible dans les chapitres lus.'
        : request.context
            .map(
              (c) =>
                `  - ${c.assertionId} (ch. ${c.chapter}) : ${c.statement}` +
                (c.excerpt ? `\n    preuve : « ${c.excerpt} »` : ''),
            )
            .join('\n')

    return this.structured({
      tier: 'extract',
      system: cacheable(answerSystem(request.boundaryChapter)),
      schema: answerSchema,
      maxTokens: 4_000,
      content: [
        { type: 'text', text: `Contexte autorisé :\n${context}` },
        { type: 'text', text: untrusted('question-utilisateur', request.question) },
      ],
    })
  }

  async embed(_request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    /*
     * Anthropic has no embeddings endpoint. Rather than silently produce
     * meaningless vectors, this fails loudly and points at the alternative:
     * semantic search runs on a locally computed embedding, and the VectorStore
     * abstraction already accommodates that. Returning zeros here would make
     * every similarity search return the same wrong answer with no error.
     */
    throw new Error(
      "Le fournisseur Anthropic n'expose pas d'endpoint d'embeddings. " +
        'La recherche sémantique utilise un modèle local — voir VectorStore.',
    )
  }

  /**
   * Warm a cacheable prefix before fanning out.
   *
   * Concurrent requests cannot read a cache entry that is still being written,
   * so without this the first N parallel calls of a chapter would each pay the
   * full write price and read nothing. One tiny request first, then the rest hit
   * a populated cache.
   */
  private async warm(model: string, system: TextBlockParam[]): Promise<void> {
    const key = `${model}:${JSON.stringify(system)}`
    if (this.warmed.has(key)) return
    this.warmed.add(key)

    try {
      await this.client.messages.create({
        model,
        system,
        // 1, not 0: the API requires at least one output token. The point is to
        // populate the cache, not to read the reply.
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      })
    } catch {
      // A failed warm-up costs a little money and nothing else; the real call
      // will simply write the cache itself.
    }
  }

  private async structured<S extends z.ZodType>(options: {
    tier: ModelTier
    system: TextBlockParam[]
    schema: S
    maxTokens: number
    content: ContentBlockParam[]
  }): Promise<ProviderResult<z.infer<S>>> {
    const model = modelFor(options.tier)
    const messages: MessageParam[] = [{ role: 'user', content: options.content }]

    const params: MessageCreateParamsNonStreaming = {
      model,
      system: options.system,
      // On Opus 5 thinking is on by default and consumes part of this budget,
      // so the ceiling has to cover reasoning plus the JSON.
      max_tokens: options.maxTokens,
      messages,
      output_config: { format: zodOutputFormat(options.schema) },
      // No `tools`. The pages are untrusted input; a model that could fetch a
      // URL found in a document would turn an upload into a server-side
      // request forgery.
      // No `temperature` or `top_p` either — Sonnet 5 and Opus 5 reject them.
    }

    const message = await this.client.messages.parse(params)
    const usage = readUsage(model, message.usage)

    // Refusals arrive as a normal response with a distinct stop_reason. Reading
    // `content` without checking would parse a refusal as data.
    if (message.stop_reason === 'refusal') {
      return {
        value: undefined as z.infer<S>,
        usage,
        refusal:
          'Le modèle a refusé de répondre à cette requête. ' +
          'Rien n’a été extrait ; la page est signalée pour revue manuelle.',
      }
    }

    const parsed = message.parsed_output
    if (parsed === null || parsed === undefined) {
      throw new Error(
        `Réponse non conforme au schéma attendu (stop_reason: ${String(message.stop_reason)}).`,
      )
    }

    return { value: parsed as z.infer<S>, usage }
  }
}

function readUsage(model: string, usage: Anthropic.Usage | undefined): Usage {
  if (!usage) return emptyUsage(model)

  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costCents: costCents(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }),
    modelId: model,
  }
}

/**
 * Mark a system prompt as the cacheable prefix.
 *
 * Typed as TextBlockParam rather than ContentBlockParam because a system prompt
 * is text only — there is no such thing as an image in a system prompt.
 */
function cacheable(text: string): TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl: CACHE_TTL } }]
}

function imageBlocks(images: ImageInput[]): ContentBlockParam[] {
  return images.flatMap((image): ContentBlockParam[] => [
    // The ref precedes its image so the model can cite it. Without this the
    // model has to guess which panel is which, and a guessed ref fails
    // anchoring — correct behaviour, but a wasted call.
    { type: 'text', text: `Image suivante : ${image.ref}` },
    {
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    },
  ])
}

function describePanelsForPrompt(descriptions: PanelDescription[]): string {
  if (descriptions.length === 0) return 'Aucune description de case disponible.'
  return [
    'Descriptions des cases produites lors de ce traitement :',
    ...descriptions.map((d) =>
      [
        `  [${d.panel_ref}] ${d.description}`,
        d.setting ? `    lieu : ${d.setting}` : '',
        d.characters_visible.length > 0
          ? `    présents : ${d.characters_visible.join(' ; ')}`
          : '',
        d.actions.length > 0 ? `    actions : ${d.actions.join(' ; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n')
}

/**
 * Turn any request into something countTokens can price.
 *
 * Approximate by construction — it counts the text and estimates the images —
 * and that is the honest trade: a precise estimate would cost as much as the
 * call it is estimating.
 */
function describeForEstimate(request: unknown): {
  system: string
  text: string
  images: number
  expectedOutput: number
} {
  const r = request as Partial<
    TranscribeRequest & DescribeRequest & ExtractRequest & { question: string }
  >

  const images = Array.isArray(r.images) ? r.images.length : 0
  const parts: string[] = []
  if (r.allowedRefs) parts.push(refList(r.allowedRefs))
  if (r.ontology) parts.push(r.ontology)
  if (r.textBlocks) parts.push(r.textBlocks.map((b) => b.text).join('\n'))
  if (r.descriptions) parts.push(describePanelsForPrompt(r.descriptions))
  if (r.question) parts.push(r.question)

  return {
    system: extractionSystem(r.ontology ?? ''),
    text: parts.join('\n\n') || 'estimation',
    images,
    // Output is bounded by the schemas' array limits; this is the observed
    // middle of that range rather than the ceiling.
    expectedOutput: images > 0 ? images * 400 : 3_000,
  }
}
