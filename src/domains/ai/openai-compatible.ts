import 'server-only'
import { z } from 'zod'
import {
  answerSystem,
  descriptionSystem,
  extractionSystem,
  glossaryList,
  refList,
  resolutionSystem,
  summarySystem,
  transcriptionSystem,
  untrusted,
} from './prompts.ts'
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
} from './schemas.ts'
import {
  emptyUsage,
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
 * A model you host yourself, behind an OpenAI-compatible endpoint.
 *
 * Written for LM Studio serving a vision-capable Qwen on a private VM, but it
 * assumes nothing beyond `/v1/chat/completions` with `response_format:
 * {type: "json_schema"}` and `/v1/embeddings`. Any server speaking that dialect
 * works — llama.cpp, vLLM, Ollama's compatible layer.
 *
 * Three things carry over from the Anthropic provider unchanged, because they
 * are properties of this product rather than of a vendor:
 *
 *   No tools, ever. The pages are untrusted input, and a model that could
 *   follow a URL found in a document would turn an upload into a server-side
 *   request forgery. There is no `tools` key anywhere below.
 *
 *   Strict schemas. Every answer is constrained server-side by the JSON schema
 *   *and* re-validated here with Zod. The first is the model's contract, the
 *   second is what this process will actually believe — a server that ignored
 *   `response_format` would be caught by the second, loudly.
 *
 *   Evidence anchoring is not here at all, and that is the point: it lives in
 *   `anchoring.ts`, downstream of every provider. Swapping the model cannot
 *   loosen it. A weaker model does not hallucinate into the graph; it fills the
 *   quarantine, which is visible and countable.
 *
 * What does *not* carry over: prompt caching (irrelevant when the weights are
 * on your own GPU), batching, and cost. `costCents` is zero throughout — the
 * bill for these calls is electricity, and reporting an invented figure would
 * corrupt the one dashboard meant to be trusted against a measured estimate.
 */

/** LM Studio's default. Overridden by LOCAL_AI_BASE_URL. */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1'

export interface LocalModelConfig {
  baseUrl: string
  model: string
  embedModel: string | null
  apiKey: string | null
  /**
   * Reasoning budget. 'none' by default: these calls fill a schema from
   * material already in the prompt, and tokens spent deliberating are tokens
   * spent on GPU time that produces no field of the answer.
   */
  reasoningEffort: string
}

export function localModelConfig(): LocalModelConfig | null {
  const baseUrl = process.env.LOCAL_AI_BASE_URL?.trim()
  const model = process.env.LOCAL_AI_MODEL?.trim()
  if (!baseUrl || !model) return null

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    embedModel: process.env.LOCAL_AI_EMBED_MODEL?.trim() || null,
    apiKey: process.env.LOCAL_AI_API_KEY?.trim() || null,
    reasoningEffort: process.env.LOCAL_AI_REASONING_EFFORT?.trim() || 'none',
  }
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string | ContentPart[]
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null; refusal?: string | null }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string } | string
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'local' as const

  constructor(private readonly config: LocalModelConfig) {}

  /**
   * No countTokens endpoint, and no bill to estimate.
   *
   * The figure shown before a run exists to stop anyone discovering a price
   * from an invoice. Self-hosted, there is no invoice — so this reports the
   * size of the work and a cost of zero rather than inventing a number that
   * would then be compared against a real one.
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
      system: transcriptionSystem(),
      schema: transcriptionSchema,
      name: 'transcription',
      maxTokens: 8_000,
      content: [
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: `Chapitre ${request.chapterNumber}, langue attendue : ${request.language}.`,
        },
        ...imageParts(request.images),
      ],
    })
  }

  async describePanels(
    request: DescribeRequest,
  ): Promise<ProviderResult<PanelDescription[]>> {
    const transcribed = Object.entries(request.text)
      .map(([ref, text]) => `${ref} : ${text}`)
      .join('\n')

    const result = await this.structured({
      system: descriptionSystem(),
      schema: panelDescriptionsSchema,
      name: 'descriptions',
      maxTokens: 12_000,
      content: [
        { type: 'text', text: refList(request.allowedRefs) },
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, transcribed),
        },
        ...imageParts(request.images),
      ],
    })

    // Clamped here as well as in the step: a provider must not be the reason a
    // budget is exceeded, whichever caller it is speaking to.
    return { ...result, value: clampPanelDescriptions(result.value?.panels ?? []) }
  }

  async extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    const known =
      request.knownEntities.length === 0
        ? 'Aucune entité déjà validée à ce stade.'
        : [
            'Entités déjà validées et visibles à ce chapitre (utilisez leur identifiant tel quel) :',
            ...request.knownEntities.map((e) => `  - ${e.id} · ${e.nodeType} · « ${e.label} »`),
          ].join('\n')

    const blocks = request.textBlocks
      .map((b) =>
        request.source === 'summary'
          ? `[${b.ref}] ${b.text}`
          : `[${b.ref}${b.panelRef ? ` dans ${b.panelRef}` : ' hors case'}] ${b.text}`,
      )
      .join('\n\n')

    const result = await this.structured({
      system: extractionSystem(request.ontology, request.source),
      schema: extractionSchema,
      name: 'extraction',
      maxTokens: 16_000,
      content: [
        { type: 'text', text: known },
        { type: 'text', text: glossaryList(request.glossary) },
        { type: 'text', text: refList(request.allowedRefs) },
        ...(request.descriptions.length > 0
          ? [{ type: 'text' as const, text: describeForPrompt(request.descriptions) }]
          : []),
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, blocks),
        },
      ],
    })

    return { ...result, value: clampExtraction(result.value) }
  }

  async resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    const existing = request.existing
      .map(
        (e) =>
          `  - ${e.id} · ${e.nodeType} · « ${e.label} » (vu au chapitre ${e.firstSeenChapter}) : ${e.description}`,
      )
      .join('\n')

    return this.structured({
      system: resolutionSystem(request.source),
      schema: resolutionSchema,
      name: 'resolution',
      maxTokens: 4_000,
      content: [
        {
          type: 'text',
          text:
            `Chapitre ${request.chapterNumber}.\n\nFigure nouvellement vue :\n` +
            `  ${request.candidate.nodeType} · « ${request.candidate.label} » : ${request.candidate.description}\n\n` +
            `Entités existantes à comparer :\n${existing || '  (aucune)'}`,
        },
      ],
    })
  }

  async summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>> {
    const statements = request.assertions
      .map((a) => `  - [${a.id}] ${a.statement}`)
      .join('\n')

    return this.structured({
      system: summarySystem(),
      schema: summarySchema,
      name: 'summary',
      maxTokens: 4_000,
      content: [
        {
          type: 'text',
          text: `Chapitre ${request.chapterNumber}. Assertions acceptées :\n${statements}`,
        },
      ],
    })
  }

  async answer(request: AnswerRequest): Promise<ProviderResult<Answer>> {
    const context = request.context
      .map(
        (c) =>
          `  - [${c.assertionId}] (chapitre ${c.chapter}) ${c.statement}` +
          (c.excerpt ? `\n      extrait : « ${c.excerpt} »` : ''),
      )
      .join('\n')

    return this.structured({
      system: answerSystem(request.boundaryChapter),
      schema: answerSchema,
      name: 'answer',
      maxTokens: 4_000,
      content: [
        {
          type: 'text',
          text:
            `Frontière : chapitre ${request.boundaryChapter}. ` +
            `Vous ne disposez que de ceci :\n${context || '  (aucun élément)'}\n\n` +
            `Question : ${request.question}`,
        },
      ],
    })
  }

  async embed(request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    const model = this.config.embedModel
    if (!model) {
      throw new Error(
        "LOCAL_AI_EMBED_MODEL n'est pas configuré : ce fournisseur ne peut pas produire de vecteurs.",
      )
    }
    if (request.texts.length === 0) {
      return { value: [], usage: emptyUsage(model) }
    }

    const body = await this.post('/embeddings', { model, input: request.texts })
    const parsed = z
      .object({ data: z.array(z.object({ embedding: z.array(z.number()) })) })
      .safeParse(body)

    if (!parsed.success) {
      throw new Error(
        `Réponse d'embeddings inattendue de ${model} : ${JSON.stringify(body).slice(0, 300)}`,
      )
    }

    return {
      value: parsed.data.data.map((row) => row.embedding),
      usage: emptyUsage(model),
    }
  }

  /**
   * One structured call, constrained twice.
   *
   * `response_format` is the server's contract with the model; `schema.parse`
   * is this process's contract with the server. Keeping both means a server
   * that silently ignored the first is caught by the second instead of feeding
   * loosely-shaped data into the pipeline.
   */
  private async structured<S extends z.ZodType>(options: {
    system: string
    schema: S
    name: string
    maxTokens: number
    content: ContentPart[]
  }): Promise<ProviderResult<z.infer<S>>> {
    const messages: ChatMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.content },
    ]

    const body = (await this.post('/chat/completions', {
      model: this.config.model,
      messages,
      max_tokens: options.maxTokens,
      // Tokens spent deliberating are GPU seconds that produce no field of the
      // answer: everything these calls need is already in the prompt.
      reasoning_effort: this.config.reasoningEffort,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.name,
          strict: true,
          schema: jsonSchemaOf(options.schema),
        },
      },
      // No `tools`. See the class comment: the pages are untrusted input.
    })) as ChatResponse

    const choice = body.choices?.[0]
    const usage = this.usageOf(body)

    if (choice?.message?.refusal) {
      return {
        value: undefined as z.infer<S>,
        usage,
        refusal:
          'Le modèle a refusé de répondre à cette requête. ' +
          'Rien n’a été extrait ; la page est signalée pour revue manuelle.',
      }
    }

    if (choice?.finish_reason === 'length') {
      throw new Error(
        `La réponse a atteint le plafond de ${options.maxTokens} tokens et s'est arrêtée en ` +
          'cours de JSON. Il y a trop de matière dans un seul appel : réduisez la tranche.',
      )
    }

    const content = choice?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error(
        `Réponse vide de ${this.config.model} (finish_reason: ${String(choice?.finish_reason)}).`,
      )
    }

    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      throw new Error(
        `Réponse illisible de ${this.config.model} : le contenu n'est pas du JSON. ` +
          `Vérifiez que le serveur applique bien response_format json_schema. ` +
          `Début : ${content.slice(0, 200)}`,
      )
    }

    const parsed = options.schema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `Réponse non conforme au schéma « ${options.name} » : ` +
          parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')} — ${i.message}`)
            .join(' · '),
      )
    }

    return { value: parsed.data as z.infer<S>, usage }
  }

  private usageOf(body: ChatResponse): Usage {
    return {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // Zero, and not a placeholder: these tokens cost electricity, not money,
      // and a fabricated figure would poison the cost dashboard.
      costCents: 0,
      modelId: this.config.model,
    }
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
    } catch (error: unknown) {
      /*
       * The endpoint is bound to localhost on the machine that hosts the model.
       * A refused connection here almost always means this process is running
       * somewhere else — which is worth saying, because "fetch failed" sends
       * people to check the model instead of checking where they are.
       */
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Serveur de modèle injoignable à ${url} : ${detail}. ` +
          'Cet endpoint est en écoute sur localhost de la machine qui héberge le modèle ; ' +
          'le worker doit tourner sur cette machine, ou passer par un tunnel vers elle.',
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `${url} a répondu ${response.status} ${response.statusText}. ${text.slice(0, 300)}`,
      )
    }

    return response.json()
  }
}

function imageParts(images: ImageInput[]): ContentPart[] {
  return images.map((image) => ({
    type: 'image_url' as const,
    image_url: { url: `data:${image.mediaType};base64,${image.data}` },
  }))
}

function describeForPrompt(descriptions: PanelDescription[]): string {
  if (descriptions.length === 0) return 'Aucune description de case disponible.'
  return [
    'Descriptions des cases, produites par cette exécution :',
    ...descriptions.map((d) => `  [${d.panel_ref}] ${d.description}`),
  ].join('\n')
}

/**
 * The schema as the server wants it.
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
