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

export async function runInline(request: AgentRequest): Promise<RawAgentResult | null> {
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
