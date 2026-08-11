/**
 * `pnpm doctor` — does this installation actually work?
 *
 * Written because "I added the environment variables" and "the application can
 * reach the database" are different claims, and the gap between them is where
 * an evening disappears. Every check here connects to the real thing and
 * reports what came back. Nothing is inferred from a variable being non-empty.
 *
 * Two checks earn their place by testing a promise rather than a connection:
 * the boundary check confirms that row-level security is actually enforced on
 * the application connection, and the bucket check confirms the storage bucket
 * is private. Both are silent failures otherwise — the application would work
 * perfectly while leaking.
 *
 * Reads .env.local. Prints no secret: only whether one is present, and what
 * the far end said.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { connectionStringIssue, endpointOf } from '../src/lib/connection-string.ts'
import { vercelFlagLooksPulled } from '../src/lib/hosting.ts'

type Level = 'ok' | 'warn' | 'fail' | 'skip'

interface Result {
  level: Level
  label: string
  detail?: string
  hint?: string
}

const results: Result[] = []

/**
 * Variables whose value is present but not the right kind of thing.
 *
 * Recorded so the checks downstream can stand aside instead of crashing on them.
 * A diagnostic that stops at its first bad value reports one problem out of
 * three, and the run has to be repeated once per fix.
 */
const unusable = new Set<string>()

function record(result: Result): void {
  results.push(result)
  const mark = { ok: '✓', warn: '!', fail: '✗', skip: '·' }[result.level]
  const colour = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', skip: '\x1b[90m' }[
    result.level
  ]
  console.log(`${colour}${mark}\x1b[0m ${result.label}${result.detail ? ` — ${result.detail}` : ''}`)
  if (result.hint) console.log(`    \x1b[90m${result.hint}\x1b[0m`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const endpoint = endpointOf

/**
 * Is the value the right *kind* of thing?
 *
 * Present and usable are different claims, and the gap between them is worse
 * than an absence: an absent variable is named here, a malformed one is named
 * nowhere. It surfaces much later as `Invalid supabaseUrl` from a Supabase
 * client, or as `getaddrinfo ENOTFOUND base` from the PostgreSQL driver — which
 * happens because `pg-connection-string` accepts any prose and reads the word
 * "base" in it as a hostname. Both of those were real, and neither mentioned
 * which variable was at fault.
 */
const GENERIC_HINT =
  'La variable a une valeur, mais pas du bon genre. Recopiez-la depuis sa source.'

function shapeProblem(
  name: string,
  value: string,
): { detail: string; hint: string } | null {
  if (name === 'NEXT_PUBLIC_SUPABASE_URL') {
    const source = 'Attendu : https://<ref>.supabase.co — Supabase → Project Settings → API.'
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return { detail: "n'est pas une URL", hint: source }
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { detail: `protocole « ${parsed.protocol} » au lieu de https:`, hint: source }
    }
    if (!parsed.hostname.includes('.')) {
      return { detail: `hôte « ${parsed.hostname} » sans domaine`, hint: source }
    }
    return null
  }

  if (name === 'DATABASE_URL' || name === 'DIRECT_URL' || name === 'TEST_DATABASE_URL') {
    const issue = connectionStringIssue(value)
    if (!issue) return null
    return { detail: issue.problem, hint: issue.fix ?? GENERIC_HINT }
  }

  return null
}

// --------------------------------------------------------------------------
// Variables
// --------------------------------------------------------------------------

function checkVariables(): void {
  console.log('\n\x1b[1mVariables\x1b[0m')

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'DATABASE_URL',
    'DIRECT_URL',
  ]
  const optional = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']

  for (const name of required) {
    const value = process.env[name]
    if (!value) {
      record({
        level: 'fail',
        label: name,
        detail: 'absent',
        hint: "Copiez .env.example vers .env.local et renseignez cette valeur.",
      })
    } else if (value.includes('YOUR-PROJECT') || value.includes('PASSWORD')) {
      record({
        level: 'fail',
        label: name,
        detail: 'contient encore un espace réservé de .env.example',
      })
    } else {
      const problem = shapeProblem(name, value)
      if (problem) {
        unusable.add(name)
        record({ level: 'fail', label: name, detail: problem.detail, hint: problem.hint })
      } else {
        record({
          level: 'ok',
          label: name,
          // The endpoint for a connection string, because "défini" is exactly
          // what the failing case also says. Host and port carry no secret.
          detail: name.endsWith('_URL') && name !== 'NEXT_PUBLIC_SUPABASE_URL'
            ? `défini — ${endpoint(value)}`
            : 'défini',
        })
      }
    }
  }

  for (const name of optional) {
    record(
      process.env[name]
        ? { level: 'ok', label: name, detail: 'défini' }
        : {
            level: 'warn',
            label: name,
            detail: 'absent',
            hint:
              name === 'ANTHROPIC_API_KEY'
                ? "Le pipeline basculera sur le fournisseur synthétique, avec bannière dans l'interface."
                : 'Requis pour administrer le stockage Supabase.',
          },
    )
  }

  // A pooler in transaction mode on 6543 and a direct connection on 5432 are
  // two different things; using one for the other's job fails in ways that
  // look like a network problem.
  if (vercelFlagLooksPulled()) {
    record({
      level: 'warn',
      label: 'VERCEL=1 hors déploiement',
      detail: 'vient probablement de `vercel env pull`',
      hint:
        "Supprimez les lignes VERCEL* de .env.local : elles plafonnent l'import à 4,5 Mo " +
        'et mettent la file de jobs en mode envoi seul — les deux sont faux sur votre machine.',
    })
  }

  const app = process.env.DATABASE_URL
  const direct = process.env.DIRECT_URL
  if (app && direct && app === direct) {
    record({
      level: 'warn',
      label: 'DATABASE_URL et DIRECT_URL identiques',
      hint:
        'Les lectures applicatives passent par le pooler (6543), les migrations et le worker ' +
        'par la connexion directe (5432). Une seule chaîne pour les deux fonctionne, mais perd le pooling.',
    })
  }
}

