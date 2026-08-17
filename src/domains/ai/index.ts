import 'server-only'
import { hasClaudeSubscription, remoteModelProvider } from '@/lib/env.ts'
import { AnthropicProvider } from './anthropic.ts'
import { ClaudeAgentProvider } from './claude-agent/provider.ts'
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
export type ProviderChoice = 'auto' | 'claude-max' | 'anthropic' | 'local'

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
  const hasSubscription = hasClaudeSubscription()
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)
  const tiers = process.env.LOCAL_AI_TIERS?.trim()

  const fallbackNote = hasSubscription
    ? 'Claude Max'
    : hasAnthropic
      ? 'Anthropic'
      : 'extraction synthétique'

  return [
    {
      id: 'auto',
      label: 'Par défaut',
      note: local
        ? tiers
          ? `Mon modèle pour : ${tiers}. ${fallbackNote} pour le reste.`
          : 'Mon modèle pour tout.'
        : hasSubscription
          ? 'Claude Max, via le Claude Agent SDK.'
          : hasAnthropic
            ? 'Anthropic.'
            : 'Aucun fournisseur configuré : extraction synthétique.',
      available: true,
    },
    {
      id: 'claude-max',
      label: 'Claude Max',
      note: hasSubscription
        ? 'Inclus dans l’abonnement, aucun token facturé. Quota atteint : le traitement échoue, sans bascule payante.'
        : 'CLAUDE_CODE_OAUTH_TOKEN absente — générez-la avec `claude setup-token`.',
      available: hasSubscription,
    },
    {
      id: 'anthropic',
      label: 'Anthropic (API facturée)',
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
  return (
    value === 'auto' ||
    value === 'claude-max' ||
    value === 'anthropic' ||
    value === 'local'
  )
}

const cached = new Map<ProviderChoice, ModelProvider>()

/**
 * The provider for a given choice.
 *
 * Cached per choice rather than globally: a process that handles one chapter
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
  if (choice === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error(
        "Traitement demandé sur l'API Anthropic facturée, mais ANTHROPIC_API_KEY " +
          "n'est pas configurée. Le traitement par défaut passe par l'abonnement " +
          'Claude Max ; il n’y a rien à faire ici si c’est ce que vous vouliez.',
      )
    }
    return new AnthropicProvider(key)
  }

  if (choice === 'claude-max') {
    /*
     * Explicit, so it fails rather than degrades.
     *
     * `remoteModelProvider()` turns a missing token into the synthetic provider,
     * which is right for a deployment that was never configured and wrong for a
     * run someone launched on Claude Max on purpose: silently extracting
     * fabricated data under a label that says Claude Max is the one outcome
     * this must not have.
     */
    if (!hasClaudeSubscription()) {
      throw new Error(
        'Traitement demandé sur Claude Max, mais CLAUDE_CODE_OAUTH_TOKEN est absente. ' +
          'Générez un jeton avec `claude setup-token`, puis renseignez-le dans .env.local ' +
          'ou dans les variables du projet chez votre hébergeur.',
      )
    }
    return new ClaudeAgentProvider()
  }

  const local = localModelConfig()

  if (choice === 'local') {
    if (!local) {
      throw new Error(
        'Traitement demandé sur le modèle auto-hébergé, mais LOCAL_AI_BASE_URL et ' +
          "LOCAL_AI_MODEL ne sont pas configurés sur cette machine. Le pipeline n'a " +
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
    case 'claude-max': {
      return new ClaudeAgentProvider()
    }

    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY manquante.')
      return new AnthropicProvider(key)
    }

    case 'replay': {
      /*
       * With credentials present and RECORD=1, unknown requests go to a real
       * model and the answer is written down. Without them, a missing recording
       * is a loud failure — see ReplayProvider.
       *
       * The subscription is preferred for recording too: refreshing a cassette
       * is exactly the kind of occasional, deliberate, one-person job the Max
       * allowance is there for, and there is no reason for it to reach for a
       * metered key when a paid-for one is configured.
       */
      const key = process.env.ANTHROPIC_API_KEY
      const recorder = !(process.env.RECORD === '1')
        ? null
        : hasClaudeSubscription()
          ? new ClaudeAgentProvider()
          : key !== undefined
            ? new AnthropicProvider(key)
            : null
      return new ReplayProvider(recorder ? { recorder } : {})
    }

    case 'synthetic': {
      return new SyntheticProvider()
    }
  }
}

export function resetModelProvider(): void {
  cached.clear()
}
