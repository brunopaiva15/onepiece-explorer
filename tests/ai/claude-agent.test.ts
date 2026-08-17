import { afterEach, describe, expect, it } from 'vitest'
import { agentPayload } from '@/domains/ai/claude-agent/payload.ts'
import {
  agentEnv,
  agentFailure,
  agentRuntime,
  ClaudeAgentError,
  interpret,
  isAuthFailure,
  stderrTail,
  type AgentRequest,
  type RawAgentResult,
} from '@/domains/ai/claude-agent/runtime.ts'
import { ClaudeAgentProvider } from '@/domains/ai/claude-agent/provider.ts'
import { isProviderChoice, modelProvider, providerOptions, resetModelProvider } from '@/domains/ai/index.ts'
import { hasClaudeSubscription, remoteModelProvider } from '@/lib/env.ts'

/**
 * What is worth testing about running Claude on a subscription instead of a
 * metered key is not that it answers — that needs a real token and real money,
 * and the recorded cassettes already cover what the pipeline does with an
 * answer. It is the three things that would fail *silently*:
 *
 *   the request quietly asking something other than what the prompts say,
 *   a spent allowance quietly becoming a bill,
 *   the token quietly reaching somewhere it should not.
 *
 * Everything below is one of those three.
 */

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
  resetModelProvider()
})

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const REQUEST: AgentRequest = {
  label: 'test',
  system: 'Vous êtes un extracteur.',
  content: [{ type: 'text', text: 'Chapitre 3.' }],
  model: 'claude-sonnet-5',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
}

function result(overrides: Partial<RawAgentResult> = {}): RawAgentResult {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    structured_output: { ok: true },
    usage: { input_tokens: 10, output_tokens: 4 },
    ...overrides,
  }
}

describe('the request Claude is given', () => {
  it('carries the project’s own system prompt, not an agent preset', () => {
    const { options } = agentPayload(REQUEST)
    // A string means "replace"; an object with `preset` would mean the coding
    // agent's prompt with ours appended — a second voice in the anti-spoiler
    // rules.
    expect(options.systemPrompt).toBe('Vous êtes un extracteur.')
    expect(typeof options.systemPrompt).toBe('string')
  })

  it('gives the model no tools and no MCP servers', () => {
    // The pages are an untrusted document. A model that could follow a URL
    // found in one would turn an upload into a server-side request forgery.
    const { options } = agentPayload(REQUEST)
    expect(options.tools).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.maxTurns).toBe(1)
  })

  it('reads no settings from disk, so this repository’s own CLAUDE.md cannot leak in', () => {
    /*
     * The SDK loads every settings source when this is omitted — user settings,
     * project settings, and CLAUDE.md / AGENTS.md from the working directory.
     * Instructions written for whoever edits this codebase have no business in
     * the context of a model being asked what happens in chapter 47.
     */
    expect(agentPayload(REQUEST).options.settingSources).toEqual([])
  })

  it('constrains the answer with a schema rather than hoping for JSON', () => {
    const { options } = agentPayload(REQUEST)
    expect(options.outputFormat.type).toBe('json_schema')
    expect(options.outputFormat.schema).toBe(REQUEST.schema)
  })

  it('passes the reasoning posture through untouched', () => {
    const bounded = agentPayload({ ...REQUEST, thinking: 'disabled', effort: 'medium' })
    expect(bounded.options.thinking).toEqual({ type: 'disabled' })
    expect(bounded.options.effort).toBe('medium')

    // Absent rather than defaulted: a tier with no opinion must send the
    // request it would have sent before any of this existed.
    const adaptive = agentPayload(REQUEST)
    expect(adaptive.options.thinking).toBeUndefined()
    expect(adaptive.options.effort).toBeUndefined()
  })

  it('sends images as content blocks', () => {
    const { message } = agentPayload({
      ...REQUEST,
      content: [
        { type: 'text', text: 'Image suivante : p1c1' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
        },
      ],
    })
    expect(message.role).toBe('user')
    expect(message.content).toHaveLength(2)
    expect(message.content[1]).toMatchObject({ type: 'image' })
  })
})

describe('the environment Claude runs in', () => {
  it('strips every variable that could put the call on a metered bill', () => {
    setEnv({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'nope',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PATH: '/usr/bin',
    })

    const env = agentEnv('oat-token', '/tmp/home')

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    // Still a usable environment: the child needs a PATH to find a runtime.
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-token')
    expect(env.HOME).toBe('/tmp/home')
  })

  it('runs inline off a deployment and in a sandbox on one', () => {
    setEnv({ CLAUDE_AGENT_RUNTIME: undefined, VERCEL: undefined, NODE_ENV: 'test' })
    expect(agentRuntime()).toBe('inline')

    setEnv({ VERCEL: '1', NODE_ENV: 'production' })
    expect(agentRuntime()).toBe('sandbox')

    // An explicit choice wins over the host, which is how the unused one gets
    // exercised before somebody needs it.
    setEnv({ CLAUDE_AGENT_RUNTIME: 'inline' })
    expect(agentRuntime()).toBe('inline')
  })
})

