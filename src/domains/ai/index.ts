import 'server-only'
import { effectiveModelProvider } from '@/lib/env.ts'
import { AnthropicProvider } from './anthropic.ts'
import type { ModelProvider } from './provider.ts'
import { ReplayProvider } from './replay.ts'
import { SyntheticProvider } from './synthetic.ts'

export * from './provider.ts'
export * from './schemas.ts'
export * from './anchoring.ts'
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

  switch (effectiveModelProvider()) {
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) throw new Error('ANTHROPIC_API_KEY manquante.')
      cached = new AnthropicProvider(key)
      return cached
    }

    case 'replay': {
      // With a key present and RECORD=1, unknown requests go to the real API and
      // the answer is written down. Without it, a missing recording is a loud
      // failure — see ReplayProvider.
      const key = process.env.ANTHROPIC_API_KEY
      const recording = process.env.RECORD === '1' && key !== undefined
      cached = new ReplayProvider(
        recording ? { recorder: new AnthropicProvider(key) } : {},
      )
      return cached
    }

    case 'synthetic': {
      cached = new SyntheticProvider()
      return cached
    }
  }
}

export function resetModelProvider(): void {
  cached = null
}
