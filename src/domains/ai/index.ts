import 'server-only'
import { remoteModelProvider } from '@/lib/env.ts'
import { AnthropicProvider } from './anthropic.ts'
import { localModelConfig, OpenAICompatibleProvider } from './openai-compatible.ts'
import type { ModelProvider } from './provider.ts'
import { ReplayProvider } from './replay.ts'
import { localTiers, ROUTED_TIERS, RoutingProvider, type RoutedTier } from './routing.ts'
import { SyntheticProvider } from './synthetic.ts'

export * from './provider.ts'
export * from './schemas.ts'
export * from './anchoring.ts'
export { localModelConfig } from './openai-compatible.ts'
export { localTiers, ROUTED_TIERS, type RoutedTier } from './routing.ts'
export { PROMPT_VERSION } from './prompts.ts'

/**
 * Which model answers, when the caller has an opinion.
 *
 * 'auto' is the configured default — the routing table, honouring
 * LOCAL_AI_TIERS. The other two are explicit overrides, and they exist because
 * the interesting question about a self-hosted model is not "is it good" but
 * "is it good enough at *this* step", and the only way to answer that is to run
 * the same chapter both ways and compare. A setting in a file cannot do that;
 * a choice attached to a run can.
 */
export type ProviderChoice = 'auto' | 'anthropic' | 'local'

export interface ProviderOption {
  id: ProviderChoice
  label: string
  /** Why you would pick it — shown next to the choice, not buried in docs. */
  note: string
  available: boolean
}

/**
 * The choices worth offering, and whether each is configured.
 *
 * Unconfigured options are returned rather than hidden: "Mon modèle
 * (LOCAL_AI_BASE_URL absent)" tells you what to do, and an option that silently
 * disappears tells you nothing.
 */
export function providerOptions(): ProviderOption[] {
  const local = localModelConfig()
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)
  const tiers = process.env.LOCAL_AI_TIERS?.trim()

  return [
    {
      id: 'auto',
      label: 'Par défaut',
      note: local
        ? tiers
          ? `Mon modèle pour : ${tiers}. Anthropic pour le reste.`
          : 'Mon modèle pour tout.'
        : hasAnthropic
          ? 'Anthropic.'
          : 'Aucun fournisseur configuré : extraction synthétique.',
      available: true,
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      note: hasAnthropic
        ? 'Facturé au token. Haiku pour les descriptions, Sonnet pour l’extraction.'
        : 'ANTHROPIC_API_KEY absente.',
      available: hasAnthropic,
    },
    {
      id: 'local',
      label: 'Mon modèle',
      note: local
        ? `${local.model}, auto-hébergé. Aucun coût facturé.`
        : 'LOCAL_AI_BASE_URL et LOCAL_AI_MODEL absents.',
      available: Boolean(local),
    },
  ]
}

export function isProviderChoice(value: unknown): value is ProviderChoice {
  return value === 'auto' || value === 'anthropic' || value === 'local'
}

const cached = new Map<ProviderChoice, ModelProvider>()

/**
 * The provider for a given choice.
 *
 * Cached per choice rather than globally: a worker that processes one chapter
 * with Anthropic and the next with the local model must not have the first
 * decide for the second.
 */
export function modelProvider(choice: ProviderChoice = 'auto'): ModelProvider {
  const existing = cached.get(choice)
  if (existing) return existing

  const built = build(choice)
  cached.set(choice, built)
  return built
}

function build(choice: ProviderChoice): ModelProvider {
  if (choice === 'anthropic') return baseProvider()

  const local = localModelConfig()

  if (choice === 'local') {
    if (!local) {
      throw new Error(
        'Traitement demandé sur le modèle auto-hébergé, mais LOCAL_AI_BASE_URL et ' +
          "LOCAL_AI_MODEL ne sont pas configurés sur cette machine. Le worker n'a " +
          'pas accès à ce modèle.',
      )
    }
    return new OpenAICompatibleProvider(local)
  }

  /*
   * 'auto': the routing table.
   *
   * A self-hosted endpoint takes the tiers it was given; whatever is not routed
   * locally falls through. Naming no tiers means all of them — configuring an
   * endpoint at all is the decision to use it.
   */
  if (local) {
    const localProvider = new OpenAICompatibleProvider(local)
    const routed = localTiers()
    const fallback = baseProvider()

    return new RoutingProvider(
      Object.fromEntries(
        ROUTED_TIERS.map((tier) => [tier, routed.has(tier) ? localProvider : fallback]),
      ) as Record<RoutedTier, ModelProvider>,
      // Named for what does the bulk: description is most of the work and most
      // of the spend, so it is the honest label for a run.
      routed.has('describe') ? 'local' : fallback.name,
    )
  }

  return baseProvider()
}

function baseProvider(): ModelProvider {
  switch (remoteModelProvider()) {
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY manquante.')
      return new AnthropicProvider(key)
    }

    case 'replay': {
      // With a key present and RECORD=1, unknown requests go to the real API and
      // the answer is written down. Without it, a missing recording is a loud
      // failure — see ReplayProvider.
      const key = process.env.ANTHROPIC_API_KEY
      const recording = process.env.RECORD === '1' && key !== undefined
      return new ReplayProvider(recording ? { recorder: new AnthropicProvider(key) } : {})
    }

    case 'synthetic': {
      return new SyntheticProvider()
    }
  }
}

export function resetModelProvider(): void {
  cached.clear()
}
