import 'server-only'
import { z } from 'zod'

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
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  MODEL_PROVIDER: z.enum(['anthropic', 'replay', 'synthetic']).default('anthropic'),
  MODEL_CLASSIFY: z.string().default('claude-haiku-4-5'),
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
        `Copiez .env.example vers .env.local et renseignez les valeurs manquantes.`,
    )
    this.name = 'ConfigurationError'
  }
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
  const provider = process.env.MODEL_PROVIDER ?? 'anthropic'
  if (provider === 'synthetic' || provider === 'replay') return true
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export function effectiveModelProvider(): 'anthropic' | 'replay' | 'synthetic' {
  const requested = (process.env.MODEL_PROVIDER ?? 'anthropic') as
    | 'anthropic'
    | 'replay'
    | 'synthetic'
  if (requested === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    return 'synthetic'
  }
  return requested
}
