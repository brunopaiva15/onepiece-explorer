-- 0005 — Row-level security: the chapter boundary, enforced by the database.
--
-- This is the single most important file in the schema. Read ADR 0001.
--
-- Two shapes of policy:
--
--   ownership-only  — the row is the user's, and revealing its existence is
--                     not a spoiler (their own chapter list, their own runs)
--   boundary        — ownership AND the row is knowledge the reader could
--                     hold at the current boundary
--
-- app.boundary() returns -1 when app.boundary_chapter is unset, so a query
-- issued outside withBoundary() sees nothing. Fail-closed, by construction.
--
-- `authenticated` is granted SELECT only. Every write goes through the
-- pipeline/publication path running as `app_ingest`, or through an explicit
-- server action that switches role. This makes "the app accidentally wrote
-- something" structurally impossible rather than merely unlikely.

-- --------------------------------------------------------------------------
-- Enable RLS everywhere. FORCE so it applies to the table owner too — without
-- it, the owning role silently bypasses every policy below and the whole
-- mechanism becomes decorative.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles', 'works', 'chapters', 'documents', 'pages', 'panels',
    'text_blocks', 'entities', 'entity_labels', 'assertions', 'evidence',
    'events', 'mysteries', 'user_theories', 'occurrences', 'embeddings',
    'audit_log', 'ingestion_runs', 'ingestion_steps', 'review_items',
    'review_decisions', 'quarantine'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- --------------------------------------------------------------------------
-- The ontology is shared reference data, not user data.
-- --------------------------------------------------------------------------
GRANT SELECT ON node_types, predicates TO authenticated, app_ingest;
GRANT INSERT, UPDATE, DELETE ON node_types, predicates TO app_ingest;

-- --------------------------------------------------------------------------
-- app_ingest bypasses the boundary.
--
-- It writes proposals that are by definition not yet accepted, and computes
-- deltas across the whole corpus. Giving it a boundary would make the
-- pipeline unable to do its job. It never serves a user-facing read.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles', 'works', 'chapters', 'documents', 'pages', 'panels',
    'text_blocks', 'entities', 'entity_labels', 'assertions', 'evidence',
    'events', 'mysteries', 'user_theories', 'occurrences', 'embeddings',
    'audit_log', 'ingestion_runs', 'ingestion_steps', 'review_items',
    'review_decisions', 'quarantine'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO app_ingest USING (true) WITH CHECK (true)',
      t || '_ingest_all', t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_ingest', t);
  END LOOP;
END
$$;

-- --------------------------------------------------------------------------
-- Ownership-only reads
--
-- Knowing that you imported chapter 700 is not a spoiler about its contents,
-- and the boundary slider needs to know how far the library goes.
-- --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'works', 'chapters', 'documents', 'entities', 'ingestion_runs',
    'ingestion_steps', 'review_items', 'review_decisions', 'quarantine',
    'audit_log', 'embeddings'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (user_id = auth.uid())',
      t || '_owner_select', t
    );
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
  END LOOP;
END
$$;

-- profiles keys on id rather than user_id, and the user may update their own.
CREATE POLICY profiles_owner_select ON profiles
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY profiles_owner_update ON profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
GRANT SELECT, UPDATE ON profiles TO authenticated;

-- Personal theories are the user's own writing, not derived canon. They live
-- in a separate layer and are never promoted to fact automatically, so the
-- user may write them directly.
CREATE POLICY user_theories_owner_all ON user_theories
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_theories TO authenticated;

-- --------------------------------------------------------------------------
-- Boundary-filtered: page content
--
-- Pages of a chapter beyond the boundary reveal narrative content, so they
-- are filtered like any other knowledge. The import and review screens work
-- on a chapter you have just read, and legitimately set the boundary to that
-- chapter's own number.
-- --------------------------------------------------------------------------
CREATE POLICY pages_boundary_select ON pages
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND chapter_number <= app.boundary());

CREATE POLICY panels_boundary_select ON panels
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND chapter_number <= app.boundary());

CREATE POLICY text_blocks_boundary_select ON text_blocks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND chapter_number <= app.boundary());

GRANT SELECT ON pages, panels, text_blocks TO authenticated;

-- --------------------------------------------------------------------------
-- Boundary-filtered: knowledge
--
-- The heart of it. An assertion is visible when it has been accepted, was
-- revealed at or before the boundary, and has not yet been superseded as of
-- the boundary.
--
-- knowledge_until_chapter is what keeps a refuted belief visible in the past:
-- a belief held from chapter 10 and refuted at chapter 40 is visible at 39
-- and gone at 40, while the assertion that refutes it appears at 40. Both
-- rows exist forever; the boundary chooses between them.
-- --------------------------------------------------------------------------
CREATE POLICY assertions_boundary_select ON assertions
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND review_status = 'accepted'
    AND knowledge_from_chapter <= app.boundary()
    AND (knowledge_until_chapter IS NULL
         OR knowledge_until_chapter > app.boundary())
  );

-- A name is knowledge like any other. This is what keeps an alias in place
-- at chapter 49 when the true name lands at chapter 50.
CREATE POLICY entity_labels_boundary_select ON entity_labels
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND revealed_in_chapter <= app.boundary()
  );

-- Evidence inherits its parent's visibility. The subquery is itself subject
-- to the assertions policy above, so no separate boundary term is needed —
-- and cannot drift out of sync with it.
CREATE POLICY evidence_boundary_select ON evidence
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM assertions a WHERE a.id = evidence.assertion_id)
  );

CREATE POLICY events_boundary_select ON events
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND COALESCE(told_in_chapter, shown_in_chapter, 0) <= app.boundary()
  );

CREATE POLICY mysteries_boundary_select ON mysteries
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND opened_in_chapter <= app.boundary()
  );

CREATE POLICY occurrences_boundary_select ON occurrences
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND chapter_number <= app.boundary()
  );

GRANT SELECT ON assertions, entity_labels, evidence, events, mysteries,
  occurrences TO authenticated;

-- --------------------------------------------------------------------------
-- Nothing is granted to `anon`. PostgREST is not a data path for this
-- application: the boundary is a per-transaction session variable and cannot
-- survive a stateless REST call, so all reads go through the Next.js server.
--
-- The role exists on Supabase and not on the local test database, hence the
-- guard — an unconditional REVOKE would fail the whole migration locally.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON SCHEMA public FROM anon;
  END IF;
END
$$;

COMMENT ON POLICY assertions_boundary_select ON assertions IS
  'The chapter boundary. Do not add a read path that bypasses this: it is the '
  'product''s central guarantee, and application-level filtering has been '
  'rejected (ADR 0001).';
