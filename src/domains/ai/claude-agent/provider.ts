import 'server-only'
import { z } from 'zod'
import {
  answerSystem,
  descriptionSystem,
  extractionSystem,
  glossaryList,
  knownEntitiesList,
  panelDescriptionList,
  parallelText,
  proposedSoFarList,
  refList,
  resolutionSystem,
  summarySystem,
  textBlockList,
  transcriptionSystem,
  untrusted,
} from '../prompts.ts'
import {
  answerSchema,
  clampExtraction,
  clampPanelDescriptions,
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
} from '../schemas.ts'
import {
  modelFor,
  reasoningFor,
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
} from '../provider.ts'
import { ClaudeAgentError, runClaude, type AgentBlock, type AgentUsage } from './runtime.ts'

/**
 * The provider that answers on a Claude Max subscription.
 *
 * It asks Claude exactly what the Anthropic provider asks: the same system
 * prompts, in the same order, with the same content blocks, constrained by the
 * same schemas and re-validated with the same Zod. What changes is underneath —
 * the Claude Agent SDK and an OAuth token from `claude setup-token`, instead of
 * the Messages API and a metered key.
 *
 * Three properties are carried over deliberately, because they belong to this
 * product rather than to a vendor:
 *
 *   No tools, ever. The pages are an untrusted document; an agent that could
 *   follow a URL found in one would turn an upload into a server-side request
 *   forgery. See `agentPayload` — `tools: []`, no MCP servers, no settings read
 *   from disk.
 *
 *   Strict schemas, twice. The SDK's `outputFormat` constrains the model, and
 *   `schema.parse` here is what this process will actually believe.
 *
 *   Anchoring is not here at all, and that is the point: it lives downstream of
 *   every provider, so changing who answers cannot loosen it. A weaker answer
 *   does not reach the graph, it fills the quarantine.
 *
 * Two things the Anthropic provider does are deliberately absent. There is no
 * explicit prompt-cache warm-up: cache control is not exposed through this SDK,
 * and the CLI manages its own caching. And there is no cost: a subscription is
 * not billed per token, so `costCents` is zero throughout, exactly as it is for
 * a self-hosted model. Tokens are still reported — they are the honest measure
 * of how much of an allowance a chapter consumed — but inventing a price for
 * them would corrupt the one dashboard meant to be trusted.
 */
export class ClaudeAgentProvider implements ModelProvider {
  readonly name = 'claude-max' as const

  /**
   * No token counter, and no bill to estimate.
   *
   * The figure shown before a run exists so nobody discovers a price from an
   * invoice. On a subscription there is no invoice, so this reports the size of
   * the work and a cost of zero rather than inventing a number that would then
   * be compared against a real one.
   */
  async estimate(
    _tier: ModelTier,
    request: unknown,
  ): Promise<{ inputTokens: number; costCents: number }> {
    const text = JSON.stringify(request ?? {})
    return { inputTokens: Math.ceil(text.length / 4), costCents: 0 }
  }

  async transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>> {
    return this.structured({
      label: `Transcription du chapitre ${request.chapterNumber}`,
      tier: 'extract',
      system: transcriptionSystem(),
      schema: transcriptionSchema,
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

  async describePanels(request: DescribeRequest): Promise<ProviderResult<PanelDescription[]>> {
    const transcribed = Object.entries(request.text)
      .map(([ref, text]) => `${ref} : ${text}`)
      .join('\n')

    const result = await this.structured({
      label: `Description des cases du chapitre ${request.chapterNumber}`,
      tier: 'describe',
      system: descriptionSystem(),
      schema: panelDescriptionsSchema,
      content: [
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, transcribed),
        },
        ...imageBlocks(request.images),
      ],
    })

    // Clamped here as well as in the step: a provider must not be the reason a
    // budget is exceeded, whichever caller it is speaking to.
    return { ...result, value: clampPanelDescriptions(result.value?.panels ?? []) }
  }

  async extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    const result = await this.structured({
      label: `Extraction du chapitre ${request.chapterNumber}`,
      tier: 'extract',
      system: extractionSystem(
        request.ontology,
        request.source,
        request.parallel !== undefined,
      ),
      schema: extractionSchema,
      content: [
        // The total as well as the list: a truncation the model cannot see is
        // one it reads as "this thing does not exist".
        {
          type: 'text',
          text: knownEntitiesList(request.knownEntities, request.knownEntitiesTotal),
        },
        { type: 'text', text: glossaryList(request.glossary) },
        ...(request.proposedSoFar && request.proposedSoFar.length > 0
          ? [{ type: 'text' as const, text: proposedSoFarList(request.proposedSoFar) }]
          : []),
        { type: 'text', text: refList(request.allowedRefs) },
        // Omitted rather than sent empty when there are no panels: "Cases :"
        // followed by nothing is an invitation to describe cases that were
        // never supplied.
        ...(request.descriptions.length > 0
          ? [{ type: 'text' as const, text: panelDescriptionList(request.descriptions) }]
          : []),
        {
          type: 'text',
          text: untrusted(
            `chapitre-${request.chapterNumber}`,
            textBlockList(request.textBlocks, request.source),
          ),
        },
        // After the citable text, never before it. The passages a proposal must
        // quote are what the model should be reading when it writes one; the
        // translation is there to be consulted about a name, and its position
        // says so.
        ...(request.parallel
          ? [
              {
                type: 'text' as const,
                text: parallelText(request.parallel.language, request.parallel.passages),
              },
            ]
          : []),
      ],
    })

    // Clamped, not rejected. The budgets are advisory to the model and binding
    // here — an answer a little over must not lose the slice it came from.
    return { ...result, value: clampExtraction(result.value) }
  }