// --------------------------------------------------------------------------
// Database
// --------------------------------------------------------------------------

/**
 * The connection string, or nothing — and a line saying which.
 *
 * Absent and malformed both mean "cannot connect", and neither is a reason to
 * abandon the remaining checks. The malformed case in particular used to end the
 * run with `Invalid URL` and no attribution, three sections short.
 */
function connectionString(name: string): string | null {
  if (unusable.has(name)) {
    record({ level: 'skip', label: `${name} illisible`, detail: 'contrôles ignorés' })
    return null
  }
  const value = process.env[name]
  if (!value) {
    record({ level: 'skip', label: `${name} absent`, detail: 'contrôles ignorés' })
    return null
  }
  return value
}

async function checkApplicationConnection(): Promise<void> {
  console.log('\n\x1b[1mConnexion applicative (lectures, RLS appliquée)\x1b[0m')

  const url = connectionString('DATABASE_URL')
  if (!url) return

  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  })

  try {
    const [row] = await sql<{ version: string }[]>`SELECT version() AS version`
    record({
      level: 'ok',
      label: `Connecté à ${endpoint(url)}`,
      detail: row?.version.split(' ').slice(0, 2).join(' '),
    })
  } catch (error) {
    record({
      level: 'fail',
      label: `Connexion à ${endpoint(url)} impossible`,
      detail: message(error),
      hint: "Vérifiez le mot de passe et que l'adresse IP est autorisée dans Supabase.",
    })
    await sql.end({ timeout: 5 })
    return
  }

  // Schema present?
  try {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('assertions', 'chapters', 'entities')
    `
    if ((row?.count ?? 0) === 3) {
      record({ level: 'ok', label: 'Schéma appliqué' })
    } else {
      record({
        level: 'fail',
        label: 'Schéma absent ou incomplet',
        detail: `${row?.count ?? 0}/3 tables clés`,
        hint: 'Lancez `pnpm db:push`.',
      })
      await sql.end({ timeout: 5 })
      return
    }
  } catch (error) {
    record({ level: 'fail', label: 'Lecture du schéma impossible', detail: message(error) })
    await sql.end({ timeout: 5 })
    return
  }

  /*
   * The check that matters.
   *
   * Reading `assertions` as `authenticated` without setting a boundary must
   * return nothing: app.boundary() falls back to -1 and no chapter is at or
   * below -1. If it returns rows, row-level security is not being enforced on
   * this connection — the application would work perfectly, and would show a
   * chapter 900 fact in a chapter 3 view.
   *
   * The comparison against the unfiltered count is the point. On an empty
   * database "nothing visible" is true for the wrong reason, and a check that
   * passes vacuously is worse than no check: it is a green tick that means
   * nothing. So the two counts are read separately, and if there is nothing to
   * hide, this says so rather than claiming a guarantee it did not test.
   */
  try {
    const visible = await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({
        sub: '00000000-0000-0000-0000-000000000000',
        role: 'authenticated',
      })}, true)`
      await tx.unsafe('SET LOCAL ROLE authenticated')
      const rows = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM assertions
      `
      return rows[0]?.count ?? 0
    })

    // Read the true total with the connection's own role, which owns the
    // tables and is therefore exempt.
    const [total] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM assertions
    `
    const stored = total?.count ?? 0

    if (visible > 0) {
      record({
        level: 'fail',
        label: 'FUITE : la RLS ne bloque pas cette connexion',
        detail: `${visible} assertions lisibles sans frontière posée`,
        hint:
          'Le rôle de connexion contourne les politiques (BYPASSRLS, ou propriétaire sans FORCE). ' +
          'Relancez `pnpm db:push` et vérifiez que la migration 0005 est appliquée.',
      })
    } else if (stored === 0) {
      record({
        level: 'warn',
        label: 'Frontière anti-spoiler : contrôle non concluant',
        detail: 'aucune assertion en base, il n’y a rien à masquer',
        hint: 'Importez un chapitre puis relancez : le contrôle deviendra significatif.',
      })
    } else {
      record({
        level: 'ok',
        label: 'Frontière anti-spoiler appliquée par la base',
        detail: `${stored} assertions stockées, 0 lisible sans frontière`,
      })
    }
  } catch (error) {
    record({
      level: 'fail',
      label: 'Contrôle de frontière impossible',
      detail: message(error),
      hint: "Le rôle `authenticated` existe-t-il ? Il est créé par la migration 0001.",
    })
  }

  await sql.end({ timeout: 5 })
}

