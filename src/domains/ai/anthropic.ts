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
  arbitrationCardList,
  arbitrationSystem,
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
  wikiPages,
} from './prompts.ts'
import {
  answerSchema,
  arbitrationSchema,
  clampExtraction,
  extractionSchema,
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
  costCents,
  emptyUsage,
  modelFor,
  reasoningFor,
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

/**
 * The real provider.
 *
 * Five cost levers, all of them on by default:
 *
 *   Bounded reasoning on extraction. Adaptive thinking runs by default on
 *   Sonnet 5 and is billed as output; on the tier that answers eleven hundred
 *   times it is turned off and the effort set explicitly. See `reasoningFor` —
 *   the reasons are about this pipeline, not about models in general.
 *
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

/**
 * Silence maximal toléré sur un flux avant de l'abandonner.
 *
 * Le timeout du SDK ne couvre que l'attente des en-têtes : une fois le flux
 * ouvert, plus rien ne borne la lecture. Une connexion qui meurt sans se
 * fermer — Wi-Fi qui change, machine en veille, proxy qui coupe — laisse
 * `finalMessage()` en attente pour toujours, sans erreur, donc sans retry :
 * l'étape reste « en cours » un quart d'heure avant que quiconque comprenne.
 *
 * Deux minutes parce que le pire silence légitime est le premier token d'un
 * prompt volumineux non caché — quelques dizaines de secondes — et qu'entre
 * deux événements d'un flux vivant l'écart se mesure en secondes. Un appel
 * coupé ici est relancé par l'étape au prix d'un appel, contre un run entier
 * perdu sinon.
 */
const STREAM_IDLE_MS = 120_000

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic' as const
  private readonly client: Anthropic
  /**
   * Prefixes warmed this process, keyed by their own hash — the *promise*, not
   * a flag.
   *
   * A Set marked before the await, so a second caller arriving while the
   * warm-up was still in flight saw "already warmed" and went straight out with
   * a cache that did not exist yet. That is precisely the race the warm-up
   * exists to prevent, and it stayed harmless only while slices ran one at a
   * time. Holding the promise makes concurrent callers wait for the same
   * warm-up and then all read the same cache entry.
   */
  private readonly warmed = new Map<string, Promise<void>>()

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
      const counted = await this.client.messages.countTokens(
        {
          model,
          system: probe.system,
          messages: [{ role: 'user', content: probe.text }],
        },
        // Une estimation est une politesse ; elle n'a pas le droit de faire
        // attendre le lancement dix minutes sur une connexion qui pend.
        { timeout: 10_000, maxRetries: 0 },
      )
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
    // The warm-up has to name the model the call will actually use: a prompt
    // cache is per-model, so warming Sonnet before calling Haiku would pay for
    // an entry nobody reads and leave the real first call to write its own.
    await this.warm(modelFor('describe'), system)

    const transcribed = Object.entries(request.text)
      .map(([ref, text]) => `${ref} : ${text}`)
      .join('\n')

    const result = await this.structured({
      tier: 'describe',
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
    const system = cacheable(
      extractionSystem(request.ontology, request.source, request.parallel !== undefined),
    )
    await this.warm(modelFor('extract'), system)

    const known = knownEntitiesList(request.knownEntities, request.knownEntitiesTotal)

    const settled = glossaryList(request.glossary)

    const blocks = textBlockList(request.textBlocks, request.source)

    const result = await this.structured({
      tier: 'extract',
      system,
      schema: extractionSchema,
      // Headroom above what a sliced call needs, not a substitute for slicing:
      // a ceiling can always be met by a chapter denser than the last one, and
      // the step bounds its input for that reason. It was 32 000, which bought
      // no safety the halve-and-retry path does not already provide and made
      // every call announce a longer expected duration than it needed.
      maxTokens: 16_000,
      content: [
        { type: 'text', text: known },
        // The cache breakpoint sits after the settled vocabulary: system
        // prompt, ontology, validated entities and glossary are identical for
        // every slice of a chapter, and they are the bulk of the request.
        { type: 'text', text: settled, cache_control: { type: 'ephemeral', ttl: CACHE_TTL } },
        /*
         * After the breakpoint, and that is the whole point of its being here.
         *
         * The cached prefix — system prompt, ontology, accepted entities,
         * glossary — is identical for every slice of a chapter, which is what
         * makes the extra calls cheap. This list changes with every slice, so
         * putting it above the breakpoint would spend the cache to buy the
         * feature.
         */
        ...(request.proposedSoFar && request.proposedSoFar.length > 0
          ? [{ type: 'text' as const, text: proposedSoFarList(request.proposedSoFar) }]
          : []),
        { type: 'text', text: refList(request.allowedRefs) },
        // Omitted rather than sent empty when there are no panels: the API
        // rejects an empty text block, and "Cases :" followed by nothing is
        // an invitation to describe cases that were never supplied.
        ...(request.descriptions.length > 0
          ? [{ type: 'text' as const, text: panelDescriptionList(request.descriptions) }]
          : []),
        {
          type: 'text',
          text: untrusted(`chapitre-${request.chapterNumber}`, blocks),
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
      tier: 'escalate',
      system: cacheable(resolutionSystem(request.source)),
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

  async arbitrate(request: ArbitrateRequest): Promise<ProviderResult<Arbitration>> {
    /*
     * The page first, the cards after, and that order is the cacheable one.
     *
     * A chapter's cards are arbitrated in slices when there are many of them,
     * and every slice carries the same page — several thousand tokens of it. Put
     * ahead of the cards it is a stable prefix the second slice reads from cache
     * instead of paying for again.
     */
    return this.structured({
      tier: 'extract',
      system: cacheable(arbitrationSystem(request.chapterNumber)),
      schema: arbitrationSchema,
      maxTokens: 16_000,
      content: [
        {
          type: 'text',
          text: wikiPages(request.pages),
          cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
        },
        { type: 'text', text: arbitrationCardList(request.cards) },
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

    const existing = this.warmed.get(key)
    if (existing) return existing

    const started = (async () => {
      try {
        await this.client.messages.create(
          {
            model,
            system,
            // 1, not 0: the API requires at least one output token. The point is
            // to populate the cache, not to read the reply.
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ok' }],
          },
          /*
           * Borné court, parce que tout attend derrière. Le timeout par défaut
           * du SDK est de dix minutes, retenté deux fois : un réchauffage qui
           * pend pouvait bloquer la première tranche une demi-heure avant
           * qu'elle n'envoie quoi que ce soit. Une optimisation de cache ne
           * mérite pas ce pouvoir — au pire, l'appel réel écrit le cache.
           */
          { timeout: 30_000, maxRetries: 1 },
        )
      } catch {
        // A failed warm-up costs a little money and nothing else; the real call
        // will simply write the cache itself.
      }
    })()

    this.warmed.set(key, started)
    return started
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
    // Per tier, and the extraction tier is where it bites: see reasoningFor.
    const reasoning = reasoningFor(options.tier)

    const params: MessageCreateParamsNonStreaming = {
      model,
      system: options.system,
      // Where thinking is left on — Opus 5 — it consumes part of this budget,
      // so the ceiling has to cover reasoning plus the JSON.
      max_tokens: options.maxTokens,
      messages,
      output_config: {
        format: zodOutputFormat(options.schema),
        // `effort` sits inside output_config, beside the format, not at the top
        // level. Omitted rather than sent at its default, so a tier that has no
        // opinion sends the request it sent before this existed.
        ...(reasoning.effort ? { effort: reasoning.effort } : {}),
      },
      ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
      // No `tools`. The pages are untrusted input; a model that could fetch a
      // URL found in a document would turn an upload into a server-side
      // request forgery.
      // No `temperature` or `top_p` either — Sonnet 5 and Opus 5 reject them.
    }

    /*
     * Streamed, and not as a preference.
     *
     * The SDK refuses outright to send a non-streaming request whose expected
     * duration — estimated from max_tokens — exceeds ten minutes: "Streaming is
     * required for operations that may take longer than 10 minutes". Raising the
     * extraction ceiling to 32 000 crossed that line, and the step failed in
     * five seconds without a single token being generated.
     *
     * Streaming is the right posture here anyway. Every call this class makes is
     * a large structured answer over a chapter's worth of material, which is
     * exactly the shape that runs into request timeouts. `finalMessage()` gives
     * the same object `parse()` would have returned, `parsed_output` included —
     * the incremental events are of no use to a batch pipeline, only the
     * connection staying alive is.
     */
    /*
     * Chien de garde d'inactivité, réarmé à chaque événement du flux.
     *
     * `abort()` fait rejeter `finalMessage()`, ce qui transforme une
     * connexion morte — qui pendait indéfiniment — en une erreur que la
     * boucle de tranches sait déjà retenter. Le SDK ne retente pas un abort
     * lui-même, et c'est voulu : le retry appartient à l'étape, qui sait ce
     * qu'une tranche vaut.
     */
    const stream = this.client.messages.stream(params)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const rearm = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => stream.abort(), STREAM_IDLE_MS)
    }
    rearm()
    stream.on('streamEvent', rearm)

    let message: Awaited<ReturnType<typeof this.client.messages.parse<typeof params>>>
    try {
      message = await stream.finalMessage()
    } catch (error: unknown) {
      if (stream.aborted) {
        throw new Error(
          `Flux inactif : aucun événement de ${model} depuis ${STREAM_IDLE_MS / 1000} s. ` +
            'La connexion est probablement morte ; l’appel est abandonné pour être retenté.',
        )
      }
      /*
       * The SDK parses the accumulated JSON inside finalMessage(), so a
       * truncated answer arrives here as a parse error and never reaches the
       * stop_reason check below. Which truncation it was matters, and the
       * position in the message is what says so: a JSON that stops after a few
       * thousand characters ran out of connection, not out of budget — 32 000
       * tokens is an order of magnitude more text than that. Saying so turns
       * "Unterminated string at position 2501" from a mystery into a diagnosis.
       */
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Réponse illisible de ${model} (plafond ${options.maxTokens} tokens) : ${detail}` +
          ' · Un JSON coupé après quelques milliers de caractères vient d’un flux' +
          ' interrompu, pas du plafond.',
      )
    } finally {
      clearTimeout(idleTimer)
    }
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
      /*
       * `max_tokens` is not a malformed answer, it is a complete answer that was
       * cut off, and saying "réponse non conforme au schéma" about it sends the
       * search to the schema — where there is nothing wrong. It means the work
       * handed to this call was too big for one reply, so the fix is upstream:
       * fewer panels per call, not a looser schema.
       */
      if (message.stop_reason === 'max_tokens') {
        throw new Error(
          `La réponse a atteint le plafond de ${options.maxTokens} tokens et s'est arrêtée en ` +
            'cours de JSON. Il y a trop de matière dans un seul appel : réduisez la tranche.',
        )
      }
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
  if (r.descriptions) parts.push(panelDescriptionList(r.descriptions))
  if (r.question) parts.push(r.question)

  return {
    system: extractionSystem(r.ontology ?? '', r.source ?? 'summary'),
    text: parts.join('\n\n') || 'estimation',
    images,
    // Output is bounded by the schemas' array limits; this is the observed
    // middle of that range rather than the ceiling.
    expectedOutput: images > 0 ? images * 400 : 3_000,
  }
}