describe('a token Claude refuses', () => {
  /*
   * Measured against a real CLI, which is why this exists at all: an invalid
   * token comes back as a 401, the CLI retries a 401 ten times with backoff
   * like any transient error, and the call does not fail — it hangs until the
   * timeout fires and reports a timeout. Someone reading that goes and looks at
   * the network, at Claude's status page, at CLAUDE_AGENT_TIMEOUT_MS: at
   * everything except the variable that is wrong.
   */
  it('is recognised while it is still being retried', () => {
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 401 }),
    ).toBe(true)
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 403 }),
    ).toBe(true)
  })

  it('does not swallow the retries that backoff actually fixes', () => {
    // 429 and 5xx are what the retry loop is for; cutting those short would
    // turn a hiccup into a failed chapter.
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 429 }),
    ).toBe(false)
    expect(
      isAuthFailure({ type: 'system', subtype: 'api_retry', error_status: 529 }),
    ).toBe(false)
    expect(isAuthFailure({ type: 'assistant' })).toBe(false)
  })

  /*
   * Et l'autre moitié : celle que le flux ne voit pas.
   *
   * `api_retry` suppose un CLI démarré, qui parle à l'API et se fait renvoyer.
   * Un jeton que le CLI rejette au démarrage ne produit aucun message : il sort
   * en code 1, le SDK lève « Claude Code process exited with code 1 », et
   * jusqu'ici les deux dorsales passaient `stderr: () => {}` — la seule phrase
   * qui disait pourquoi était jetée avant d'être lue. Ce qui remontait à
   * l'utilisateur était un code de sortie et une invitation à deviner.
   */
  it('is recognised from what the CLI said before dying', () => {
    const failure = agentFailure(
      'assistant',
      'Claude Code process exited with code 1',
      'Invalid API key · Please run /login',
    )

    expect(failure.kind).toBe('auth')
    expect(failure.message).toContain('claude setup-token')
  })

  it('does not read a revoked token into an ordinary crash', () => {
    // Diagnostiquer un jeton révoqué à tort envoie régénérer une clé valable
    // et cherche la panne partout sauf où elle est.
    const failure = agentFailure(
      'assistant',
      'Claude Code process exited with code 1',
      'Error: Cannot find module @anthropic-ai/claude-agent-sdk/cli.js',
    )

    expect(failure.kind).toBe('sdk')
    expect(failure.message).toContain('Cannot find module')
  })

  it('keeps a spent allowance an allowance, wherever it is said', () => {
    const failure = agentFailure('extraction', 'exited with code 1', "You've hit your usage limit")

    expect(failure.kind).toBe('quota')
    expect(failure.message).toContain('Quota Claude Max atteint')
  })

  it('never writes the token into the message it hands back', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret' })

    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'spawn failed: node cli.js --token sk-ant-oat-secret',
    )

    // Ce message finit dans une interface, un journal, et probablement un
    // rapport de bogue.
    expect(failure.message).not.toContain('sk-ant-oat-secret')
    expect(failure.message).toContain('***')
  })

  it('does not read a rejection into a trace that merely names the variable', () => {
    // « CLAUDE_CODE_OAUTH_TOKEN » se lit dans un environnement déballé, dans une
    // aide, dans une ligne de commande : partout sauf dans un refus.
    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'env: CLAUDE_CODE_OAUTH_TOKEN=… HOME=/vercel/sandbox\nEACCES: permission denied',
    )

    expect(failure.kind).toBe('sdk')
  })

  it('says so plainly when the CLI said nothing at all', () => {
    const failure = agentFailure('extraction', 'exited with code 1', '')

    expect(failure.kind).toBe('sdk')
    expect(failure.message).toContain('CLAUDE_AGENT_RUNTIME=inline')
  })

  /*
   * Le silence n'est pas un verdict.
   *
   * Le SDK colle lui-même la fin de la sortie d'erreur au message « exited with
   * code N » : un message qui s'arrête au code dit donc que le processus n'a
   * rien écrit du tout, et un CLI qui refuse de démarrer, lui, explique
   * pourquoi. Ce qui reste — une machine reprise sous le processus, une durée de
   * vie atteinte — ne se reproduit pas sur un processus neuf. Ça se retente ;
   * ça ne se remonte pas à quelqu'un qui n'en peut rien faire.
   */
  it('marks a CLI that vanished without a word as worth one more try', () => {
    expect(agentFailure('extraction', 'exited with code 1', '').retryable).toBe(true)
  })

  it('does not retry a CLI that said why it failed', () => {
    // Un module manquant manquera tout autant la seconde fois.
    const failure = agentFailure(
      'extraction',
      'exited with code 1',
      'Error: Cannot find module @anthropic-ai/claude-agent-sdk/cli.js',
    )

    expect(failure.retryable).toBe(false)
  })

  it('does not retry an answer, however it was worded', () => {
    // Un jeton révoqué et une allocation épuisée sont des réponses : les
    // rejouer rendrait la même, et le pas au-dessus décide quoi en faire.
    expect(agentFailure('extraction', 'code 1', 'Invalid API key').retryable).toBe(false)
    expect(agentFailure('extraction', 'code 1', "You've hit your usage limit").retryable).toBe(
      false,
    )
  })

  it('keeps the end of a long diagnostic, which is where the reason is', () => {
    const said = stderrTail(40)
    said.collect('bruit'.repeat(50))
    said.collect('la vraie raison')

    // Un CLI qui n'arrive pas à démarrer dit pourquoi en dernier.
    expect(said.text()).toContain('la vraie raison')
    expect(said.text().length).toBeLessThanOrEqual(40)
  })
})

