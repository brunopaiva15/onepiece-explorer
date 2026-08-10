import 'server-only'
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { appDb, ingestDb, schema } from './client.ts'

/**
 * The one way the application reads knowledge.
 *
 * Every read runs inside a transaction that declares who is asking and how far
 * they have read. Row-level security does the rest — see ADR 0001. Three
 * details in here are load-bearing and none of them are obvious:
 *
 *  1. `SET LOCAL ROLE authenticated`. The connection's owning role has
 *     BYPASSRLS. Without switching role, every policy is inert and the app
 *     silently returns unfiltered data while looking perfectly correct.
 *
 *  2. `request.jwt.claims` is set here, from a uid the caller has already
 *     verified server-side. auth.uid() reads it. It must never come from a
 *     client-supplied value.
 *
 *  3. `SET LOCAL`, always inside a transaction, and via set_config() so the
 *     value is a bound parameter rather than string-concatenated SQL. With
 *     Supavisor in transaction mode the connection is handed to the next
 *     request the moment the transaction commits; a session-level SET would
 *     leak this user's identity and boundary onto someone else's query.
 */

export type BoundaryDb = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>

export interface BoundaryContext {
  /** Verified via supabase.auth.getUser() — never taken from the request body. */
  userId: string
  /** Reader position. Clamped before use; see resolveBoundary(). */
  boundaryChapter: number
}

/** Postgres integer ceiling — a boundary above any real chapter number. */
const MAX_BOUNDARY = 2_147_483_647

export class InvalidBoundaryError extends Error {
  constructor(value: unknown) {
    super(`Chapitre-frontière invalide : ${String(value)}`)
    this.name = 'InvalidBoundaryError'
  }
}

/**
 * Coerce an untrusted boundary into a safe integer.
 *
 * Fail-closed on anything unparseable: a malformed value must never widen
 * what the reader can see. Callers that know the library's extent should clamp
 * further with `max`.
 */
export function resolveBoundary(value: unknown, max?: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN

  if (!Number.isFinite(n)) throw new InvalidBoundaryError(value)

  const floored = Math.floor(n)
  const ceiling = max === undefined ? MAX_BOUNDARY : Math.min(max, MAX_BOUNDARY)
  return Math.max(0, Math.min(floored, ceiling))
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Run `fn` with row-level security active, scoped to one user and one
 * chapter boundary.
 *
 * Anything read inside is already filtered: assertions revealed later, labels
 * not yet introduced, pages of unreached chapters and other users' rows are
 * simply not there.
 */
export async function withBoundary<T>(
  ctx: BoundaryContext,
  fn: (db: BoundaryDb) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.userId)) {
    throw new Error(`Identifiant utilisateur invalide : ${ctx.userId}`)
  }
  const boundary = resolveBoundary(ctx.boundaryChapter)
  const claims = JSON.stringify({ sub: ctx.userId, role: 'authenticated' })

  return appDb().transaction(async (tx) => {
    // Parameterised, not interpolated. The third argument makes each setting
    // local to this transaction so nothing survives onto a pooled connection.
    await tx.execute(
      sql`SELECT set_config('request.jwt.claims', ${claims}, true)`,
    )
    await tx.execute(
      sql`SELECT set_config('app.boundary_chapter', ${String(boundary)}, true)`,
    )
    // A role name cannot be a bind parameter; this is a fixed literal.
    await tx.execute(sql`SET LOCAL ROLE authenticated`)

    return fn(tx)
  })
}

/**
 * Run `fn` as the ingestion role, exempt from the boundary.
 *
 * For the pipeline, publication and delta computation only — all of which
 * legitimately need to see proposals that are not yet accepted and chapters
 * beyond the reader's position. Never use it to serve a user-facing read:
 * that is exactly the mistake row-level security exists to prevent.
 */
export async function withIngest<T>(
  fn: (db: BoundaryDb) => Promise<T>,
): Promise<T> {
  return ingestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_ingest`)
    return fn(tx)
  })
}

/**
 * Run `fn` with permission to delete append-only rows.
 *
 * Only the chapter-deletion path should use this, and only after writing an
 * audit entry. The opt-in is explicit so that "we deleted history" is always a
 * deliberate act that shows up in a diff.
 */
export async function withDestructive<T>(
  reason: string,
  fn: (db: BoundaryDb) => Promise<T>,
): Promise<T> {
  if (!reason.trim()) {
    throw new Error('Une opération destructive doit être justifiée.')
  }
  return ingestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_ingest`)
    await tx.execute(sql`SELECT set_config('app.allow_destructive', 'on', true)`)
    return fn(tx)
  })
}