async function checkDirectConnection(): Promise<void> {
  console.log('\n\x1b[1mConnexion directe (migrations, worker, pipeline)\x1b[0m')

  const url = connectionString('DIRECT_URL')
  if (!url) return

  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} })

  try {
    await sql`SELECT 1`
    record({ level: 'ok', label: `Connecté à ${endpoint(url)}` })
  } catch (error) {
    record({
      level: 'fail',
      label: `Connexion à ${endpoint(url)} impossible`,
      detail: message(error),
      hint:
        'La connexion vraiment directe de Supabase est en IPv6 uniquement. Utilisez le ' +
        'pooler en mode session (port 5432 sur le hôte pooler) si votre réseau est en IPv4.',
    })
    await sql.end({ timeout: 5 })
    return
  }

  try {
    const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations ORDER BY name`
    const missing = rows.length === 0
    record({
      level: missing ? 'fail' : 'ok',
      label: 'Migrations',
      detail: missing ? 'aucune appliquée' : `${rows.length} appliquées, dernière ${rows.at(-1)?.name}`,
      hint: missing ? 'Lancez `pnpm db:push`.' : undefined,
    })
  } catch {
    record({
      level: 'fail',
      label: 'Migrations',
      detail: 'table _migrations absente',
      hint: 'Lancez `pnpm db:push`.',
    })
  }

  // pgvector is present on Supabase and absent on the local CI Postgres; the
  // vector store adapts, so this is information, not a failure.
  try {
    const [row] = await sql<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS present
    `
    record({
      level: row?.present ? 'ok' : 'warn',
      label: 'pgvector',
      detail: row?.present ? 'disponible' : 'absent',
      hint: row?.present
        ? undefined
        : 'La recherche sémantique retombera sur des tableaux real[] et un cosinus SQL.',
    })
  } catch (error) {
    record({ level: 'warn', label: 'pgvector', detail: message(error) })
  }

  try {
    const roles = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'app_ingest', 'anon')
    `
    const found = roles.map((r) => r.rolname)
    const needed = ['authenticated', 'app_ingest'].filter((r) => !found.includes(r))
    record({
      level: needed.length === 0 ? 'ok' : 'fail',
      label: 'Rôles SQL',
      detail: found.join(', ') || 'aucun',
      hint: needed.length === 0 ? undefined : `Manquant : ${needed.join(', ')}. Lancez \`pnpm db:push\`.`,
    })
  } catch (error) {
    record({ level: 'warn', label: 'Rôles SQL', detail: message(error) })
  }

  await sql.end({ timeout: 5 })
}

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

