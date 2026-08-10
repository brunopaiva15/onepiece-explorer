-- ---------------------------------------------------------------------------
-- 0010 — Close the embeddings leak, and give the corpus a French full-text index.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Part 1: embeddings is knowledge, not metadata.
--
-- Migration 0005 gave it an ownership-only policy, alongside genuinely
-- ownership-scoped tables like `works` and `chapters`. That was wrong for the
-- same reason it was wrong for `entities` in 0009, and worse: the row carries
-- `chapter_number` *and* `content` — the literal text that was vectorised. At
-- boundary 3, a semantic search would have read chapter 300's prose back to the
-- reader, correctly ranked and neatly cited.
--
-- The table is empty today because nothing writes it yet. That makes this the
-- one moment where the fix costs nothing, and doing it before search starts
-- reading the table is the difference between a migration and an incident.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS embeddings_owner_select ON embeddings;

CREATE POLICY embeddings_boundary_select ON embeddings
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND chapter_number <= app.boundary()
  );

CREATE INDEX IF NOT EXISTS embeddings_boundary_idx
  ON embeddings (user_id, chapter_number);

-- ---------------------------------------------------------------------------
-- Considered and deliberately left ownership-scoped. Recorded here so the next
-- person does not go hunting for a filter that is absent on purpose:
--
--   audit_log       — a journal of the reader's own actions. `detail` holds
--                     counts, not content. Knowing you published chapter 40 is
--                     not knowing what happens in it.
--   review_items    — the work queue for a chapter you are actively reviewing,
--   quarantine        which is by definition a chapter you have just read. Both
--                     are read through the `app_ingest` role anyway, where the
--                     boundary does not apply; filtering them for
--                     `authenticated` would forbid nothing and break nothing,
--                     but it would also mean nothing.
--   ingestion_runs  — processing metadata. A run's existence and its step
--   ingestion_steps   timings say nothing about the story.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Part 2: a French text-search configuration that folds accents.
--
-- `unaccent()` is STABLE, not IMMUTABLE, so it cannot be called from a
-- generated column — Postgres refuses outright. The way round it is not a
-- wrapper marked IMMUTABLE by hand (which lies to the planner and breaks on a
-- dictionary update); it is a text-search *configuration* that has the unaccent
-- dictionary in its chain. `to_tsvector('fr_unaccent', x)` with the config as a
-- literal is IMMUTABLE, so it indexes cleanly.
--
-- This matters for real reading: "Marées" and "Marees" must find each other,
-- because one comes off a PDF text layer and the other off OCR, and the reader
-- typing either should not have to know which.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'fr_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION fr_unaccent (COPY = french);
  END IF;
END
$$;

ALTER TEXT SEARCH CONFIGURATION fr_unaccent
  ALTER MAPPING FOR hword, hword_part, word, asciiword, asciihword, numword
  WITH unaccent, french_stem;

-- ---------------------------------------------------------------------------
-- Part 3: generated tsvector columns, one per place text actually lives.
--
-- Generated rather than trigger-maintained: the column cannot drift from its
-- source, there is no ordering hazard against the other triggers on these
-- tables, and a reindex is a plain REINDEX rather than a backfill script.
--
-- No column on `assertions`. An assertion has no prose — it is a subject, a
-- predicate and an object — so its searchable text is the labels of its
-- endpoints, which are indexed here on `entity_labels`. Adding an empty
-- tsvector there would produce an index that matches nothing and a search path
-- that looks covered.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_labels
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('fr_unaccent', coalesce(label, ''))) STORED;

ALTER TABLE text_blocks
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('fr_unaccent', coalesce(text, ''))) STORED;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('fr_unaccent', coalesce(summary, ''))) STORED;

ALTER TABLE mysteries
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('fr_unaccent', coalesce(question, ''))) STORED;

ALTER TABLE panels
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('fr_unaccent', coalesce(description, ''))) STORED;

CREATE INDEX IF NOT EXISTS entity_labels_search_idx ON entity_labels USING gin (search_vector);
CREATE INDEX IF NOT EXISTS text_blocks_search_idx   ON text_blocks   USING gin (search_vector);
CREATE INDEX IF NOT EXISTS events_search_idx        ON events        USING gin (search_vector);
CREATE INDEX IF NOT EXISTS mysteries_search_idx     ON mysteries     USING gin (search_vector);
CREATE INDEX IF NOT EXISTS panels_search_idx        ON panels        USING gin (search_vector);

-- Trigram index on the normalised label, for the fuzzy path. Entity resolution
-- already runs `similarity()` against this column (resolve.ts); search reuses
-- the same access path rather than inventing a second one that could rank
-- differently from the blocking that produced the merge suggestions.
CREATE INDEX IF NOT EXISTS entity_labels_trgm_idx
  ON entity_labels USING gin (normalized_label gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Part 4: occurrences, so "where does this appear" is answerable.
--
-- The table has been boundary-filtered since 0005 and empty ever since —
-- nothing wrote it. Publication now fills it from evidence. This index is what
-- makes the per-entity lookup cheap.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS occurrences_user_chapter_idx
  ON occurrences (user_id, chapter_number);
