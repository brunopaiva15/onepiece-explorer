import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
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
    /*
     * Three settings, one round trip.
     *
     * These were three separate `execute` calls, which is three sequential
     * network waits before the transaction had read anything. A page opens ten
     * or so boundaries, so that was twenty round trips spent on setup alone —
     * on a function and a database in different regions, most of a second.
     *
     * `role` is set through set_config rather than `SET LOCAL ROLE` because a
     * role name cannot be a bind parameter, and putting the three in one
     * statement is worth more than the literal. It is the same GUC either way:
     * `SET ROLE x` and `set_config('role', 'x', ...)` are the same operation,
     * which is how PostgREST does it too.
     *
     * The third argument is what makes each setting local to this transaction,
     * so nothing survives onto a pooled connection handed to the next request.
     * Getting that wrong would leak this reader's identity and position onto
     * someone else's query — tests/db cover exactly that.
     */
    await tx.execute(sql`
      SELECT
        set_config('request.jwt.claims', ${claims}, true),
        set_config('app.boundary_chapter', ${String(boundary)}, true),
        set_config('role', 'authenticated', true)
    `)

    return fn(tx)
  })
}

/**
 * The ingest transaction this async context is already inside, if any.
 *
 * A transaction holds its connection for as long as it runs. So a withIngest()
 * nested inside another one asks the ingest pool for a *second* connection
 * while the first is held by the code waiting for it — and if the pool has no
 * second connection to give, the two halves wait for each other forever.
 *
 * That is not hypothetical and it is not rare: publishDecisions() opens a
 * transaction and calls rebuildRefTable(), which opens its own. It worked only
 * because the pool was four deep. Sizing it to one — which is what a serverless
 * runtime should hold against a fifteen-client pooler — turned a latent nesting
 * into « Publication… » forever, and left the instance's only connection
 * checked out, so every later page that resolves a session through this role
 * hung behind it too.
 *
 * Widening the pool would only raise the number of concurrent publications
 * needed to reproduce it. The nesting itself is the defect, and the fix is for
 * a nested call to *join* the transaction already open rather than ask for
 * another connection: same role, same visibility, same commit.
 */
interface OpenIngest {
  tx: BoundaryDb
  /** Set once the transaction has settled — see the check in withIngest(). */
  done: boolean
}

const openIngest = new AsyncLocalStorage<OpenIngest>()

/**
 * Run `fn` as the ingestion role, exempt from the boundary.
 *
 * For the pipeline, publication and delta computation only — all of which
 * legitimately need to see proposals that are not yet accepted and chapters
 * beyond the reader's position. Never use it to serve a user-facing read:
 * that is exactly the mistake row-level security exists to prevent.
 *
 * **Reentrant.** Called from inside another withIngest(), it runs `fn` on that
 * transaction instead of opening a second one. Two consequences worth knowing:
 * what the nested call writes commits with the outer transaction rather than on
 * its own, and a throw out of it poisons the outer one. Where a failure has to
 * be contained, open a savepoint explicitly with `db.transaction()` — which is
 * what publication does around each assertion, so that one refused edge does
 * not take the whole chapter down with it.
 *
 * The `done` check is for a callback that outlives its request: `after()`
 * captures the async context it was scheduled in, so a callback scheduled
 * during a transaction would otherwise reach for that transaction long after it
 * committed. A settled scope is treated as no scope, and the callback opens its
 * own.
 */
export async function withIngest<T>(
  fn: (db: BoundaryDb) => Promise<T>,
): Promise<T> {
  const open = openIngest.getStore()
  if (open && !open.done) return fn(open.tx)

  return ingestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_ingest`)
    const scope: OpenIngest = { tx, done: false }
    try {
      return await openIngest.run(scope, () => fn(tx))
    } finally {
      scope.done = true
    }
  })
}

/**
 * Run `fn` with permission to delete append-only rows.
 *
 * Only the chapter-deletion path should use this, and only after writing an
 * audit entry. The opt-in is explicit so that "we deleted history" is always a
 * deliberate act that shows up in a diff.
 *
 * Unlike withIngest() this one refuses to nest, rather than joining the
 * transaction already open. Joining would mean setting `app.allow_destructive`
 * on someone else's transaction — and that setting is transaction-scoped, not
 * block-scoped, so permission to delete append-only rows would stay on for
 * everything that ran after it. A loud error about an arrangement that does not
 * exist today is better than a quiet widening tomorrow.
 */
export async function withDestructive<T>(
  reason: string,
  fn: (db: BoundaryDb) => Promise<T>,
): Promise<T> {
  if (!reason.trim()) {
    throw new Error('Une opération destructive doit être justifiée.')
  }
  const open = openIngest.getStore()
  if (open && !open.done) {
    throw new Error(
      'withDestructive() ne peut pas être imbriqué dans withIngest() : ' +
        "l'autorisation de suppression vaudrait pour toute la transaction.",
    )
  }
  return ingestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_ingest`)
    await tx.execute(sql`SELECT set_config('app.allow_destructive', 'on', true)`)
    const scope: OpenIngest = { tx, done: false }
    try {
      return await openIngest.run(scope, () => fn(tx))
    } finally {
      scope.done = true
    }
  })
}
