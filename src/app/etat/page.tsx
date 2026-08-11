import type { Metadata } from 'next'
import Link from 'next/link'
import postgres from 'postgres'

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

async function connects(url: string | undefined): Promise<string | null> {
  if (!url) return "la variable n'est pas définie"
  let sql: ReturnType<typeof postgres> | null = null
  try {
    sql = postgres(url, {
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
  const [appConnection, directConnection] = await Promise.all([
    connects(process.env.DATABASE_URL),
    connects(process.env.DIRECT_URL),
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
          Tout répond. Si une page échoue malgré ça, la cause est ailleurs : le
          plus probable est un schéma de base en retard —{' '}
          <code>pnpm db:push</code> depuis votre machine, avec le même{' '}
          <code>DIRECT_URL</code>.
        </p>
      ) : (
        <div className="mt-8 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4">
          <p className="font-medium text-primary">
            {broken.length} problème(s) suffisant(s) à faire échouer toutes les
            pages.
          </p>
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
          Les trois causes, dans l&apos;ordre
        </h2>
        <ol className="mt-3 list-decimal space-y-3 pl-5">
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
      </section>

      <p className="mt-10 text-sm text-muted">
        <Link href="/" className="text-accent hover:underline">
          Retour à l&apos;accueil
        </Link>
      </p>
    </main>
  )
}
