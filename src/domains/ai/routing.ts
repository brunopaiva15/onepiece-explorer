import 'server-only'
import type {
  AnswerRequest,
  ArbitrateRequest,
  DescribeRequest,
  EmbedRequest,
  ExtractRequest,
  ModelProvider,
  ModelTier,
  ProviderResult,
  ResolveRequest,
  SummarizeRequest,
  TranscribeRequest,
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
 * Different models for different steps, chosen per tier.
 *
 * The pipeline's steps do not need the same thing. Describing a panel is "say
 * what is drawn, no names, no inference", a hundred times per chapter with an
 * image each — bulk, undemanding, and most of the bill. Extraction reads those
 * descriptions against an ontology of forty-seven predicates and anchors every
 * claim to a real panel. Identity resolution is where a wrong answer costs the
 * most and is the rarest call.
 *
 * Until now one provider served all of them, so a self-hosted model was an
 * all-or-nothing switch. This makes the choice per tier, which is what allows a
 * local model to take the bulk while a stronger one keeps the judgement — and,
 * more importantly, allows that split to be *measured* rather than argued
 * about: same chapter, one tier moved, compare the quarantine counts.
 *
 * Every method delegates. There is no logic here beyond the routing table,
 * deliberately: anchoring, clamping and the boundary all live downstream of any
 * provider, so nothing about which model answered can loosen them.
 */

/** Tiers, plus the one that is not a chat call. */
export type RoutedTier = ModelTier | 'embed'

export const ROUTED_TIERS: readonly RoutedTier[] = [
  'classify',
  'describe',
  'extract',
  'escalate',
  'embed',
]

/**
 * Which tier each method belongs to.
 *
 * Mirrors the tiers the Anthropic provider selects internally. Kept as data so
 * the two cannot drift apart silently: a method added to the interface without
 * a tier here will not compile.
 */
export const TIER_OF: Record<
  | 'transcribe'
  | 'describePanels'
  | 'extract'
  | 'resolve'
  | 'summarize'
  | 'answer'
  | 'arbitrate'
  | 'embed',
  RoutedTier
> = {
  transcribe: 'extract',
  describePanels: 'describe',
  extract: 'extract',
  // Identity is where a wrong answer costs most, so it escalates by default.
  resolve: 'escalate',
  summarize: 'extract',
  answer: 'extract',
  // See `ModelProvider.arbitrate`: the extraction tier, for wall-clock as much
  // as for money.
  arbitrate: 'extract',
  embed: 'embed',
}

export class RoutingProvider implements ModelProvider {
  readonly name: ModelProvider['name']

  constructor(
    private readonly routes: Record<RoutedTier, ModelProvider>,
    /** Reported as this provider's identity — the one doing the bulk. */
    name: ModelProvider['name'],
  ) {
    this.name = name
  }

  private for(method: keyof typeof TIER_OF): ModelProvider {
    return this.routes[TIER_OF[method]]
  }

  estimate(tier: ModelTier, request: unknown): Promise<{ inputTokens: number; costCents: number }> {
    return this.routes[tier].estimate(tier, request)
  }

  transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>> {
    return this.for('transcribe').transcribe(request)
  }

  describePanels(request: DescribeRequest): Promise<ProviderResult<PanelDescription[]>> {
    return this.for('describePanels').describePanels(request)
  }

  extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    return this.for('extract').extract(request)
  }

  resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    return this.for('resolve').resolve(request)
  }

  summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>> {
    return this.for('summarize').summarize(request)
  }

  answer(request: AnswerRequest): Promise<ProviderResult<Answer>> {
    return this.for('answer').answer(request)
  }

  arbitrate(request: ArbitrateRequest): Promise<ProviderResult<Arbitration>> {
    return this.for('arbitrate').arbitrate(request)
  }

  embed(request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    return this.for('embed').embed(request)
  }
}

/**
 * Which tiers go to the self-hosted model.
 *
 * Absent means all of them: configuring a local endpoint at all is the decision
 * to use it. Naming a subset — `LOCAL_AI_TIERS=describe` — is how you move one
 * step at a time and compare, which is the only honest way to find out whether
 * a smaller model is good enough at a given job.
 *
 * An unknown name is an error rather than a silent omission: a typo that
 * quietly sent everything to the paid provider would be discovered on a bill.
 */
export function localTiers(): Set<RoutedTier> {
  const raw = process.env.LOCAL_AI_TIERS?.trim()
  if (!raw) return new Set(ROUTED_TIERS)

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  const unknown = names.filter((name) => !ROUTED_TIERS.includes(name as RoutedTier))
  if (unknown.length > 0) {
    throw new Error(
      `LOCAL_AI_TIERS : palier(s) inconnu(s) « ${unknown.join(', ')} ». ` +
        `Valeurs acceptées : ${ROUTED_TIERS.join(', ')}.`,
    )
  }

  return new Set(names as RoutedTier[])
}
