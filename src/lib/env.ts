import 'server-only'
import { z } from 'zod'
import { isVercelRuntime } from '@/lib/hosting.ts'

/**
 * Server configuration, validated once at first use.
 *
 * Validation is lazy rather than at module load so that `next build` and the
 * test suite work without a fully populated .env.local — a missing Supabase
 * key should surface as a clear message on the page that needs it, not as an
 * opaque build failure.
 */

const schema = z.object({
  // --- Supabase ---
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // --- Storage ---
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('chapters'),
  STORAGE_DRIVER: z.enum(['supabase', 'local']).default('supabase'),
  LOCAL_STORAGE_ROOT: z.string().default('./var/storage'),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),

  // --- Model provider ---
  /**
   * A Claude Max subscription, reached through the Claude Agent SDK.
   *
   * Generated with `claude setup-token`. This is the default path for chapter
   * processing: the work is one person's, in one admin interface, and a
   * subscription already pays for it. Never prefixed NEXT_PUBLIC_, never
   * returned in a response — see the note on ANTHROPIC_API_KEY below.
   */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  /** 'inline' spawns Claude here, 'sandbox' runs it in a Vercel Sandbox. */
  CLAUDE_AGENT_RUNTIME: z.enum(['auto', 'inline', 'sandbox']).default('auto'),
  CLAUDE_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_AGENT_SDK_VERSION: z.string().min(1).optional(),
  CLAUDE_SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_SANDBOX_IDLE_MS: z.coerce.number().int().positive().optional(),
  /**
   * The metered API key, kept and no longer the default.
   *
   * Still honoured — `MODEL_PROVIDER=anthropic` uses it, and the recorded
   * cassettes are refreshed with it — but nothing falls back onto it. A spent
   * Claude Max allowance stops the import; it does not move the bill.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  MODEL_PROVIDER: z.enum(['claude-max', 'anthropic', 'replay', 'synthetic']).optional(),
  // Self-hosted, OpenAI-compatible endpoint. Set both to use it.
  LOCAL_AI_BASE_URL: z.string().url().optional(),
  LOCAL_AI_MODEL: z.string().min(1).optional(),
  LOCAL_AI_EMBED_MODEL: z.string().min(1).optional(),
  LOCAL_AI_API_KEY: z.string().min(1).optional(),
  LOCAL_AI_TIERS: z.string().optional(),
  LOCAL_AI_REASONING_EFFORT: z.string().optional(),
  MODEL_CLASSIFY: z.string().default('claude-haiku-4-5'),
  MODEL_DESCRIBE: z.string().default('claude-haiku-4-5'),
  MODEL_EXTRACT: z.string().default('claude-sonnet-5'),
  MODEL_ESCALATE: z.string().default('claude-opus-5'),
  USE_BATCH_API: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  ESCALATION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),

  // --- Ingestion limits ---
  // Defence in depth on untrusted uploads. Every one of these has a matching
  // check in the validation step; the environment only makes them tunable.
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(524_288_000),
  MAX_PAGES_PER_CHAPTER: z.coerce.number().int().positive().default(120),
  MAX_PIXELS_PER_PAGE: z.coerce.number().int().positive().default(40_000_000),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().positive().default(500),
  MAX_DECOMPRESSION_RATIO: z.coerce.number().positive().default(120),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Configuration incomplète :\n${issues.map((i) => `  • ${i}`).join('\n')}\n\n` +
        remediation(),
    )
    this.name = 'ConfigurationError'
  }
}

/**
 * Where to go and fix it — which is not the same place in the two places this
 * error appears.
 *
 * On a host there is no .env.local to copy: the values live in the project's
 * settings, and a variable added after the last build is not in the running one.
 * Telling someone to edit a file that cannot exist sends them looking in the
 * wrong place, which is the whole cost of a wrong error message.
 */
function remediation(): string {
  if (isVercelRuntime()) {
    return (
      'Renseignez ces variables dans les réglages du projet chez votre hébergeur, ' +
      'puis redéployez : une variable ajoutée après le dernier build ne se trouve ' +
      'pas dans celui qui tourne. /etat dit lesquelles sont vues par le déploiement.'
    )
  }
  return (
    'Copiez .env.example vers .env.local et renseignez les valeurs manquantes, ' +
    'puis vérifiez avec `pnpm doctor`.'
  )
}

export function env(): Env {
  if (cached) return cached

  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`),
    )
  }
  cached = parsed.data
  return cached
}

/** For tests that need to re-read a mutated environment. */
export function resetEnvCache(): void {
  cached = null
}

/**
 * Is a real model provider configured?
 *
 * When this is false the pipeline falls back to the synthetic provider and the
 * interface says so plainly. Extraction shown in that mode is generated, not
 * derived from the pages — presenting it as real would be a lie in the one
 * place this product cannot afford one.
 */
export function hasModelCredentials(): boolean {
  // A self-hosted endpoint is a real model reading real pages, so the synthetic
  // banner must not appear for it. Without this the interface would announce
  // fabricated extraction over extraction that actually happened.
  if (hasLocalModel()) return true
  const provider = process.env.MODEL_PROVIDER
  if (provider === 'synthetic' || provider === 'replay') return true
  return hasClaudeSubscription() || Boolean(process.env.ANTHROPIC_API_KEY)
}

/**
 * Is a Claude Max subscription token configured?
 *
 * The presence of the variable, not its validity: a token that has expired
 * fails at the first call with a message that says so, and pretending here that
 * it is absent would send someone to set a variable they have already set.
 */
export function hasClaudeSubscription(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
}

/** Is a self-hosted, OpenAI-compatible endpoint configured? */
export function hasLocalModel(): boolean {
  return Boolean(process.env.LOCAL_AI_BASE_URL?.trim() && process.env.LOCAL_AI_MODEL?.trim())
}

/**
 * Is the conversational assistant switched on?
 *
 * A separate switch from the model key, and off by default, because the two
 * spend money in completely different shapes. Processing a chapter is one
 * deliberate act with a known cost; `/admin/ask` bills per question, forever, at the
 * speed someone can type. Having a key so the pipeline can read your pages must
 * not silently open a metered box.
 *
 * Set ASSISTANT_ENABLED=1 to turn it on. Anything else, including absent, is
 * off — fail-closed on spending, the same way the boundary fails closed on
 * knowledge.
 */
export function isAssistantEnabled(): boolean {
  return process.env.ASSISTANT_ENABLED === '1'
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Whose library anonymous visitors read, if anyone's.
 *
 * Absent — the default — means the site is exactly as private as it has always
 * been: every page requires signing in. Public reading is something you switch
 * on deliberately, by pasting your own library id, and never something a
 * missing or malformed value can switch on by accident.
 *
 * A malformed value returns null rather than throwing. Failing closed is the
 * right direction here: a typo should make the site private, not crash it, and
 * `pnpm doctor` and the settings page both report what was resolved.
 */
export function publicLibraryOwnerId(): string | null {
  const value = process.env.PUBLIC_LIBRARY_OWNER_ID?.trim()
  if (!value || !UUID_RE.test(value)) return null
  return value
}

/**
 * Which hosted provider serves whatever the local endpoint does not.
 *
 * Deliberately blind to LOCAL_AI_*: this is the fallback half of the routing
 * table, and a fallback that could itself resolve to "local" would be a loop.
 */
export function remoteModelProvider(): 'claude-max' | 'anthropic' | 'replay' | 'synthetic' {
  const requested = process.env.MODEL_PROVIDER as
    | 'claude-max'
    | 'anthropic'
    | 'replay'
    | 'synthetic'
    | undefined

  /*
   * Unset means "use what is configured", and the order is the answer to the
   * question this migration was about.
   *
   * A subscription token wins over a metered key, because the subscription is
   * already paid for and the key is not. This is a choice made once, when the
   * provider is built — not a fallback taken when something fails. Nothing
   * below reaches for ANTHROPIC_API_KEY after a Claude Max call has been
   * refused: a spent allowance stops the import, loudly, which is the whole
   * point of preferring the subscription in the first place.
   */
  if (!requested) {
    if (hasClaudeSubscription()) return 'claude-max'
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
    return 'synthetic'
  }

  /*
   * An explicit choice whose credentials are missing degrades to synthetic
   * rather than throwing, which is how this has always behaved: the interface
   * says plainly that the extraction is generated, and a misconfigured
   * deployment stays readable instead of erroring on every page.
   */
  if (requested === 'claude-max' && !hasClaudeSubscription()) return 'synthetic'
  if (requested === 'anthropic' && !process.env.ANTHROPIC_API_KEY) return 'synthetic'

  return requested
}

/**
 * What is recorded on a run, and shown in the interface.
 *
 * A local endpoint that takes only some tiers still reports 'local': its
 * weights are the ones nobody else can reproduce, and that is what a reader of
 * the run history needs to know when two runs of the same chapter disagree.
 */
export function effectiveModelProvider():
  | 'anthropic'
  | 'claude-max'
  | 'local'
  | 'replay'
  | 'synthetic' {
  if (hasLocalModel()) return 'local'
  return remoteModelProvider()
}
