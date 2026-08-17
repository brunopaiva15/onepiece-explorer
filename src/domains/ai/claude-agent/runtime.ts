import 'server-only'
import { isVercelRuntime } from '@/lib/hosting.ts'

/**
 * The boundary between "what this pipeline asks Claude" and "where Claude runs".
 *
 * Everything above this file — prompts, schemas, anchoring, the boundary — is
 * unchanged by the move off the paid API. What changes is only who answers and
 * how they are paid: the Claude Agent SDK, authenticated with a Claude Max
 * subscription token, instead of `api.anthropic.com` billed per token.
 *
 * Two execution backends sit behind `runClaude`, and they differ in exactly one
 * respect: where the Claude Code process is spawned.
 *
 *   inline   — the SDK spawns its bundled CLI as a child process of this one.
 *              Right for a laptop, and for any host that lets a request fork a
 *              process and write to a scratch directory.
 *
 *   sandbox  — the same script, run inside a Vercel Sandbox microVM. Right for
 *              a serverless deployment, where the filesystem is read-only, the
 *              invocation is short-lived, and a bundled CLI is not something to
 *              rely on being traced into the deployment.
 *
 * Both return the same object, because both are running the *same* SDK call.
 * The interpretation of that object — refusal, quota, empty answer, malformed
 * answer — lives here once, in `interpret`, rather than twice.
 */

/**
 * Content blocks, narrowed to what this pipeline actually sends.
 *
 * Deliberately not the Anthropic SDK's `ContentBlockParam`. This shape has to
 * survive `JSON.stringify` into a sandbox and come back out the other side, and
 * a type that admits tool results and documents would be describing a request
 * this project never makes.
 */
export type AgentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: {
        type: 'base64'
        media_type: 'image/webp' | 'image/png' | 'image/jpeg'
        data: string
      }
    }

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentRequest {
  /** Names the call in an error message. Never sent to the model. */
  label: string
  /** The project's system prompt, verbatim. */
  system: string
  content: AgentBlock[]
  model: string
  /** JSON Schema derived from the same Zod schema the caller will validate with. */
  schema: Record<string, unknown>
  /** Only ever used to turn thinking off; see `reasoningFor`. */
  thinking?: 'disabled'
  effort?: AgentEffort
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface AgentResponse {
  /** The model's answer, still untyped: the caller validates it with Zod. */
  structured: unknown
  usage: AgentUsage
  /** Set when the model declined. Callers must not read `structured`. */
  refusal?: string
}

/**
 * What went wrong, in the vocabulary the admin interface can act on.
 *
 * The kind exists so the interface can say something better than "erreur", and
 * so that `quota` in particular is unmistakable: the whole point of this
 * migration is that a spent Claude Max allowance stops the import rather than
 * quietly moving the bill onto a metered API key.
 */
export type AgentErrorKind =
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'sandbox'
  | 'empty'
  | 'invalid'
  | 'sdk'

export class ClaudeAgentError extends Error {
  constructor(
    readonly kind: AgentErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ClaudeAgentError'
  }
}

/**
 * The subscription token, or a message that says what to do about its absence.
 *
 * Read from the environment on every call rather than captured once, so a token
 * rotated in the host's settings takes effect on the next run instead of on the
 * next deploy.
 */
export function oauthToken(): string {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (!token) {
    throw new ClaudeAgentError(
      'auth',
      "CLAUDE_CODE_OAUTH_TOKEN est absente : le traitement n'a aucun moyen de " +
        's’authentifier auprès de Claude. Générez un jeton avec `claude setup-token`, ' +
        'puis renseignez-le dans .env.local en local, ou dans les variables du projet ' +
        'chez votre hébergeur avant de redéployer.',
    )
  }
  return token
}

export function hasOauthToken(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
}

/**
 * The Claude Code process must not be able to reach a metered API key.
 *
 * This is the mechanism behind the promise, not a comment about it. The Claude
 * Code CLI accepts several ways to authenticate and `ANTHROPIC_API_KEY` is one
 * of them; a subprocess that inherited it could quietly answer on Claude
 * Platform billing the moment the subscription said no — which is precisely the
 * outcome this whole change exists to prevent. So the key, and every sibling
 * variable that could redirect the call to a paid endpoint, is removed from the
 * environment the subprocess is handed.
 *
 * `HOME` is repointed at a writable scratch directory for the same reason a
 * serverless filesystem is read-only: the CLI keeps configuration and session
 * state under it, and there is nowhere else to put them.
 */
export function agentEnv(token: string, home: string): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (PAID_PATH.has(name)) continue
    inherited[name] = value
  }

  return {
    ...inherited,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    HOME: home,
    // Identifies this project in the SDK's User-Agent. Useful when reading the
    // subscription's own usage page and wondering what spent it.
    CLAUDE_AGENT_SDK_CLIENT_APP: 'onepiece-explorer',
    // Nothing in this pipeline is interactive, and a CLI that decides it has a
    // terminal will try to draw one.
    CI: '1',
  }
}

