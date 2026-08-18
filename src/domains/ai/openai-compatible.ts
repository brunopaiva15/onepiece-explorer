import 'server-only'
import { z } from 'zod'
import {
  answerSystem,
  arbitrationCardList,
  arbitrationSystem,
  descriptionSystem,
  extractionSystem,
  glossaryList,
  knownEntitiesList,
  parallelText,
  refList,
  resolutionSystem,
  summarySystem,
  transcriptionSystem,
  untrusted,
  wikiPages,
} from './prompts.ts'
import {
  answerSchema,
  arbitrationSchema,
  candidateAssertionSchema,
  candidateEntitySchema,
  candidateEventSchema,
  candidateMysterySchema,
  clampExtraction,
  clampPanelDescriptions,
  panelDescriptionsSchema,
  resolutionSchema,
  summarySchema,
  transcriptionSchema,
  type Answer,
  type Arbitration,
  type Extraction,
  type PanelDescription,
  type Resolution,
  type Summary,
  type Transcription,
} from './schemas.ts'
import {
  emptyUsage,
  type AnswerRequest,
  type ArbitrateRequest,
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

/** LM Studio's default. Overridden by LOCAL_AI_BASE_URL. */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1'

export interface LocalModelConfig {
  baseUrl: string
  model: string
  embedModel: string | null
  apiKey: string | null
  cloudflareAccessClientId: string | null
  cloudflareAccessClientSecret: string | null
  reasoningEffort: string
  timeoutMs: number
}

export function localModelConfig(): LocalModelConfig | null {
  const baseUrl = process.env.LOCAL_AI_BASE_URL?.trim()
  const model = process.env.LOCAL_AI_MODEL?.trim()
  if (!baseUrl || !model) return null

  const cloudflareAccessClientId =
    process.env.CLOUDFLARE_ACCESS_CLIENT_ID?.trim() || null
  const cloudflareAccessClientSecret =
    process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET?.trim() || null

  if (Boolean(cloudflareAccessClientId) !== Boolean(cloudflareAccessClientSecret)) {
    throw new Error(
      'CLOUDFLARE_ACCESS_CLIENT_ID et CLOUDFLARE_ACCESS_CLIENT_SECRET doivent être configurés ensemble.',
    )
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    embedModel: process.env.LOCAL_AI_EMBED_MODEL?.trim() || null,
    apiKey: process.env.LOCAL_AI_API_KEY?.trim() || null,
    cloudflareAccessClientId,
    cloudflareAccessClientSecret,
    reasoningEffort: process.env.LOCAL_AI_REASONING_EFFORT?.trim() || 'none',
    timeoutMs: Number(process.env.LOCAL_AI_TIMEOUT_MS) || 600_000,
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

/**
 * Output ceilings used only by the self-hosted OpenAI-compatible provider.
 *
 * llama.cpp/LM Studio constrained decoding can treat an array's `maxItems` as
 * a strong hint to keep filling it. The generic extraction schema deliberately
 * has generous emergency ceilings (40/80/20/10), which made Qwen spend sixteen
 * thousand output tokens filling `entities` and `assertions` on a five-passage
 * chapter before it ever reached the later arrays. The pipeline then split and
 * retried a perfectly small chapter, multiplying one short inference into
 * minutes of work.
 *
 * These ceilings scale with the material in the current slice. They are still
 * deliberately generous, but a five-passage summary no longer advertises the
 * capacity of a twenty-panel manga slice. The canonical schemas and downstream
 * validation remain unchanged, so this only changes what the local model is
 * allowed to emit in one call.
 */
export interface LocalExtractionLimits {
  units: number
  entities: number
  assertions: number
  events: number
  mysteries: number
  maxTokens: number
}

export function localExtractionLimitsForUnits(rawUnits: number): LocalExtractionLimits {
  const units = Math.max(1, Math.floor(rawUnits))

  return {
    units,
    entities: Math.min(40, 8 + Math.ceil(units * 0.8)),
    assertions: Math.min(80, 10 + units * 2),
    events: Math.min(20, 4 + Math.ceil(units * 0.8)),
    mysteries: Math.min(10, 2 + Math.ceil(units * 0.2)),
    maxTokens: Math.min(14_000, Math.max(8_000, 6_000 + units * 400)),
  }
}

function extractionUnits(request: ExtractRequest): number {
  if (request.source === 'summary') return request.textBlocks.length
  return request.descriptions.length > 0 ? request.descriptions.length : request.textBlocks.length
}

function localExtractionSchema(limits: LocalExtractionLimits) {
  return z.object({
    entities: z.array(candidateEntitySchema).max(limits.entities),
    assertions: z.array(candidateAssertionSchema).max(limits.assertions),
    events: z.array(candidateEventSchema).max(limits.events),
    mysteries: z.array(candidateMysterySchema).max(limits.mysteries),
  })
}

function localExtractionDiscipline(limits: LocalExtractionLimits): string {
  return [
    'LIMITES DE SORTIE POUR CE MODÈLE AUTO-HÉBERGÉ.',
    'Les maxima ci-dessous sont des garde-fous, JAMAIS des objectifs à remplir.',
    'Arrêtez chaque tableau dès que les éléments réellement présents dans cette tranche ont été extraits.',
    'Ne créez pas une entité pour reformuler un fait, une action, un état ou la conclusion d’une scène :',
    'un nœud « concept » est une notion durable du monde, pas un événement nominalisé.',
    `Cette tranche contient ${limits.units} unité(s) de matière. Plafonds : ` +
      `${limits.entities} entités, ${limits.assertions} relations, ` +
      `${limits.events} événements, ${limits.mysteries} mystères.`,
  ].join('\n')
}

/**
 * A self-hosted model behind an OpenAI-compatible endpoint.
 *
 * No tools are ever sent. Every structured answer is constrained server-side
 * and then parsed again with Zod; evidence anchoring remains downstream and is
 * provider-independent.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'local' as const

  constructor(private readonly config: LocalModelConfig) {}

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

    return { ...result, value: clampPanelDescriptions(result.value?.panels ?? []) }
  }

  async extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    const known = knownEntitiesList(request.knownEntities, request.knownEntitiesTotal)
    const limits = localExtractionLimitsForUnits(extractionUnits(request))
    const schema = localExtractionSchema(limits)

    const blocks = request.textBlocks
      .map((b) =>
        request.source === 'summary'
          ? `[${b.ref}] ${b.text}`
          : `[${b.ref}${b.panelRef ? ` dans ${b.panelRef}` : ' hors case'}] ${b.text}`,
      )
      .join('\n\n')

    console.log(
      `[local-ai] extraction ${limits.units} unité(s) : plafonds ` +
        `${limits.entities}/${limits.assertions}/${limits.events}/${limits.mysteries}, ` +
        `${limits.maxTokens} tokens de sortie`,
    )

    const result = await this.structured({
      system: extractionSystem(
        request.ontology,
        request.source,
        request.parallel !== undefined,
      ),
      schema,
      name: 'extraction',
      maxTokens: limits.maxTokens,
      content: [
        { type: 'text', text: localExtractionDiscipline(limits) },
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

  async arbitrate(request: ArbitrateRequest): Promise<ProviderResult<Arbitration>> {
    return this.structured({
      system: arbitrationSystem(request.chapterNumber),
      schema: arbitrationSchema,
      name: 'arbitration',
      maxTokens: 16_000,
      content: [
        { type: 'text', text: wikiPages(request.pages) },
        { type: 'text', text: arbitrationCardList(request.cards) },
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
      reasoning_effort: this.config.reasoningEffort,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.name,
          strict: true,
          schema: jsonSchemaOf(options.schema),
        },
      },
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
      costCents: 0,
      modelId: this.config.model,
    }
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const url = `${this.config.baseUrl}${path}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    if (this.config.cloudflareAccessClientId) {
      headers['CF-Access-Client-Id'] = this.config.cloudflareAccessClientId
    }
    if (this.config.cloudflareAccessClientSecret) {
      headers['CF-Access-Client-Secret'] = this.config.cloudflareAccessClientSecret
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error(
          `${url} n’a pas répondu en ${Math.round(this.config.timeoutMs / 1000)} s : ` +
            'appel abandonné. Le serveur de modèle est probablement figé ou surchargé ; ' +
            'LOCAL_AI_TIMEOUT_MS ajuste ce délai si le matériel est simplement lent.',
        )
      }
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

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = json
  return rest
}
