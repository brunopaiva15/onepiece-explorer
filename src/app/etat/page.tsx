import type { Metadata } from 'next'
import Link from 'next/link'
import postgres from 'postgres'
import { connectionStringIssue } from '@/lib/connection-string.ts'

export const metadata: Metadata = { title: 'État du déploiement' }
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `pnpm doctor`, in the browser, for the one moment you cannot run it.
 *
 * A first deployment fails in a handful of ways and all of them look identical
 * from outside: "A server error occurred". Every page in this application
 * resolves a session, every session reads the configuration and opens a
 * database connection, so one missing variable takes down the entire site at
 * once — including any page that could have explained why.
 *
 * Hence this page, and its one design rule: **it must not depend on anything it
 * is checking.** No `env()`, which throws on the very failure being diagnosed.
 * No session, no Supabase client, no Drizzle, no `withBoundary`. It reads
 * `process.env` directly and opens its own short-lived connection, so it keeps
 * working when nothing else does.
 *
 * It is reachable without signing in, because authentication is one of the
 * things that breaks. That is safe as long as it stays disciplined about what it
 * says: presence or absence, never a value; "answered" or "did not answer",
 * never a host name. Someone who finds this page learns that the site is
 * misconfigured, which they already knew from the error, and nothing else.
 */

interface Check {
  label: string
  state: 'ok' | 'warn' | 'fail'
  detail: string
}

/** Set, and non-empty. Never the value — not truncated, not hashed, not hinted. */
function presence(name: string): boolean {
  return (process.env[name] ?? '').trim().length > 0
}

interface SchemaReport {
  /** Null when the connection did not answer; the failure is reported elsewhere. */
  reachable: boolean
  /** Last row of `_migrations`, or null when the table itself is absent. */
  lastMigration: string | null
  appliedCount: number
  /** Tables the code expects and the database does not have. */
  missingTables: string[]
}

/**
 * Is the schema behind the code?
 *
 * The question that "everything responds and one page still fails" always turns
 * out to be. Migrations are not applied by a deployment — nothing in a serverless
 * host runs them — so a database can sit several versions behind indefinitely
 * while every connection check passes.
 *
 * Expected tables come from the Drizzle schema rather than a hand-kept list, so
 * adding a table updates this automatically. That module is pure table
 * definitions: no `env()`, no connection, nothing this page must avoid.
 */
