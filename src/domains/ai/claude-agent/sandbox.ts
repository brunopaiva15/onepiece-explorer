import 'server-only'
import { randomUUID } from 'node:crypto'
import { Sandbox } from '@vercel/sandbox'
import { agentPayload } from './payload.ts'
import { agentSdkVersion, RUNNER_SOURCE } from './runner.ts'
import {
  agentFailure,
  agentTimeoutMs,
  AUTH_MESSAGE,
  ClaudeAgentError,
  creationRefusal,
  oauthToken,
  type AgentRequest,
  type RawAgentResult,
} from './runtime.ts'

/**
 * Claude, running inside a Vercel Sandbox.
 *
 * A serverless function is the wrong shape for the Claude Agent SDK: the SDK
 * spawns a CLI, the CLI wants a writable home and a working directory, and the
 * bundle it lives in has to survive whatever the build tracer decided to keep.
 * A sandbox is a small virtual machine with a filesystem, a package manager and
 * a real Node — which is to say, the environment the SDK was written for.
 *
 * The cost of that is a setup: about a minute to boot a machine and install the
 * SDK into it. Paying that once per model call would be indefensible — a
 * chapter of drawn pages is twenty to thirty calls — so the sandbox is created
 * on the first call and reused for every call after it, and shuts itself down
 * once nothing has needed it for a while. A chapter therefore pays the setup
 * once and the run keeps it warm by using it.
 *
 * There is no port exposed and no server listening. Each call writes its
 * request to a file inside the machine, runs the script, and reads the answer
 * back out. A sandbox with an open HTTP endpoint would be a public URL that
 * reaches Claude on this subscription, guarded by nothing but a header — and
 * "no public path to Claude" is a property this project is not willing to
 * weaken for a few hundred milliseconds.
 */

const WORKDIR = '/vercel/sandbox'
const RUNNER_PATH = `${WORKDIR}/claude-runner.mjs`

