# ADR 0001 — The chapter boundary is enforced by the database

**Status:** accepted · **Date:** 2026-08-10

## Context

The product's core promise is epistemic: a view "as at the end of chapter N"
must never leak a fact revealed after N. The obvious implementation is a
`WHERE knowledge_from_chapter <= $boundary` clause in every read.

That fails on the only axis that matters. There will be dozens of read paths —
graph projection, entity sheets, timeline, mystery board, search, the
assistant's context builder, future endpoints nobody has written yet. A single
forgotten clause, an over-broad join, or a `SELECT` added during a hurried fix
silently breaks the product's central guarantee, and does so invisibly: the UI
renders happily, just with a spoiler in it.

Correctness that depends on every future developer remembering something is not
correctness.

## Decision

The boundary is a **PostgreSQL row-level security policy**, not an application
convention.

Every table carrying revealed knowledge (`assertions`, `entity_labels`,
`evidence`, `events`, `mysteries`, `occurrences`) has an RLS policy combining
ownership and the boundary:

```sql
CREATE POLICY assertions_boundary ON assertions FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  AND review_status = 'accepted'
  AND knowledge_from_chapter <= current_setting('app.boundary_chapter')::int
  AND (knowledge_until_chapter IS NULL
       OR knowledge_until_chapter > current_setting('app.boundary_chapter')::int)
);
```

All application reads go through one wrapper, `withBoundary()`, which opens a
transaction and sets three session variables inside it:

```sql
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"<verified uid>","role":"authenticated"}';
SET LOCAL app.boundary_chapter = '<validated integer>';
```

Three details are load-bearing:

1. **`SET LOCAL ROLE authenticated`.** The connection's owning role has
   `BYPASSRLS`; without switching role, every policy above is silently inert.
   This is the single easiest way to get a false sense of safety.
2. **`request.jwt.claims` is set by us.** `auth.uid()` reads it, and PostgREST
   normally populates it. We connect directly with Drizzle, so we set it —
   from a JWT verified server-side via `supabase.auth.getUser()`, never from a
   client-supplied value.
3. **`SET LOCAL`, always inside a transaction.** With Supavisor in transaction
   mode the connection is handed to another request the moment the transaction
   ends; a bare `SET` would leak the previous user's boundary — and identity —
   onto the next query. `postgres.js` also runs with `prepare: false`, required
   by that pooling mode.

The ingestion pipeline and the publication step use a separate connection and
role (`app_ingest`) that is exempt: it writes proposals that are by definition
not yet accepted, and computes deltas across the full corpus.

## Consequences

**Good.** A forgotten clause cannot leak. The guarantee holds for endpoints
that do not exist yet. The blocking anti-spoiler tests assert a database
property rather than a code path, so they keep their meaning as the app grows.

**Cost.** No table reads from the browser: `supabase-js` client-side is limited
to the auth round-trip and consuming signed URLs, and PostgREST is not a data
path. This is a real constraint on the architecture and it is intentional — a
per-transaction session variable cannot survive a stateless PostgREST call.

**Cost.** Every read must be inside a transaction, which is slightly more
ceremony than a bare query and rules out a few connection-level optimisations.

**Guarded by.** Two tests: an ESLint rule plus a test asserting no module
outside `src/db/` obtains a pool directly, and a test that queries a protected
table outside `withBoundary()` and asserts it returns **zero rows** rather than
data.

## Alternatives rejected

- **Application-level filtering.** Rejected above: relies on perfect recall
  across an unbounded number of future read paths.
- **A separate materialised table per boundary.** ~1 100 chapters × a growing
  graph is prohibitive to store and to keep consistent.
- **Filtering in a view layer.** Better than nothing, but a view can be
  bypassed by querying the base table; RLS cannot.
