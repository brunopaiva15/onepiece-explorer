-- 0001 — Extensions, compatibility shims, roles, enums.
--
-- This migration must apply identically to Supabase and to the local
-- PostgreSQL 16 used by CI. Everything that exists on one but not the other
-- is created conditionally.

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- entity-resolution blocking
CREATE EXTENSION IF NOT EXISTS unaccent;  -- label normalisation

-- pgvector ships with Supabase but is not packaged for the local test
-- database. Absence is expected, not an error: VectorStore falls back to
-- real[] with cosine similarity in SQL (ADR 0005).
DO $outer$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector unavailable — VectorStore will use the real[] fallback';
END
$outer$;

-- --------------------------------------------------------------------------
-- auth.uid() compatibility
--
-- Supabase provides this. The local test database does not, so we create an
-- equivalent that reads the same session variable. Guarded so we never
-- overwrite Supabase's own implementation.
-- --------------------------------------------------------------------------
DO $outer$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    EXECUTE $fn$
      CREATE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE
      AS $body$
        SELECT NULLIF(
          current_setting('request.jwt.claims', true)::json ->> 'sub',
          ''
        )::uuid
      $body$;
    $fn$;
  END IF;
END
$outer$;

-- --------------------------------------------------------------------------
-- app.boundary() — the chapter boundary, read by every RLS policy.
--
-- Fail-closed by design: when app.boundary_chapter is not set, this returns
-- -1 and no knowledge row is visible. That is exactly what makes a query
-- issued outside withBoundary() return zero rows instead of leaking data.
-- --------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.boundary() RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.boundary_chapter', true), ''),
    '-1'
  )::integer
$$;

COMMENT ON FUNCTION app.boundary() IS
  'Chapter boundary for the current transaction. Returns -1 when unset so that '
  'reads outside withBoundary() are empty rather than unfiltered.';

-- --------------------------------------------------------------------------
-- Roles
--
--   authenticated — application reads. RLS applies.
--   app_ingest    — pipeline and publication. Writes proposals that are by
--                   definition not yet accepted, and computes deltas across
--                   the whole corpus, so it is exempt from the boundary.
--
-- Supabase already defines `authenticated`; create only what is missing.
-- --------------------------------------------------------------------------
DO $outer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ingest') THEN
    CREATE ROLE app_ingest NOLOGIN NOINHERIT;
  END IF;
END
$outer$;

-- The connecting role must be able to SET LOCAL ROLE to either of these.
DO $outer$
BEGIN
  EXECUTE format('GRANT authenticated TO %I', current_user);
  EXECUTE format('GRANT app_ingest TO %I', current_user);
EXCEPTION
  WHEN OTHERS THEN
    -- Already a member, or insufficient privilege on a managed instance.
    RAISE NOTICE 'Role grant skipped: %', SQLERRM;
END
$outer$;

GRANT USAGE ON SCHEMA public TO authenticated, app_ingest;
GRANT USAGE ON SCHEMA app TO authenticated, app_ingest;
GRANT EXECUTE ON FUNCTION app.boundary() TO authenticated, app_ingest;

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------
CREATE TYPE reading_direction AS ENUM ('rtl', 'ltr');

CREATE TYPE chapter_status AS ENUM (
  'draft',       -- created, no file yet
  'uploaded',    -- file stored, pages not extracted
  'processing',  -- pipeline running
  'review',      -- proposals awaiting human decision
  'published',   -- delta published; visible to projections
  'failed'
);

CREATE TYPE document_kind AS ENUM ('pdf', 'zip', 'cbz', 'images');

CREATE TYPE page_kind AS ENUM ('narrative', 'cover', 'bonus', 'other');

CREATE TYPE detection_source AS ENUM ('auto', 'model', 'manual');

CREATE TYPE text_block_kind AS ENUM (
  'bubble', 'caption', 'sfx', 'sign', 'other'
);

CREATE TYPE text_source AS ENUM (
  'pdf_text',   -- exact, free, with coordinates
  'tesseract',  -- WASM OCR
  'model',      -- multimodal transcription
  'manual'
);

CREATE TYPE label_kind AS ENUM (
  'placeholder',  -- generated from a panel description, never from outside knowledge
  'alias',
  'true_name',
  'epithet',
  'translation'
);

-- The distinction the UI must never blur: a fact, a machine inference, and a
-- guess are three different things.
CREATE TYPE epistemic_status AS ENUM (
  'explicit',
  'inferred_strong',
  'hypothetical',
  'contradicted',
  'refuted',
  'user_validated'
);

CREATE TYPE review_status AS ENUM (
  'proposed', 'accepted', 'rejected', 'deferred', 'superseded'
);

CREATE TYPE proposer AS ENUM ('ai', 'user');

CREATE TYPE evidence_kind AS ENUM (
  'dialogue', 'narration', 'image', 'cover', 'metadata', 'human'
);

CREATE TYPE run_status AS ENUM (
  'pending', 'running', 'paused', 'succeeded', 'failed', 'cancelled'
);

CREATE TYPE step_status AS ENUM (
  'pending', 'running', 'succeeded', 'failed', 'skipped', 'cached'
);

CREATE TYPE review_decision AS ENUM (
  'accept', 'reject', 'correct', 'merge', 'split', 'defer'
);

CREATE TYPE mystery_state AS ENUM (
  'open', 'partially_resolved', 'resolved', 'refuted', 'reopened'
);

CREATE TYPE occurrence_kind AS ENUM ('appearance', 'mention');