/** How long a sandbox lives before the platform reclaims it. */
function sandboxLifetimeMs(): number {
  const raw = Number(process.env.CLAUDE_SANDBOX_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000
}

/**
 * How long an unused sandbox is kept warm.
 *
 * Long enough to span the gap between two steps of a run — panel description
 * finishing and extraction starting — and short enough that a machine is not
 * billed through a lunch break because somebody imported one chapter.
 */
function idleShutdownMs(): number {
  const raw = Number(process.env.CLAUDE_SANDBOX_IDLE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

interface Warm {
  sandbox: Sandbox
  /** Rearmed on every call; stops the machine when it stops being rearmed. */
  idle: ReturnType<typeof setTimeout> | undefined
}

let warm: Promise<Warm> | undefined

/**
 * Boot a machine and put the runner in it.
 *
 * Memoised as the *promise*, not the result: a chapter fans several calls out
 * at once, and holding a flag instead would let each of them start its own
 * virtual machine while the first was still booting.
 *
 * Ce que la mémoïsation ne doit pas retenir, c'est un échec. Une promesse
 * rejetée n'est ni `undefined` ni `null` : `warm ??=` la gardait, et toute
 * création ultérieure rejouait la même erreur périmée sans jamais retenter une
 * machine. Un réseau qui hoquette une fois condamnait alors l'instance entière —
 * chaque question suivante du balayage échouait instantanément, en citant une
 * panne vieille de dix minutes. Le rejet se désinscrit donc lui-même, et
 * seulement s'il est encore celui qui est affiché : un appel concurrent a pu
 * poser une machine neuve entre-temps, et l'effacer serait en fabriquer une
 * troisième.
 */
function provision(): Promise<Warm> {
  if (warm) return warm

  const pending: Promise<Warm> = build().catch((error: unknown) => {
    if (warm === pending) warm = undefined
    throw error
  })

  warm = pending
  return pending
}

function build(): Promise<Warm> {
  return (async () => {
    const version = agentSdkVersion()

    let sandbox: Sandbox
    try {
      sandbox = await Sandbox.create({
        timeout: sandboxLifetimeMs(),
        resources: { vcpus: 2 },
      })
    } catch (error: unknown) {
      throw creationRefusal(error)
    }

    try {
      await sandbox.writeFiles([{ path: RUNNER_PATH, content: RUNNER_SOURCE }])

      const install = await sandbox.runCommand({
        cmd: 'npm',
        args: [
          'install',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          `@anthropic-ai/claude-agent-sdk@${version}`,
        ],
        cwd: WORKDIR,
        timeoutMs: 300_000,
      })

      if (install.exitCode !== 0) {
        const detail = (await install.stderr()).slice(-800)
        throw new ClaudeAgentError(
          'sandbox',
          `L'installation du Claude Agent SDK (${version}) dans le bac à sable a échoué : ` +
            `${detail}. Le bac à sable a besoin d'un accès réseau au registre npm.`,
          true,
        )
      }
    } catch (error) {
      // A half-built machine is worse than none: it would fail every call for
      // its whole lifetime while looking like a working one.
      await sandbox.stop().catch(() => {})
      throw error
    }

    return { sandbox, idle: undefined }
  })()
}

/** Keep the machine for a while longer, or stop it if nobody comes back. */
function rearm(entry: Warm): void {
  clearTimeout(entry.idle)
  entry.idle = setTimeout(() => {
    // Cleared first: a caller arriving during the shutdown must provision a new
    // machine rather than queue behind a dying one.
    warm = undefined
    void entry.sandbox.stop().catch(() => {})
  }, idleShutdownMs())
  // Nothing should be kept alive merely because a machine is idling.
  entry.idle.unref?.()
}

export async function runInSandbox(request: AgentRequest): Promise<RawAgentResult | null> {
  const token = oauthToken()

  try {
    return await attempt(request, token)
  } catch (error: unknown) {
    /*
     * One retry, and only for a failure that said nothing about itself.
     *
     * A sandbox has a finite lifetime and can be reclaimed between two calls of
     * a long run — from the caller's side that is indistinguishable from the
     * machine never having existed. Rebuilding once turns "the chapter died at
     * panel 60 because a VM expired" into a minute of setup. A model error, a
     * refusal or a spent quota is not retried here: those are answers, and the
     * step above is what decides what to do with them.
     *
     * Le CLI qui sort en code 1 sans une ligne de sortie d'erreur rejoint cette
     * catégorie, et c'est ce qui manquait. Ce n'était pas un verdict du modèle,
     * mais il était remonté comme tel : le balayage des mystères s'arrêtait à la
     * question qui l'avait rencontré, et les soixante-neuf suivantes — qui
     * n'avaient rien fait de mal — n'étaient jamais posées. Voir `agentFailure`.
     *
     * Deux façons de retenter, parce que ce sont deux soupçons différents. Une
     * panne du bac à sable désigne la machine : on la lâche et on en bâtit une
     * neuve. Un CLI disparu ne désigne qu'un processus : la machine est réputée
     * saine et gardée, ce qui rend la seconde tentative immédiate au lieu de
     * coûter la minute d'installation d'un microVM.
     *
     * Le droit de retenter se lit maintenant sur l'erreur elle-même et non sur
     * son genre. « Tout ce qui est `sandbox` se retente » traitait un refus de
     * la plateforme comme un hoquet : une allocation Sandbox épuisée bâtissait
     * une seconde machine pour se faire refuser une seconde fois, et le
     * balayage payait deux appels et deux minutes par question pour apprendre
     * ce que le premier 402 avait déjà dit. Voir `creationRefusal`.
     */
    if (!(error instanceof ClaudeAgentError)) throw error
    if (!error.retryable) throw error

    if (error.kind === 'sandbox') warm = undefined
    return attempt(request, token)
  }
}

async function attempt(request: AgentRequest, token: string): Promise<RawAgentResult | null> {
  const entry = await provision()
  rearm(entry)

  const id = randomUUID()
  const inPath = `${WORKDIR}/req-${id}.json`
  const outPath = `${WORKDIR}/res-${id}.json`
  const timeoutMs = agentTimeoutMs()

  try {
    await entry.sandbox.writeFiles([
      { path: inPath, content: JSON.stringify(agentPayload(request)) },
    ])

    const command = await entry.sandbox.runCommand({
      cmd: 'node',
      args: [RUNNER_PATH, inPath, outPath],
      cwd: WORKDIR,
      /*
       * The only environment the machine gets, and it is short on purpose.
       *
       * The inline backend has to inherit this process's environment so the
       * child finds a PATH; a sandbox has its own. That difference is worth
       * taking advantage of: the host's environment holds database credentials
       * and service-role keys, none of which a machine that reads comic pages
       * has any business holding. What crosses is the subscription token and
       * nothing else.
       */
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'onepiece-explorer',
        HOME: WORKDIR,
        CI: '1',
      },
      // Below the sandbox's own lifetime, so a hung call is reported as a hung
      // call rather than as a machine that vanished.
      timeoutMs,
    })

    const body = await entry.sandbox.readFileToBuffer({ path: outPath })

    if (!body) {
      const stderr = (await command.stderr()).slice(-800)
      if (command.exitCode === 137 || command.exitCode === null) {
        throw new ClaudeAgentError(
          'timeout',
          `${request.label} : Claude n’a pas répondu en ${Math.round(timeoutMs / 1000)} s ` +
            'dans le bac à sable ; l’appel est abandonné pour être retenté. ' +
            'CLAUDE_AGENT_TIMEOUT_MS ajuste ce délai.',
        )
      }
      throw new ClaudeAgentError(
        'sandbox',
        `${request.label} : le script n’a rien écrit (code ${command.exitCode}). ` +
          (stderr ? `Sortie d’erreur : ${stderr}` : 'Aucune sortie d’erreur.'),
        true,
      )
    }

    let parsed: {
      ok?: boolean
      result?: RawAgentResult | null
      error?: string
      /** What the CLI printed before dying. See RUNNER_SOURCE. */
      stderr?: string
      kind?: 'auth' | 'sdk'
    }
    try {
      parsed = JSON.parse(body.toString('utf8')) as typeof parsed
    } catch {
      throw new ClaudeAgentError(
        'sandbox',
        `${request.label} : réponse illisible du bac à sable — le fichier de sortie ` +
          "n'est pas du JSON. Rien n’a été enregistré pour cet appel.",
        true,
      )
    }

    if (parsed.ok === false) {
      // A rejected credential is not a sandbox problem and must not be retried
      // on a fresh machine: the token would be just as revoked there.
      if (parsed.kind === 'auth') {
        throw new ClaudeAgentError('auth', `${request.label} : ${AUTH_MESSAGE}`)
      }
      /*
       * Le verdict est rendu ici et non dans la machine.
       *
       * Le script ne sait dire que « le SDK a levé » ; ce qui distingue un
       * jeton refusé au démarrage d'une panne du CLI est dans la sortie
       * d'erreur qu'il rapporte, et c'est `agentFailure` qui la lit. Un jeton
       * refusé rendu en « sdk » serait retenté sur une machine neuve, où il
       * serait tout aussi refusé.
       */
      throw agentFailure(
        request.label,
        parsed.error ?? 'raison inconnue',
        parsed.stderr ?? '',
        'dans le bac à sable',
      )
    }

    return parsed.result ?? null
  } catch (error: unknown) {
    if (error instanceof ClaudeAgentError) throw error
    /*
     * Ce que le client du bac à sable lève, dit dans la langue d'ici.
     *
     * `writeFiles`, `runCommand` et `readFileToBuffer` parlent à une machine
     * distante, et une machine reprise par la plateforme entre deux questions du
     * balayage les fait échouer avec une erreur ordinaire. Elle passait telle
     * quelle : ni `ClaudeAgentError`, ni de genre — donc pas de reconstruction,
     * et `warm` continuait de désigner une machine morte pour toute la durée de
     * l'instance. La première panne réseau condamnait ainsi tous les appels
     * suivants, chacun rapportant la même erreur d'un bac à sable qui n'existait
     * plus depuis longtemps.
     */
    const detail = error instanceof Error ? error.message : String(error)
    throw new ClaudeAgentError(
      'sandbox',
      `${request.label} : le bac à sable n’a pas répondu — ${detail}. ` +
        'La machine est abandonnée et l’appel retenté sur une neuve.',
      true,
    )
  } finally {
    // Requests carry a chapter's images; leaving them behind would fill the
    // machine's disk over a long run. Failure to clean up is not worth an error.
    void entry.sandbox
      .runCommand({ cmd: 'rm', args: ['-f', inPath, outPath], cwd: WORKDIR })
      .catch(() => {})
  }
}

/**
 * Stop the shared machine now.
 *
 * For scripts and tests, which end rather than idle: a process that exits with
 * a sandbox still running leaves it to the platform's own timeout.
 */
export async function stopSandbox(): Promise<void> {
  const pending = warm
  warm = undefined
  if (!pending) return

  const entry = await pending.catch(() => null)
  if (!entry) return

  clearTimeout(entry.idle)
  await entry.sandbox.stop().catch(() => {})
}
