/**
 * The script that runs inside the Vercel Sandbox.
 *
 * Kept as a string in a TypeScript module rather than as a `.mjs` file on disk,
 * and that is deliberate: a separate file would have to be traced into the
 * serverless bundle by the build, which is exactly the kind of dependency that
 * works locally and is missing in production. A string is part of the module
 * that imports it and cannot be left behind.
 *
 * It does nothing this project's own code does not do — it reads a payload,
 * calls `query()`, writes the result. Everything interesting (which prompt,
 * which schema, which model, no tools, no settings) was decided on the host in
 * `agentPayload` and is carried in the payload it reads.
 *
 * Output goes to a file rather than to stdout. The SDK and the CLI it spawns
 * both consider stdout theirs, and a single stray line of diagnostics would
 * turn a valid answer into a parse error at the other end.
 *
 * The CLI's stderr goes into that file too, and only on failure. It is the one
 * thing a machine that dies at startup has to say: the SDK reports « Claude
 * Code process exited with code 1 » and nothing else, and the host has no way
 * to reach inside the microVM afterwards — the sandbox's own stderr belongs to
 * the runner, which exits cleanly. Kept by the tail, because a CLI that fails
 * to start says why last.
 */
import { STDERR_KEPT } from './runtime.ts'

export const RUNNER_SOURCE = `import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'

const inPath = process.argv[2]
const outPath = process.argv[3]

const STDERR_KEPT = ${STDERR_KEPT}
let said = ''

function keep(chunk) {
  said += String(chunk).endsWith('\\n') ? chunk : chunk + '\\n'
  if (said.length > STDERR_KEPT) said = said.slice(said.length - STDERR_KEPT)
}

async function run() {
  const payload = JSON.parse(await readFile(inPath, 'utf8'))

  async function* input() {
    yield {
      type: 'user',
      message: payload.message,
      parent_tool_use_id: null,
      session_id: '',
      uuid: randomUUID(),
    }
  }

  const controller = new AbortController()
  let rejectedCredential = false
  let result = null

  try {
    for await (const message of query({
      prompt: input(),
      options: {
        ...payload.options,
        cwd: process.env.HOME,
        abortController: controller,
        stderr: keep,
      },
    })) {
      // A 401 is retried ten times by the CLI like any transient error, and no
      // amount of backoff makes a revoked token accepted. Cut it short so the
      // host reports the credential rather than a timeout.
      if (
        message.type === 'system' &&
        message.subtype === 'api_retry' &&
        (message.error_status === 401 || message.error_status === 403)
      ) {
        rejectedCredential = true
        controller.abort()
        continue
      }
      if (message.type === 'result') result = message
    }
  } catch (error) {
    // The abort above is what makes the loop throw; the flag is what says the
    // throw was a rejected credential rather than a dead connection.
    if (!rejectedCredential) throw error
  }

  if (rejectedCredential) {
    const denied = new Error('rejeté par Claude (401/403)')
    denied.kind = 'auth'
    throw denied
  }
  return result
}

try {
  const result = await run()
  await writeFile(outPath, JSON.stringify({ ok: true, result }))
} catch (error) {
  const kind = error && error.kind === 'auth' ? 'auth' : 'sdk'
  const detail = error && error.message ? error.message : String(error)
  await writeFile(outPath, JSON.stringify({ ok: false, kind, error: detail, stderr: said.trim() }))
  process.exitCode = 1
}
`

/**
 * The SDK version installed inside the sandbox.
 *
 * Pinned rather than floating so that a run today and a run next month ask the
 * same software the same question — the sandbox is rebuilt from scratch every
 * time, so an unpinned install would silently upgrade mid-project. Keep it in
 * step with the dependency in package.json; CLAUDE_AGENT_SDK_VERSION overrides
 * it without a deploy when a fix lands upstream.
 */
export function agentSdkVersion(): string {
  return process.env.CLAUDE_AGENT_SDK_VERSION?.trim() || '0.3.233'
}