async function schemaState(url: string | undefined): Promise<SchemaReport> {
  const absent: SchemaReport = {
    reachable: false,
    lastMigration: null,
    appliedCount: 0,
    missingTables: [],
  }
  if (!url) return absent

  const [{ getTableName, is }, { PgTable }, schema] = await Promise.all([
    import('drizzle-orm'),
    import('drizzle-orm/pg-core'),
    import('@/db/schema/index.ts'),
  ])

  const expected = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => getTableName(table as never))
    .sort()

  let sql: ReturnType<typeof postgres> | null = null
  try {
    sql = postgres(url, {
      max: 1,
      connect_timeout: 8,
      idle_timeout: 2,
      prepare: false,
      onnotice: () => {},
    })

    const present = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `
    const have = new Set(present.map((row) => row.table_name))

    const migrations = await sql<Array<{ name: string }>>`
      SELECT name FROM _migrations ORDER BY name
    `.catch(() => [] as Array<{ name: string }>)

    return {
      reachable: true,
      lastMigration: migrations.at(-1)?.name ?? null,
      appliedCount: migrations.length,
      missingTables: expected.filter((name) => !have.has(name)),
    }
  } catch {
    return absent
  } finally {
    await sql?.end({ timeout: 3 }).catch(() => undefined)
  }
}

async function connects(url: string | undefined): Promise<string | null> {
  // Before dialling: is this a connection string at all? The driver answers
  // `Invalid URL` and names neither the variable nor the character at fault.
  const target = url?.trim() ?? ''
  const issue = connectionStringIssue(target)
  if (issue) return issue.fix ? `${issue.problem}. ${issue.fix}` : issue.problem

  let sql: ReturnType<typeof postgres> | null = null
  try {
    sql = postgres(target, {
      max: 1,
      connect_timeout: 8,
      idle_timeout: 2,
      // The application connection runs through Supavisor in transaction mode,
      // where prepared statements are not available. Using the same setting here
      // means a success proves the real path works rather than a friendlier one.
      prepare: false,
      onnotice: () => {},
    })
    await sql`SELECT 1`
    return null
  } catch (error: unknown) {
    // The driver's message names the failure mode — a bad password, a timeout,
    // an unknown host — without containing the credentials.
    return error instanceof Error ? error.message : String(error)
  } finally {
    await sql?.end({ timeout: 3 }).catch(() => undefined)
  }
}

export default async function StatePage() {
  const checks: Check[] = []

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'DATABASE_URL',
    'DIRECT_URL',
  ]

  for (const name of required) {
    checks.push({
      label: name,
      state: presence(name) ? 'ok' : 'fail',
      detail: presence(name) ? 'définie' : 'ABSENTE — chaque page échouera',
    })
  }

  checks.push({
    label: 'SUPABASE_SERVICE_ROLE_KEY',
    state: presence('SUPABASE_SERVICE_ROLE_KEY') ? 'ok' : 'warn',
    detail: presence('SUPABASE_SERVICE_ROLE_KEY')
      ? 'définie'
      : "absente — l'import et l'affichage des pages échoueront, la lecture du graphe non",
  })

  for (const [name, note] of [
    ['ANTHROPIC_API_KEY', "absente — extraction synthétique, avec bannière"],
    ['ASSISTANT_ENABLED', 'absente — /ask est éteint, et rien ne se facture'],
    ['PUBLIC_LIBRARY_OWNER_ID', 'absente — le site est privé'],
  ] as const) {
    checks.push({
      label: name,
      state: 'ok',
      detail: presence(name) ? 'définie' : note,
    })
  }

  /*
   * NEXT_PUBLIC_* are inlined into the bundle at build time.
   *
   * The most confusing first-deploy failure there is: the variables are visibly
   * present in the dashboard, and the deployment still fails, because it was
   * built before they were saved. Nothing in the running code can tell the two
   * apart — so this says so rather than pretending to know.
   */
  const [appConnection, directConnection, schema] = await Promise.all([
    connects(process.env.DATABASE_URL),
    connects(process.env.DIRECT_URL),
    schemaState(process.env.DIRECT_URL),
  ])

  checks.push({
    label: 'Connexion applicative (DATABASE_URL)',
    state: appConnection === null ? 'ok' : 'fail',
    detail: appConnection === null ? 'répond' : appConnection,
  })
  checks.push({
    label: 'Connexion directe (DIRECT_URL)',
    state: directConnection === null ? 'ok' : 'fail',
    detail: directConnection === null ? 'répond' : directConnection,
  })

  if (schema.reachable) {
    checks.push({
      label: 'Schéma de la base',
      state: schema.missingTables.length === 0 ? 'ok' : 'fail',
      detail:
        schema.missingTables.length === 0
          ? `à jour — ${schema.appliedCount} migration(s), la dernière étant ${schema.lastMigration ?? 'inconnue'}`
          : `EN RETARD — table(s) absente(s) : ${schema.missingTables.join(', ')}. ` +
            `Dernière migration appliquée : ${schema.lastMigration ?? 'aucune'}.`,
    })
  }

  const broken = checks.filter((check) => check.state === 'fail')

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-primary">État du déploiement</h1>
      <p className="mt-3 max-w-2xl text-secondary">
        Cette page ne dépend d&apos;aucune des choses qu&apos;elle contrôle : ni
        de la configuration validée, ni d&apos;une session, ni du client
        Supabase. C&apos;est ce qui lui permet de répondre quand tout le reste
        renvoie une erreur serveur. Elle n&apos;affiche jamais une valeur —
        seulement si elle est là.
      </p>

      {broken.length === 0 ? (
        <p className="mt-8 rounded-sm border border-line bg-surface-raised p-4 text-primary">
          Tout répond et le schéma est à jour. Si une page échoue malgré ça, le
          message complet est dans les journaux d&apos;exécution de
          l&apos;hébergeur — la page en erreur affiche une référence à y
          chercher.
        </p>
      ) : (
        <div className="mt-8 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4">
          <p className="font-medium text-primary">
            {broken.length} problème(s) à corriger.
          </p>
          {schema.missingTables.length > 0 && (
            <p className="mt-2 text-sm text-primary">
              Le schéma est en retard sur le code. Depuis votre machine, avec le{' '}
              <code>DIRECT_URL</code> de production dans{' '}
              <code>.env.local</code> :{' '}
              <code className="text-accent">pnpm db:push</code>, puis{' '}
              <code>pnpm doctor</code>. Rien ne l&apos;applique au
              déploiement&nbsp;: c&apos;est délibéré — une migration qui
              s&apos;exécute à chaud pendant qu&apos;une ancienne version tourne
              encore est le pire moment pour la lancer.
            </p>
          )}
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-secondary">
            {broken.map((check) => (
              <li key={check.label}>
                <span className="font-mono text-xs text-primary">{check.label}</span>{' '}
                — {check.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="mt-10 divide-y divide-[var(--border)] text-sm">
        {checks.map((check) => (
          <div key={check.label} className="flex flex-wrap items-baseline gap-x-3 py-2.5">
            <dt className="font-mono text-xs text-primary">{check.label}</dt>
            <dd
              className="ml-auto text-xs"
              style={{
                color:
                  check.state === 'fail'
                    ? 'var(--epi-contradicted)'
                    : check.state === 'warn'
                      ? 'var(--epi-hypothetical)'
                      : undefined,
              }}
            >
              {check.detail}
            </dd>
          </div>
        ))}
      </dl>

      <section className="mt-12 border-t border-line pt-8 text-sm text-secondary">
        <h2 className="text-lg font-semibold text-primary">
          Les causes habituelles, dans l&apos;ordre
        </h2>
        <ol className="mt-3 list-decimal space-y-3 pl-5">
          <li>
            <strong className="font-medium text-primary">
              Un caractère réservé dans le mot de passe.
            </strong>{' '}
            Une chaîne de connexion est une URL, et l&apos;URL réserve{' '}
            <code>#</code>, <code>/</code> et <code>?</code>. Un mot de passe qui
            en contient un rend la chaîne illisible sans que rien ne dise lequel.
            Encodez-le dans la chaîne — <code>%23</code>, <code>%2F</code>,{' '}
            <code>%3F</code> — sans toucher au mot de passe dans Supabase.
          </li>
          <li>
            <strong className="font-medium text-primary">
              Une variable manquante au moment du build.
            </strong>{' '}
            <code>NEXT_PUBLIC_SUPABASE_URL</code> et{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> sont insérées dans le
            bundle à la compilation. Les ajouter après un déploiement ne suffit
            pas : il faut <em>redéployer</em>. Vérifiez aussi qu&apos;elles
            couvrent l&apos;environnement déployé (Production comme Preview).
          </li>
          <li>
            <strong className="font-medium text-primary">
              La mauvaise chaîne de connexion.
            </strong>{' '}
            La connexion vraiment directe de Supabase (<code>db.…</code>) est en
            IPv6 uniquement et un hébergeur en IPv4 ne l&apos;atteindra jamais.
            Utilisez les chaînes du <em>pooler</em> : port 6543 en mode
            transaction pour <code>DATABASE_URL</code>, port 5432 en mode session
            pour <code>DIRECT_URL</code>.
          </li>
          <li>
            <strong className="font-medium text-primary">
              Un schéma en retard.
            </strong>{' '}
            Les migrations ne s&apos;appliquent pas au déploiement. Lancez{' '}
            <code>pnpm db:push</code> depuis votre machine avec le{' '}
            <code>DIRECT_URL</code> de production, puis <code>pnpm doctor</code>.
          </li>
        </ol>
        <p className="mt-4">
          La cause 2 ne concerne qu&apos;un déploiement : en local, les variables
          sont relues à chaque démarrage — il suffit de redémarrer{' '}
          <code>pnpm dev</code>. Et sur votre machine,{' '}
          <code>pnpm doctor</code> dit la même chose que cette page en plus
          détaillé : il essaie chaque connexion et affiche l&apos;hôte
          qu&apos;il a réellement extrait.
        </p>
      </section>

      <p className="mt-10 text-sm text-muted">
        <Link href="/" className="text-accent hover:underline">
          Retour à l&apos;accueil
        </Link>
      </p>
    </main>
  )
}
