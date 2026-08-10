import 'server-only'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
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
 *   appSql     — application reads, via Supavisor in TRANSACTION mode.
 *                Runs as `authenticated`; row-level security applies.
 *   ingestSql  — pipeline, publication and migrations, via the DIRECT
 *                connection. Runs as `app_ingest`; exempt from the boundary
 *                because it writes proposals that are not yet accepted and
 *                computes deltas across the whole corpus.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} n'est pas configuré. Copiez .env.example vers .env.local et renseignez la connexion Supabase.`,
    )
  }
  return value
}

const isTest = process.env.NODE_ENV === 'test' || process.env.TEST_DB === '1'

const appUrl = isTest
  ? required('TEST_DATABASE_URL', process.env.TEST_DATABASE_URL)
  : required('DATABASE_URL', process.env.DATABASE_URL)

const directUrl = isTest
  ? appUrl
  : required('DIRECT_URL', process.env.DIRECT_URL ?? process.env.DATABASE_URL)

/**
 * `prepare: false` is mandatory against Supavisor in transaction mode: the
 * pooler hands the connection to another client between transactions, so a
 * prepared statement cached on the client would reference a plan that no
 * longer exists on the server.
 */
export const appSql = postgres(appUrl, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
})

/** Direct connection: long-lived, prepared statements are fine and useful. */
export const ingestSql = postgres(directUrl, {
  max: Number(process.env.DB_INGEST_POOL_MAX ?? 4),
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
})

export const appDb = drizzle(appSql, { schema })
export const ingestDb = drizzle(ingestSql, { schema })

export { schema }
