import type { Metadata } from 'next'
import Link from 'next/link'
import postgres from 'postgres'
import { connectionStringIssue } from '@/lib/connection-string.ts'
import { vercelFlagLooksPulled } from '@/lib/hosting.ts'
// The only i18n imports this page may use: getDict degrades to the cookie and
// then to French rather than throwing, so it cannot take this page down with
// the very failure it diagnoses. No session imports here.
import { getDict } from '@/lib/i18n/server.ts'
import type { Dict } from '@/lib/i18n/dictionaries.ts'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.etat.metaTitle }
}
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

/** Why the Supabase URL is not one, in the terms of the fix. */
function urlProblem(value: string | undefined, t: Dict['etat']): string | null {
  const raw = value?.trim() ?? ''
  if (/^["']|["']$/.test(raw)) return t.urlQuoted

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw.includes('://') ? t.urlNotUrl : t.urlNoScheme
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return t.urlBadScheme(parsed.protocol)
  }
  if (!parsed.hostname.includes('.')) return t.urlNoDomain
  return null
}

export default async function StatePage() {
  const dict = await getDict()
  const t = dict.etat
  const checks: Check[] = []

  const required = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'DATABASE_URL',
    'DIRECT_URL',
  ]

  for (const name of required) {
    if (!presence(name)) {
      checks.push({ label: name, state: 'fail', detail: t.requiredMissing })
      continue
    }
    /*
     * Present is not the same as usable, and this page reported the first as
     * though it were the second: "définie", "Tout répond", while every page
     * returned 500 because the URL was not a URL. A diagnostic that says
     * everything is fine while nothing works is worse than no diagnostic — it
     * sends the search somewhere else.
     *
     * The two connection strings are checked by dialling them, below. The
     * Supabase URL has no such proof, so its shape is checked here.
     */
    const problem =
      name === 'NEXT_PUBLIC_SUPABASE_URL' ? urlProblem(process.env[name], t) : null
    checks.push({
      label: name,
      state: problem ? 'fail' : 'ok',
      detail: problem ?? t.present,
    })
  }

  if (vercelFlagLooksPulled()) {
    checks.push({
      label: 'VERCEL',
      state: 'warn',
      /*
       * `vercel env pull` writes the platform's system variables into the file
       * it produces. On a laptop they are all false, and they are read: the
       * upload ceiling drops to the 4.5 MB a serverless request can carry —
       * the exact ceiling the local setup exists to escape.
       */
      detail: t.vercelWarn,
    })
  }

  checks.push({
    label: 'SUPABASE_SERVICE_ROLE_KEY',
    state: presence('SUPABASE_SERVICE_ROLE_KEY') ? 'ok' : 'warn',
    detail: presence('SUPABASE_SERVICE_ROLE_KEY') ? t.present : t.serviceRoleMissing,
  })

  for (const [name, note] of [
    ['ANTHROPIC_API_KEY', t.anthropicMissing],
    ['ASSISTANT_ENABLED', t.assistantMissing],
    ['PUBLIC_LIBRARY_OWNER_ID', t.publicIdMissing],
  ] as const) {
    checks.push({
      label: name,
      state: 'ok',
      detail: presence(name) ? t.present : note,
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
    label: t.appConnectionLabel,
    state: appConnection === null ? 'ok' : 'fail',
    detail: appConnection === null ? t.answers : appConnection,
  })
  checks.push({
    label: t.directConnectionLabel,
    state: directConnection === null ? 'ok' : 'fail',
    detail: directConnection === null ? t.answers : directConnection,
  })

  if (schema.reachable) {
    checks.push({
      label: t.schemaLabel,
      state: schema.missingTables.length === 0 ? 'ok' : 'fail',
      detail:
        schema.missingTables.length === 0
          ? t.schemaUpToDate(schema.appliedCount, schema.lastMigration)
          : t.schemaBehind(schema.missingTables, schema.lastMigration),
    })
  }

  const broken = checks.filter((check) => check.state === 'fail')

  return (
    <main id="contenu" className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold text-primary">{t.title}</h1>
      <p className="mt-3 max-w-2xl text-secondary">{t.intro}</p>

      {broken.length === 0 ? (
        <p className="mt-8 rounded-sm border border-line bg-surface-raised p-4 text-primary">
          {t.allOk}
        </p>
      ) : (
        <div className="mt-8 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4">
          <p className="font-medium text-primary">
            {t.problemCount(broken.length)}
          </p>
          {schema.missingTables.length > 0 && (
            <p className="mt-2 text-sm text-primary">
              {t.schemaFixLead}{' '}
              <code>DIRECT_URL</code>{' '}
              {t.schemaFixMid}{' '}
              <code>.env.local</code>
              {t.schemaFixColon}{' '}
              <code className="text-accent">pnpm db:push</code>
              {t.schemaFixThen}{' '}
              <code>pnpm doctor</code>
              {t.schemaFixTail}
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
        <h2 className="text-lg font-semibold text-primary">{t.causesHeading}</h2>
        <ol className="mt-3 list-decimal space-y-3 pl-5">
          <li>
            <strong className="font-medium text-primary">{t.cause1Strong}</strong>{' '}
            {t.cause1Lead}{' '}
            <code>#</code>, <code>/</code> {t.andWord} <code>?</code>
            {t.cause1Mid}{' '}
            <code>%23</code>, <code>%2F</code>, <code>%3F</code>
            {t.cause1Tail}
          </li>
          <li>
            <strong className="font-medium text-primary">{t.cause2Strong}</strong>{' '}
            <code>NEXT_PUBLIC_SUPABASE_URL</code> {t.andWord}{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> {t.cause2Mid}{' '}
            <em>{t.redeployEm}</em>
            {t.cause2Tail}
          </li>
          <li>
            <strong className="font-medium text-primary">{t.cause3Strong}</strong>{' '}
            {t.cause3Lead} (<code>db.…</code>) {t.cause3Mid} <em>pooler</em>
            {t.cause3Mid2} <code>DATABASE_URL</code>
            {t.cause3Mid3} <code>DIRECT_URL</code>.
          </li>
          <li>
            <strong className="font-medium text-primary">{t.cause4Strong}</strong>{' '}
            {t.cause4Lead} <code>pnpm db:push</code> {t.cause4Mid}{' '}
            <code>DIRECT_URL</code>
            {t.cause4Mid2} <code>pnpm doctor</code>.
          </li>
        </ol>
        <p className="mt-4">
          {t.closingLead} <code>pnpm dev</code>
          {t.closingMid} <code>pnpm doctor</code>
          {t.closingTail}
        </p>
      </section>

      <p className="mt-10 text-sm text-muted">
        <Link href="/" className="text-accent hover:underline">
          {t.backHome}
        </Link>
      </p>
    </main>
  )
}