  async resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    // Identity is where a wrong answer costs most, so this one escalates by
    // default rather than on low confidence.
    return this.structured({
      label: `Rapprochement d’identité au chapitre ${request.chapterNumber}`,
      tier: 'escalate',
      system: resolutionSystem(request.source),
      schema: resolutionSchema,
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
      label: `Résumé du chapitre ${request.chapterNumber}`,
      tier: 'extract',
      system: summarySystem(),
      schema: summarySchema,
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
      label: 'Réponse de l’assistant',
      tier: 'extract',
      system: answerSystem(request.boundaryChapter),
      schema: answerSchema,
      content: [
        { type: 'text', text: `Contexte autorisé :\n${context}` },
        { type: 'text', text: untrusted('question-utilisateur', request.question) },
      ],
    })
  }

  async embed(_request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    /*
     * Same answer as the Anthropic provider, for the same reason: there is no
     * embeddings endpoint behind this, and returning zeros would make every
     * similarity search return the same wrong answer with no error.
     */
    throw new Error(
      "Claude n'expose pas d'endpoint d'embeddings. " +
        'La recherche sémantique utilise un modèle local — voir VectorStore.',
    )
  }

  /**
   * One structured call, constrained twice.
   *
   * `outputFormat` is the SDK's contract with the model; `schema.parse` is this
   * process's contract with the SDK. Keeping both means an answer that somehow
   * escaped the first is caught by the second instead of being fed loosely
   * shaped into the pipeline.
   */
  private async structured<S extends z.ZodType>(options: {
    label: string
    tier: ModelTier
    system: string
    schema: S
    content: AgentBlock[]
  }): Promise<ProviderResult<z.infer<S>>> {
    const model = modelFor(options.tier)
    // Per tier, and the extraction tier is where it bites: see reasoningFor.
    const reasoning = reasoningFor(options.tier)

    const response = await runClaude({
      label: options.label,
      system: options.system,
      content: options.content,
      model,
      schema: jsonSchemaOf(options.schema),
      ...(reasoning.thinking ? { thinking: 'disabled' as const } : {}),
      ...(reasoning.effort ? { effort: reasoning.effort } : {}),
    })

    const usage = usageOf(model, response.usage)

    // Refusals are an answer, not a failure. Reading `structured` without
    // checking would parse a refusal as data.
    if (response.refusal) {
      return { value: undefined as z.infer<S>, usage, refusal: response.refusal }
    }

    const parsed = options.schema.safeParse(response.structured)
    if (!parsed.success) {
      throw new ClaudeAgentError(
        'invalid',
        `${options.label} : réponse non conforme au schéma attendu — ` +
          parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
            .join(' · ') +
          '. Rien n’a été enregistré pour cet appel.',
      )
    }

    return { value: parsed.data as z.infer<S>, usage }
  }
}

/**
 * Tokens as measured, cost as zero.
 *
 * The tokens are real and worth recording: they are what a chapter cost the
 * subscription's allowance, which is the number to look at when an import stops
 * halfway through the month. The money is not real — nothing here is billed per
 * token — and a fabricated figure would poison the cost dashboard, which exists
 * precisely so an estimate can be checked against something true.
 */
function usageOf(model: string, usage: AgentUsage): Usage {
  return { ...usage, costCents: 0, modelId: model }
}

function imageBlocks(images: ImageInput[]): AgentBlock[] {
  return images.flatMap((image): AgentBlock[] => [
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

/**
 * The schema as the SDK wants it.
 *
 * `$schema` is stripped: it is metadata about the document, not a constraint,
 * and a strict validator that does not expect it rejects the whole request for
 * a key that says nothing about the answer.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = json
  return rest
}
