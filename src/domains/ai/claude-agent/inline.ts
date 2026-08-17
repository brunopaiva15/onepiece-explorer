import 'server-only'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { agentPayload } from './payload.ts'
import {
  agentEnv,
  agentFailure,
  agentTimeoutMs,
  AUTH_MESSAGE,
  ClaudeAgentError,
  isAuthFailure,
  oauthToken,
  stderrTail,
  type AgentRequest,
  type RawAgentResult,
} from './runtime.ts'

/**
 * Claude, spawned as a child of this process.
 *
 * The SDK ships the Claude Code CLI and runs it over stdio; everything this
 * file adds is the three things that are the caller's job rather than the SDK's
 * — somewhere writable to keep a home directory, an environment that cannot
 * reach a metered API key, and a bound on how long silence is tolerated.
 *
 * This is the backend for a laptop, and for any host that will let a request
 * fork a process. On a serverless deployment the sandbox backend is the one
 * that runs; see `agentRuntime`.
 */

/**
 * A scratch home, created once per process.
 *
 * The CLI writes configuration and session state under `HOME`. On a laptop that
 * would be the developer's own `~/.claude`, which is both surprising — a web
 * request quietly editing your Claude Code settings — and wrong, since
 * `settingSources: []` means none of it would be read back anyway. A directory
 * under the system temp folder is the honest answer: writable everywhere,
 * including the one writable path a serverless filesystem offers.
 */
let scratchHome: Promise<string> | undefined

function home(): Promise<string> {
  scratchHome ??= mkdtemp(path.join(tmpdir(), 'ope-claude-'))
  return scratchHome
}

/**
 * Oublier le répertoire partagé, pour que le suivant en ait un neuf.
 *
 * Il est mémoïsé pour la durée du processus, ce qui est le bon défaut : le CLI
 * y garde de quoi démarrer plus vite, et un balayage l'appelle des dizaines de
 * fois. Mais c'est aussi la seule chose que ces dizaines d'appels partagent, et
 * le journal d'un runner désigne précisément ce genre de chose : les premières
 * questions passent, les suivantes meurent en code 1 sans un mot, et la
 * proportion d'échecs monte à mesure que le balayage avance. Quinze lancements
 * réussis puis trois échecs de suite ne décrivent pas une requête fautive — ils
 * décrivent un état qui se dégrade.
 *
 * Ce n'est donc pas un diagnostic mais une élimination : c'est la seule
 * variable que le rejeu ne changeait pas, et un rejeu qui rejoue tout à
 * l'identique ne rejoue rien.
 */
function discardHome(): void {
  scratchHome = undefined
}

/** Le temps de laisser retomber ce qui a débordé, avant de recommencer. */
const BREATH_MS = 2000

/**
 * Une seconde tentative, pour la panne qui n'a rien dit d'elle-même.
 *
 * `agentFailure` posait déjà `retryable` sur un CLI mort sans un mot, et le
 * message qu'il rend affirmait « L'appel a été retenté une fois ». C'était vrai
 * dans le bac à sable, qui lit ce drapeau, et faux ici : cette dorsale ne le
 * lisait pas. Le balayage des mystères l'a établi sur un runner — quatre
 * questions posées et refermées, la cinquième rencontrant un « exited with code
 * 1 » muet, et cent vingt-six qui n'ont jamais été posées à cause d'elle. Le
 * drapeau disait précisément que ce processus-là valait d'être relancé.
 *
 * Un seul rejeu, et seulement pour ce cas. Un jeton refusé, une allocation
 * épuisée, un binaire absent, un schéma raté sont des réponses : les rejouer
 * rendrait la même, plus lentement.
 *
 * Et un rejeu qui rejoue tout à l'identique ne rejoue rien. La première version
 * relançait aussitôt, dans le même répertoire partagé, et échouait aussi
 * souvent que l'appel qu'elle reprenait — trois questions sur huit sur un
 * runner, rejeu compris. Le processus fils, lui, est déjà neuf à chaque appel ;
 * ce qui ne l'était pas, c'est le `HOME` que tous se passent et le moment, pris
 * dans la même seconde que la panne. Les deux changent maintenant. Le bac à
 * sable fait le même geste d'une autre main, en lâchant sa machine.
 */
export async function runInline(request: AgentRequest): Promise<RawAgentResult | null> {
  try {
    return await attempt(request)
  } catch (error: unknown) {
    if (!(error instanceof ClaudeAgentError) || !error.retryable) throw error

    discardHome()
    await new Promise((resolve) => setTimeout(resolve, BREATH_MS))
    return attempt(request)
  }
}

async function attempt(request: AgentRequest): Promise<RawAgentResult | null> {
  const token = oauthToken()
  const cwd = await home()
  const payload = agentPayload(request)

  /*
   * Streaming input mode, so a message can carry images.
   *
   * A plain string prompt would be enough for the text-only calls and useless
   * for panel description, which sends a chapter's crops as base64 blocks. One
   * shape for both keeps the two paths from diverging in the place where a
   * difference would be least visible.
   */
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: payload.message,
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID(),
    }
  }

  const controller = new AbortController()
  const timeoutMs = agentTimeoutMs()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const said = stderrTail()

  const options: Options = {
    ...payload.options,
    // Cast once, here. `agentPayload` builds a plain, serialisable object on
    // purpose — the SDK's own literal unions are recovered at the only point
    // that needs them.
    settingSources: payload.options.settingSources as Options['settingSources'],
    tools: payload.options.tools,
    cwd,
    env: agentEnv(token, cwd),
    abortController: controller,
    /*
     * The CLI's diagnostics, kept out of the server log and kept all the same.
     *
     * Discarding them was right about the log and wrong about the failure: on
     * a hundred-call chapter this is noise, and on the one call that dies at
     * startup it is the only statement of what went wrong. « Claude Code
     * process exited with code 1 » is everything the SDK knows about a process
     * that refused to run; the reason was here.
     */
    stderr: said.collect,
  }

  let result: RawAgentResult | null = null
  let rejectedCredential = false

  try {
    for await (const message of query({ prompt: input(), options })) {
      /*
       * Cut a rejected credential short rather than let it retry ten times.
       * The abort makes the loop throw, and the flag is what tells the handler
       * below that this was authentication rather than a dead connection.
       */
      if (isAuthFailure(message)) {
        rejectedCredential = true
        controller.abort()
        continue
      }
      // The last result wins: in streaming-input mode each result carries the
      // running totals, so an earlier one would under-report usage.
      if (message.type === 'result') result = message as RawAgentResult
    }
  } catch (error: unknown) {
    if (rejectedCredential) {
      throw new ClaudeAgentError('auth', `${request.label} : ${AUTH_MESSAGE}`)
    }
    if (controller.signal.aborted) {
      throw new ClaudeAgentError(
        'timeout',
        `${request.label} : Claude n’a pas répondu en ${Math.round(timeoutMs / 1000)} s ; ` +
          'l’appel est abandonné pour être retenté. CLAUDE_AGENT_TIMEOUT_MS ajuste ce délai.',
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw agentFailure(request.label, detail, said.text())
  } finally {
    clearTimeout(timer)
  }

  return result
}
