import { afterEach, describe, expect, it } from 'vitest'
import { localModelConfig } from '@/domains/ai/openai-compatible.ts'
import { localTiers, ROUTED_TIERS, TIER_OF } from '@/domains/ai/routing.ts'

/**
 * Routing is configuration, and configuration is where this project has lost
 * every one of its evenings. These cover the two failures that would be silent:
 * a typo in LOCAL_AI_TIERS quietly sending everything to the paid provider, and
 * a half-written endpoint being treated as configured.
 */
const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
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
  it('takes every tier when none is named', () => {
    setEnv({ LOCAL_AI_TIERS: undefined })
    expect(localTiers()).toEqual(new Set(ROUTED_TIERS))
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
