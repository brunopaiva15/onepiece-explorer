import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * La seconde tentative de la dorsale inline.
 *
 * Elle existe parce que son absence a coûté un balayage entier, et parce que le
 * message d'échec affirmait pendant ce temps qu'elle avait eu lieu. `agentFailure`
 * pose `retryable` sur un CLI mort sans un mot ; `runInSandbox` lisait ce
 * drapeau, `runInline` ne le lisait pas, et la phrase « L'appel a été retenté
 * une fois » était donc vraie d'un côté et fausse de l'autre — sur un runner
 * GitHub, quatre questions refermées puis un « exited with code 1 » muet, et
 * cent vingt-six questions jamais posées à cause de lui.
 *
 * Le SDK est remplacé ici : ce qui est en test n'est pas ce que Claude répond,
 * mais combien de fois le processus est lancé, et pour quelles pannes.
 */

let attempts = 0
/** Ce que la n-ième tentative fait : lever, ou rendre un résultat. */
let script: Array<() => void> = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const step = script[attempts]
    attempts++
    step?.()

    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        structured_output: { ok: true },
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    })()
  },
}))

const { runInline } = await import('@/domains/ai/claude-agent/inline.ts')
const { ClaudeAgentError } = await import('@/domains/ai/claude-agent/runtime.ts')

const REQUEST = {
  label: 'balayage',
  system: 'Vous êtes un lecteur.',
  content: [{ type: 'text' as const, text: 'La question.' }],
  model: 'claude-sonnet-5',
  schema: { type: 'object' },
}

const original = { ...process.env }

beforeEach(() => {
  attempts = 0
  script = []
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-test'
})

afterEach(() => {
  process.env = { ...original }
})

describe('the inline backend’s one retry', () => {
  it('starts the process once when nothing goes wrong', async () => {
    await runInline(REQUEST)
    expect(attempts).toBe(1)
  })

  it('relaunches a CLI that died without a word', async () => {
    // La panne exacte du runner : le SDK ne sait dire que le code de sortie,
    // et le CLI n'a rien écrit — donc `retryable`.
    script = [
      () => {
        throw new Error('Claude Code process exited with code 1')
      },
    ]

    const result = await runInline(REQUEST)

    expect(attempts).toBe(2)
    expect(result).toMatchObject({ subtype: 'success' })
  })

  it('does not relaunch an answer, and gives up after one retry', async () => {
    // Un jeton refusé le sera tout autant au second essai.
    script = [
      () => {
        throw new Error('Invalid API key · Please run /login')
      },
    ]
    await expect(runInline(REQUEST)).rejects.toBeInstanceOf(ClaudeAgentError)
    expect(attempts).toBe(1)

    // Et deux silences de suite désignent autre chose qu'un processus perdu :
    // on remonte la panne plutôt que de boucler dessus.
    attempts = 0
    const die = () => {
      throw new Error('Claude Code process exited with code 1')
    }
    script = [die, die]
    await expect(runInline(REQUEST)).rejects.toBeInstanceOf(ClaudeAgentError)
    expect(attempts).toBe(2)
  })

  it('does not relaunch a binary that is not installed', async () => {
    // Il ne s'installera pas entre deux tentatives, et le message dit où le
    // chercher plutôt que de faire perdre une minute de plus.
    script = [
      () => {
        throw new Error('Native CLI binary for linux-x64 not found.')
      },
    ]

    await expect(runInline(REQUEST)).rejects.toMatchObject({ kind: 'runtime' })
    expect(attempts).toBe(1)
  })
})
