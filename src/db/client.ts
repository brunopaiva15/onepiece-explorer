import 'server-only'
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema/index.ts'

/**
 * Database connections.
 *
 * Nothing outside src/db should import from this file — an ESLint rule
 * enforces it. Every read goes through withBoundary() in ./boundary.ts,
 * because the chapter boundary is a per-transaction session variable and a
 * query issued outside that wrapper sees nothing (ADR 0001).
 *
 * Three roles, three purposes:
 *
 *   appDb()    — application reads, via Supavisor in TRANSACTION mode.
 *                Runs as `authenticated`; row-level security applies.
 *   ingestDb() — pipeline, publication and migrations, via the DIRECT
 *                connection. Runs as `app_ingest`; exempt from the boundary
 *                because it writes proposals that are not yet accepted and
 *                computes deltas across the whole corpus.
 *
 * Both are built on first use, not at module load. `next build` imports every
 * route to collect page data, so a connection created at import time would
 * make the build require a configured database — which it does not need and
 * often will not have, since a deployment pipeline builds the image before the
 * secrets are attached. Failing at request time gives the same protection with
 * an error the reader can act on.
 */

type Db = PostgresJsDatabase<typeof schema>

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} n'est pas configuré. Copiez .env.example vers .env.local et renseignez la connexion Supabase.`,
    )
  }
  return value
}

function isTest(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.TEST_DB === '1'
}

/**
 * A runtime that multiplies instances behind one database.
 *
 * Pool sizes are written for a process you can count. Here you cannot: a burst
 * of requests becomes a burst of instances, each with a pool of its own, and
 * the database's connection slots are shared between all of them. So both pools
 * are sized per instance, small, and released quickly.
 */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL ?? process.env.AWS_LAMBDA_FUNCTION_NAME)
}

let appSqlCache: postgres.Sql | null = null
let ingestSqlCache: postgres.Sql | null = null
let appDbCache: Db | null = null
let ingestDbCache: Db | null = null

export function appSql(): postgres.Sql {
  if (appSqlCache) return appSqlCache

  const url = isTest()
    ? required('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL)
    : required('DATABASE_URL', process.env.DATABASE_URL)

  const serverless = isServerless()

  /**
   * `prepare: false` is mandatory against Supavisor in transaction mode: the
   * pooler hands the connection to another client between transactions, so a
   * prepared statement cached on the client would reference a plan that no
   * longer exists on the server.
   *
   * Ten per instance was a ceiling on nothing.
   *
   * A page render holds several of these at once — story mode reads a chapter
   * per connection — so ten was roughly two renders' worth, and every instance
   * that had ever served a request kept up to ten open for twenty seconds after
   * finishing. Instances multiply on their own, and the slots belong to the
   * database rather than to any one of them: a few seconds of a reader dragging
   * the chapter slider, which re-renders a dynamic page per step, was enough to
   * reach « remaining connection slots are reserved for roles with the
   * SUPERUSER attribute » — an error about a database that is perfectly
   * healthy, on every page at once, for as long as the instances stayed warm.
   *
   * Four, released after five seconds. Four is above what any single request
   * needs — nothing here nests two boundary transactions, and story mode caps
   * its window at three — so a page is never waiting on its own pool, and the
   * arithmetic across warm instances stays survivable. It is still an override,
   * because the real ceiling belongs to the database rather than to this file.
   */
  appSqlCache = postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? (serverless ? 4 : 10)),
    prepare: false,
    idle_timeout: serverless ? 5 : 20,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return appSqlCache
}

export function ingestSql(): postgres.Sql {
  if (ingestSqlCache) return ingestSqlCache

  const url = isTest()
    ? required('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL)
    : required('DIRECT_URL', process.env.DIRECT_URL ?? process.env.DATABASE_URL)

  /*
   * Direct connection: long-lived, prepared statements are fine and useful —
   * on a machine you own, where this process is the only one holding it.
   *
   * Serverless is the opposite arrangement, and the default was written for the
   * first. Supabase's session-mode pooler allows fifteen clients for the whole
   * project; every warm instance keeps up to `max` of them open for the idle
   * timeout, and instances multiply on their own. Four each is three instances
   * before the sixteenth request is refused — and every page takes one, because
   * resolving the reader's session reads the profile through this role.
   *
   * The symptom is not subtle and it is not local: « max clients reached in
   * session mode », on /etat, about a database that is perfectly healthy.
   *
   * One connection per instance, released in five seconds, is what a serverless
   * runtime should hold: an invocation uses it and gives it back. It is still
   * an override, because the ceiling belongs to the project rather than to the
   * code — a pool raised in Supabase should be usable from here without a
   * deploy.
   */
  const serverless = isServerless()

  ingestSqlCache = postgres(url, {
    max: Number(process.env.DB_INGEST_POOL_MAX ?? (serverless ? 1 : 4)),
    idle_timeout: serverless ? 5 : 30,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return ingestSqlCache
}

export function appDb(): Db {
  appDbCache ??= drizzle(appSql(), { schema })
  return appDbCache
}

export function ingestDb(): Db {
  ingestDbCache ??= drizzle(ingestSql(), { schema })
  return ingestDbCache
}

/** Close both pools. For the worker's shutdown path and for test teardown. */
export async function closeConnections(): Promise<void> {
  await Promise.all([
    appSqlCache?.end({ timeout: 5 }),
    ingestSqlCache?.end({ timeout: 5 }),
  ])
  appSqlCache = null
  ingestSqlCache = null
  appDbCache = null
  ingestDbCache = null
}

export { schema }