describe('reading Claude’s answer', () => {
  it('returns the structured output and the tokens it cost', () => {
    const response = interpret('test', result())
    expect(response.structured).toEqual({ ok: true })
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(4)
    expect(response.refusal).toBeUndefined()
  })

  it('treats a refusal as an answer, not as data', () => {
    const response = interpret('test', result({ stop_reason: 'refusal' }))
    expect(response.refusal).toBeTruthy()
    expect(response.structured).toBeUndefined()
  })

  it.each([
    ['the CLI’s own blocking limit', { terminal_reason: 'blocking_limit' }],
    ['a 429 from the API', { api_error_status: 429, subtype: 'error_during_execution' }],
    [
      'the message the subscription sends',
      {
        subtype: 'error_during_execution',
        is_error: true,
        result: "You've reached your usage limit for Claude Max",
      },
    ],
  ])('names a spent allowance as a quota failure — %s', (_label, overrides) => {
    /*
     * The one error the whole migration exists to make legible. Reported as
     * anything else, the reflex is to retry or to reconfigure — and the
     * configuration that would "fix" it is an API key with a bill attached.
     */
    const failure = (() => {
      try {
        interpret('test', result(overrides as Partial<RawAgentResult>))
        return null
      } catch (error) {
        return error
      }
    })()

    expect(failure).toBeInstanceOf(ClaudeAgentError)
    expect((failure as ClaudeAgentError).kind).toBe('quota')
    expect((failure as ClaudeAgentError).message).toMatch(/aucun basculement vers une API facturée/)
  })

  it('refuses to invent an extraction out of a missing answer', () => {
    // An empty result is not an empty chapter. Recording one as the other is
    // exactly the silent half-import the pipeline must never produce.
    expect(() => interpret('test', result({ structured_output: undefined }))).toThrow(
      ClaudeAgentError,
    )
    expect(() => interpret('test', null)).toThrow(ClaudeAgentError)
  })
})

describe('choosing who answers', () => {
  it('prefers the subscription over the metered key when nothing is specified', () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-token',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    })
    expect(remoteModelProvider()).toBe('claude-max')
    expect(hasClaudeSubscription()).toBe(true)
  })

  it('falls back to the metered key only when there is no subscription at all', () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    })
    expect(remoteModelProvider()).toBe('anthropic')

    setEnv({ ANTHROPIC_API_KEY: undefined })
    expect(remoteModelProvider()).toBe('synthetic')
  })

  it('builds the subscription provider, and reports zero cost for its tokens', async () => {
    setEnv({
      MODEL_PROVIDER: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-token',
      ANTHROPIC_API_KEY: undefined,
      LOCAL_AI_BASE_URL: undefined,
      LOCAL_AI_MODEL: undefined,
    })

    const provider = modelProvider('auto')
    expect(provider.name).toBe('claude-max')
    expect(provider).toBeInstanceOf(ClaudeAgentProvider)

    // Nothing here is billed per token; a fabricated figure would poison the
    // one dashboard meant to be checked against something true.
    const estimate = await provider.estimate('extract', { question: 'x' })
    expect(estimate.costCents).toBe(0)
  })

  it('refuses a run launched on Claude Max with no token rather than faking one', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined })
    // Degrading to the synthetic provider here would extract fabricated data
    // under a label that says Claude Max.
    expect(() => modelProvider('claude-max')).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('offers Claude Max as a choice, and says what is missing when it cannot', () => {
    expect(isProviderChoice('claude-max')).toBe(true)

    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined })
    const unavailable = providerOptions().find((option) => option.id === 'claude-max')
    expect(unavailable?.available).toBe(false)
    expect(unavailable?.note).toMatch(/setup-token/)

    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-token' })
    const available = providerOptions().find((option) => option.id === 'claude-max')
    expect(available?.available).toBe(true)
  })
})
