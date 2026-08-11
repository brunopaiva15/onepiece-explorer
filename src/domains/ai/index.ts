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

let cached: ModelProvider | null = null

/**
 * The provider this process should use.
 *
 * `effectiveModelProvider()` already downgrades `anthropic` to `synthetic` when
 * no key is present, so a missing key degrades the product rather than breaking
 * it — and the interface says which mode it is in, because extraction shown in
 * synthetic mode is derived from the text rather than from a reading of the
 * pages, and presenting it otherwise would be a lie in the one place this
 * product cannot afford one.
 */
export function modelProvider(): ModelProvider {
  if (cached) return cached

  /*
   * A self-hosted endpoint takes precedence, for the tiers it was given.
   *
   * Configuring one is the decision to use it; LOCAL_AI_TIERS narrows that to a
   * subset when you want to move one step at a time. Whatever is not routed
   * locally falls through to the provider below, which is why this cannot make
   * the product depend on a machine being up: name no tiers and nothing
   * changes, name some and only those need the endpoint.
   */
  const local = localModelConfig()
  if (local) {
    const localProvider = new OpenAICompatibleProvider(local)
    const routed = localTiers()
    const fallback = baseProvider()

    cached = new RoutingProvider(
      Object.fromEntries(
        ROUTED_TIERS.map((tier) => [tier, routed.has(tier) ? localProvider : fallback]),
      ) as Record<RoutedTier, ModelProvider>,
      // Named for what does the bulk: the description tier is most of the work
      // and most of the spend, so it is the honest label for a run.
      routed.has('describe') ? 'local' : fallback.name,
    )
    return cached
  }

  cached = baseProvider()
  return cached
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
  cached = null
}