async function checkStorage(): Promise<void> {
  console.log('\n\x1b[1mStockage\x1b[0m')

  const driver = process.env.STORAGE_DRIVER ?? 'supabase'
  if (driver === 'local') {
    record({
      level: 'warn',
      label: 'Pilote local',
      detail: process.env.LOCAL_STORAGE_ROOT ?? './var/storage',
      hint: "Destiné aux tests. En production, utilisez le bucket privé Supabase.",
    })
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'chapters'

  if (!url || !key) {
    record({
      level: 'skip',
      label: 'Bucket',
      detail: 'URL ou clé de service absente',
      hint: 'SUPABASE_SERVICE_ROLE_KEY est nécessaire pour vérifier la confidentialité du bucket.',
    })
    return
  }

  try {
    const { SupabaseStorage } = await import('../src/domains/storage/supabase-storage.ts')
    const storage = new SupabaseStorage({
      url,
      serviceRoleKey: key,
      bucket,
      defaultTtl: 60,
    })
    await storage.verifyBucketIsPrivate()
    record({ level: 'ok', label: `Bucket « ${bucket} »`, detail: 'existe et est privé' })
  } catch (error) {
    record({
      level: 'fail',
      label: `Bucket « ${bucket} »`,
      detail: message(error),
    })
  }
}

// --------------------------------------------------------------------------
// Model provider
// --------------------------------------------------------------------------

async function checkModelProvider(): Promise<void> {
  console.log('\n\x1b[1mFournisseur de modèle\x1b[0m')

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    record({
      level: 'warn',
      label: 'Aucune clé Anthropic',
      detail: 'bascule sur le fournisseur synthétique',
      hint: "L'extraction affichée sera générée, pas issue des pages — et l'interface le dira.",
    })
    return
  }

  /*
   * countTokens is free and exercises the whole path: credentials, network,
   * proxy, and the model id being one the account can reach. A real completion
   * would cost money to learn the same thing.
   */
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key })
    const model = process.env.MODEL_EXTRACT ?? 'claude-sonnet-5'
    const count = await client.messages.countTokens({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    })
    record({
      level: 'ok',
      label: `API Anthropic joignable`,
      detail: `${model}, ${count.input_tokens} tokens pour un appel témoin`,
    })
  } catch (error) {
    record({
      level: 'fail',
      label: 'API Anthropic injoignable',
      detail: message(error),
      hint: 'Clé invalide, quota épuisé, ou modèle inaccessible pour ce compte.',
    })
  }
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\x1b[1mOne Piece Explorer — diagnostic\x1b[0m')

  checkVariables()
  await checkApplicationConnection()
  await checkDirectConnection()
  await checkStorage()
  await checkModelProvider()

  const failures = results.filter((r) => r.level === 'fail')
  const warnings = results.filter((r) => r.level === 'warn')

  console.log()
  if (failures.length === 0) {
    console.log(
      `\x1b[32mPrêt.\x1b[0m ${warnings.length} avertissement${warnings.length === 1 ? '' : 's'}.`,
    )
  } else {
    console.log(
      `\x1b[31m${failures.length} problème${failures.length === 1 ? '' : 's'} à corriger\x1b[0m ` +
        `(${warnings.length} avertissement${warnings.length === 1 ? '' : 's'}).`,
    )
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('\nLe diagnostic a échoué :', message(error))
  process.exit(1)
})
