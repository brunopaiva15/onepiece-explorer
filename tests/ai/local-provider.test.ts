import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentProvider } from '@/domains/ai/claude-agent/provider.ts'
import { localModelConfig, OpenAICompatibleProvider } from '@/domains/ai/openai-compatible.ts'
import {
  isProviderChoice,
  modelProvider,
  providerOptions,
  resetModelProvider,
} from '@/domains/ai/index.ts'
import { defaultLocalTiers, localTiers, ROUTED_TIERS, TIER_OF } from '@/domains/ai/routing.ts'
import { syntheticByFallback } from '@/lib/env.ts'

/**
 * Routing is configuration, and configuration is where this project has lost
 * every one of its evenings. These cover the two failures that would be silent:
 * a typo in LOCAL_AI_TIERS quietly sending everything to the paid provider, and
 * a half-written endpoint being treated as configured.
 */
const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
  vi.restoreAllMocks()
})

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('localModelConfig', () => {
  it('needs both the URL and the model to count as configured', () => {
    setEnv({ LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1', LOCAL_AI_MODEL: undefined })
    expect(localModelConfig()).toBeNull()

    setEnv({ LOCAL_AI_BASE_URL: undefined, LOCAL_AI_MODEL: 'qwen-hermes' })
    expect(localModelConfig()).toBeNull()
  })

  it('trims the trailing slash so paths do not double up', () => {
    setEnv({ LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1/', LOCAL_AI_MODEL: 'qwen-hermes' })
    expect(localModelConfig()?.baseUrl).toBe('http://127.0.0.1:1234/v1')
  })

  it('defaults reasoning to none', () => {
    setEnv({
      LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_AI_MODEL: 'qwen-hermes',
      LOCAL_AI_REASONING_EFFORT: undefined,
    })
    expect(localModelConfig()?.reasoningEffort).toBe('none')
  })
})

describe('localTiers', () => {
  it('leaves extraction to the hosted provider when no tier is named', () => {
    // The default this project settled on: a smaller model takes the bulk —
    // describing panels, a hundred times a chapter — and extraction stays on
    // Claude Max, because a weaker model there finds less rather than finding
    // something wrong, and a thin graph looks exactly like a thin chapter.
    setEnv({ LOCAL_AI_TIERS: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test' })
    expect([...localTiers()].sort()).toEqual(['classify', 'describe', 'embed', 'escalate'])
    expect(localTiers().has('extract')).toBe(false)
  })

  it('still takes extraction back when it is named', () => {
    setEnv({ LOCAL_AI_TIERS: 'describe,extract', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test' })
    expect(localTiers().has('extract')).toBe(true)
  })

  it('keeps every tier local when there is no hosted provider to hand extraction to', () => {
    // Without a subscription or a key the fallback is the synthetic provider.
    // Moving extraction there would replace an answer read from the pages with
    // a fabricated one — the one outcome this pipeline must not have.
    setEnv({
      LOCAL_AI_TIERS: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      MODEL_PROVIDER: undefined,
    })
    expect(localTiers()).toEqual(new Set(ROUTED_TIERS))
    expect(defaultLocalTiers()).toEqual(ROUTED_TIERS)
  })

  it('takes only what is named', () => {
    setEnv({ LOCAL_AI_TIERS: 'describe, embed' })
    expect([...localTiers()].sort()).toEqual(['describe', 'embed'])
  })

  it('refuses a typo instead of silently dropping it', () => {
    // A misspelt tier that fell through would send that step to the paid
    // provider, and the discovery would be a bill.
    setEnv({ LOCAL_AI_TIERS: 'describe,extraction' })
    expect(() => localTiers()).toThrow(/extraction/)
  })
})

describe('the routing table', () => {
  it('gives every provider method a tier', () => {
    const methods = [
      'transcribe',
      'describePanels',
      'extract',
      'resolve',
      'summarize',
      'answer',
      'embed',
    ] as const

    for (const method of methods) {
      expect(ROUTED_TIERS).toContain(TIER_OF[method])
    }
  })

  it('keeps identity resolution on the escalation tier', () => {
    // Identity is where a wrong answer costs most and is the rarest call, so it
    // must not follow the bulk onto whatever cheap model is serving describe.
    expect(TIER_OF.resolve).toBe('escalate')
    expect(TIER_OF.describePanels).toBe('describe')
  })
})

describe('choosing a provider per run', () => {
  it('only offers what is configured, and says why when it is not', () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })
    const none = providerOptions()
    expect(none.find((o) => o.id === 'anthropic')?.available).toBe(false)
    expect(none.find((o) => o.id === 'local')?.available).toBe(false)
    // Unconfigured options are listed rather than hidden: a missing variable
    // named on screen is actionable, an option that vanished is not.
    expect(none.find((o) => o.id === 'local')?.note).toContain('LOCAL_AI_BASE_URL')

    setEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_AI_MODEL: 'qwen-hermes',
    })
    const both = providerOptions()
    expect(both.filter((o) => o.available).map((o) => o.id).sort()).toEqual([
      'anthropic',
      'auto',
      'local',
    ])
    expect(both.find((o) => o.id === 'local')?.note).toContain('qwen-hermes')
  })

  it('rejects anything that is not a choice', () => {
    // These arrive from a browser through a server action and are written to
    // the run, where they are read back as a model choice.
    expect(isProviderChoice('auto')).toBe(true)
    expect(isProviderChoice('local')).toBe(true)
    expect(isProviderChoice('anthropic')).toBe(true)
    for (const value of ['openai', '', null, undefined, 42, { id: 'local' }]) {
      expect(isProviderChoice(value)).toBe(false)
    }
  })

  it('builds a different provider per choice, and caches each separately', () => {
    setEnv({
      ANTHROPIC_API_KEY: 'sk-test',
      LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_AI_MODEL: 'qwen-hermes',
      MODEL_PROVIDER: 'anthropic',
    })
    resetModelProvider()

    // The failure this guards: one cached singleton, so a chapter processed
    // with Anthropic would decide for the next one launched on the local model.
    expect(modelProvider('local').name).toBe('local')
    expect(modelProvider('anthropic').name).toBe('anthropic')
    expect(modelProvider('local')).toBe(modelProvider('local'))
    expect(modelProvider('anthropic')).not.toBe(modelProvider('local'))
  })

  it('routes extraction to Claude Max and the bulk to the local model', async () => {
    // The default split, end to end: 'auto' with an endpoint configured and no
    // LOCAL_AI_TIERS must not send extraction to the self-hosted model just
    // because describing panels goes there.
    setEnv({
      LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_AI_MODEL: 'qwen-hermes',
      LOCAL_AI_TIERS: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test',
      ANTHROPIC_API_KEY: undefined,
      MODEL_PROVIDER: undefined,
    })
    resetModelProvider()

    const onLocal = vi.spyOn(OpenAICompatibleProvider.prototype, 'estimate')
    const onMax = vi.spyOn(ClaudeAgentProvider.prototype, 'estimate')

    const provider = modelProvider('auto')
    await provider.estimate('extract', {})
    expect(onMax).toHaveBeenCalledTimes(1)
    expect(onLocal).not.toHaveBeenCalled()

    await provider.estimate('describe', {})
    expect(onLocal).toHaveBeenCalledTimes(1)

    // Still reported as the local model: description is most of the work and
    // most of the calls, so it stays the honest label for a run.
    expect(provider.name).toBe('local')
  })

  it('says on the launch screen which step leaves the local model', () => {
    setEnv({
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test',
      LOCAL_AI_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_AI_MODEL: 'qwen-hermes',
      LOCAL_AI_TIERS: undefined,
      MODEL_PROVIDER: undefined,
    })
    const note = providerOptions().find((o) => o.id === 'auto')?.note ?? ''
    expect(note).toContain('extract')
    expect(note).toContain('Claude Max')
  })

  it('refuses a local run on a machine that cannot reach the model', () => {
    // The worker runs where the weights are. Asking for the local model from a
    // machine without the endpoint has to say that, not fall back silently to
    // the paid provider.
    setEnv({ LOCAL_AI_BASE_URL: undefined, LOCAL_AI_MODEL: undefined })
    resetModelProvider()
    expect(() => modelProvider('local')).toThrow(/LOCAL_AI_BASE_URL/)
  })
})

/**
 * The failure this whole file exists for, in its most expensive form: a run
 * that succeeds in four hundred milliseconds, spends no token, extracts
 * nothing, and says « aucune proposition ». Two ways in, both closed here.
 */
describe('a run that would be answered by nobody', () => {
  it('counts a MODEL_PROVIDER whose credential is gone as a fallback, not a choice', () => {
    // The real one: MODEL_PROVIDER left over from before the migration to the
    // subscription, ANTHROPIC_API_KEY since removed. The variable is set, so
    // this used to read as "synthetic was asked for" and let the run through.
    setEnv({
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test',
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })
    expect(syntheticByFallback()).toBe(true)
  })

  it('leaves an explicitly synthetic deployment alone', () => {
    // Asked for, it is an honest choice: the interface says the extraction is
    // generated, and the walkthrough runs without a key.
    setEnv({
      MODEL_PROVIDER: 'synthetic',
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })
    expect(syntheticByFallback()).toBe(false)
  })

  it('names the missing credential on the launch screen instead of promising Claude Max', () => {
    // The screen and the run disagreed for hours: a subscription token was
    // present, so the note said Claude Max, while MODEL_PROVIDER sent every
    // call to the synthetic provider.
    setEnv({
      MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test',
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })
    const note = providerOptions().find((o) => o.id === 'auto')?.note ?? ''
    expect(note).toContain('MODEL_PROVIDER=anthropic')
    expect(note).toContain('ANTHROPIC_API_KEY')
    expect(note).not.toContain('Claude Max, via le Claude Agent SDK')
  })
})