/**
 * Variables that could route a call onto per-token billing, or onto a different
 * endpoint entirely. Stripped rather than overridden: an empty string is still
 * a value, and some readers treat it as one.
 */
const PAID_PATH = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
])

export type AgentRuntimeKind = 'inline' | 'sandbox'

/**
 * Where Claude runs.
 *
 * `auto` — the default — reads the host rather than a preference: a serverless
 * deployment gets the sandbox, a laptop gets the child process. Naming one
 * explicitly is how you test the other, which is the only way to find out that
 * the one you do not use has stopped working.
 */
export function agentRuntime(): AgentRuntimeKind {
  const chosen = process.env.CLAUDE_AGENT_RUNTIME?.trim()
  if (chosen === 'inline' || chosen === 'sandbox') return chosen
  return isVercelRuntime() ? 'sandbox' : 'inline'
}

/**
 * How long one call may take before it is abandoned.
 *
 * Generous, because extraction over a chapter's worth of passages legitimately
 * takes minutes, and because the step above knows how to retry a slice but not
 * how to resurrect a call that never returns. The failure this bounds is the
 * one with no error: a process that is alive, connected, and producing nothing.
 */
export function agentTimeoutMs(): number {
  const raw = Number(process.env.CLAUDE_AGENT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000
}

/**
 * Is this stream event an authentication failure being retried?
 *
 * Worth its own check, because the alternative is the worst diagnosis this
 * integration can produce. A revoked or expired `CLAUDE_CODE_OAUTH_TOKEN` comes
 * back as a 401, and the CLI retries a 401 ten times with backoff like any
 * other transient error — so the call does not fail, it hangs, and the timeout
 * fires minutes later and reports a timeout. Someone reading that goes looking
 * at the network, at Claude's status page, at CLAUDE_AGENT_TIMEOUT_MS: at
 * everything except the one variable that is actually wrong.
 *
 * Retrying is right for a 429 or a 500 and pointless for a 401 — no amount of
 * backoff makes a rejected credential accepted — so this is the one status
 * worth cutting short rather than waiting out.
 */
export function isAuthFailure(event: {
  type?: string
  subtype?: string
  error_status?: number | null
}): boolean {
  return (
    event.type === 'system' &&
    event.subtype === 'api_retry' &&
    (event.error_status === 401 || event.error_status === 403)
  )
}

export const AUTH_MESSAGE =
  'Claude a refusé le jeton (401/403). CLAUDE_CODE_OAUTH_TOKEN est probablement ' +
  'expirée ou révoquée : régénérez-la avec `claude setup-token`, puis remettez-la ' +
  'dans .env.local ou dans les variables du projet chez votre hébergeur. ' +
  'Rien n’a été enregistré pour cet appel.'

/**
 * The SDK result, as both backends hand it back.
 *
 * Typed loosely on purpose: the sandbox backend parses this out of a JSON line
 * printed by another process, so it has crossed a boundary where nothing is
 * guaranteed. Everything below treats missing fields as missing rather than
 * assuming the shape.
 */
export interface RawAgentResult {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  errors?: string[]
  structured_output?: unknown
  stop_reason?: string | null
  terminal_reason?: string
  api_error_status?: number | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/**
 * Signals that the Claude Max allowance, not the request, is what failed.
 *
 * Mirrors the head of the SDK's own `USAGE_LIMIT_ERROR_PREFIXES`. Matched
 * case-insensitively on the result text, and joined by two structural signals
 * that need no string matching at all — a 429 from the API, and the CLI's own
 * `blocking_limit` terminal reason.
 *
 * Getting this wrong in the safe direction costs a misleading message; getting
 * it wrong in the other direction would be worse, because "quota atteint" is
 * the one error the user asked to be told plainly rather than worked around.
 */
const QUOTA_SIGNALS = [
  "you've hit your",
  "you've reached your",
  "you're out of usage",
  'out of usage credits',
  'usage limit',
  'rate_limit',
  'rate limit',
]

function looksLikeQuota(raw: RawAgentResult): boolean {
  if (raw.terminal_reason === 'blocking_limit') return true
  if (raw.api_error_status === 429) return true

  const text = [raw.result ?? '', ...(raw.errors ?? [])].join(' ').toLowerCase()
  return QUOTA_SIGNALS.some((signal) => text.includes(signal))
}

const QUOTA_MESSAGE =
  'Quota Claude Max atteint : Claude a refusé la requête faute d’allocation restante. ' +
  'Le traitement s’arrête ici — aucun basculement vers une API facturée n’est tenté, ' +
  'et rien d’incomplet n’est enregistré. Réessayez quand votre allocation se recharge.'

/**
 * Turn an SDK result into the project's shape, or into an error that says why
 * there is none.
 *
 * The order of the checks is the order in which a wrong answer would be
 * expensive. A refusal read as data is the worst case and is checked first; a
 * quota failure read as a malformed answer would send someone to the schema;
 * and an empty answer that reached this far is a real failure rather than an
 * empty extraction — `structured_output` is present and valid or it is not
 * there at all.
 */
export function interpret(label: string, raw: RawAgentResult | null): AgentResponse {
  if (!raw) {
    throw new ClaudeAgentError(
      'empty',
      `${label} : Claude n’a produit aucun résultat. La session s’est terminée sans ` +
        'message final, ce qui vient d’un processus tué ou d’une connexion coupée.',
    )
  }

  const usage: AgentUsage = {
    inputTokens: raw.usage?.input_tokens ?? 0,
    outputTokens: raw.usage?.output_tokens ?? 0,
    cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? 0,
  }

  if (raw.stop_reason === 'refusal') {
    return {
      structured: undefined,
      usage,
      refusal:
        'Le modèle a refusé de répondre à cette requête. ' +
        'Rien n’a été extrait ; la page est signalée pour revue manuelle.',
    }
  }

  if (looksLikeQuota(raw)) {
    throw new ClaudeAgentError('quota', `${label} : ${QUOTA_MESSAGE}`)
  }

  if (raw.subtype !== 'success' || raw.is_error) {
    const detail = [raw.result ?? '', ...(raw.errors ?? [])].filter(Boolean).join(' · ')
    throw new ClaudeAgentError(
      'sdk',
      `${label} : Claude s’est arrêté sur « ${raw.subtype ?? 'inconnu'} »` +
        (detail ? ` — ${detail.slice(0, 500)}` : '') +
        '. Rien n’a été enregistré pour cet appel.',
    )
  }

  if (raw.structured_output === undefined || raw.structured_output === null) {
    throw new ClaudeAgentError(
      'invalid',
      `${label} : Claude a terminé sans produire de sortie structurée. ` +
        'La réponse a été rendue en texte libre au lieu de remplir le schéma demandé ; ' +
        'aucune donnée n’est exploitable et rien n’est enregistré.',
    )
  }

  return { structured: raw.structured_output, usage }
}

/**
 * Run one request against Claude, wherever Claude runs here.
 *
 * The backends are imported lazily and only the chosen one is loaded: an inline
 * deployment must not pay to bundle and initialise the sandbox client, and a
 * sandbox deployment must not fail because the CLI it will never spawn was not
 * traced into the build.
 */
export async function runClaude(request: AgentRequest): Promise<AgentResponse> {
  const runtime = agentRuntime()

  const raw =
    runtime === 'sandbox'
      ? await (await import('./sandbox.ts')).runInSandbox(request)
      : await (await import('./inline.ts')).runInline(request)

  return interpret(request.label, raw)
}
