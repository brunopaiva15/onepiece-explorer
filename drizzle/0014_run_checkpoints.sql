-- Work that has been paid for, remembered.
--
-- A chapter's extraction is twenty calls to a model. Each one is billed on
-- delivery, and each one writes its proposals as it lands. But the *step* was
-- the unit of progress: a step that failed halfway was retried from its first
-- slice, and every slice already bought was bought again. On an unstable
-- network — a laptop, a home connection, a pooler that drops — the same chapter
-- was paid for three times over, which is how a run whose estimate was thirty
-- cents reached four dollars.
--
-- The failure was not the network. Networks drop. The failure was having no
-- record, below the step, of what had already been done.
--
-- One row per unit of work completed. `unit_key` is whatever the step decides
-- identifies a unit — for extraction, a hash of the panel refs in a slice, so
-- the key is stable across retries and changes the moment the input does.
-- Deliberately not tied to any one step's shape: describe, transcribe and embed
-- have the same problem and can use the same table.

CREATE TABLE run_checkpoints (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id     uuid NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  step_key   text NOT NULL,
  unit_key   text NOT NULL,
  -- What the unit produced.
  --
  -- For extraction this is the model's filtered answer, and holding it here is
  -- the point rather than a duplication: the proposals are written to
  -- review_items only once every slice has returned, so at the moment a run
  -- dies this row is the *only* record of a call that was already billed.
  -- Replaying it on resume is the difference between a free retry and a second
  -- invoice. It is superseded the instant the step completes and the real rows
  -- exist.
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- The same unit recorded twice is the retry working correctly, not an error.
  UNIQUE (run_id, step_key, unit_key)
);

CREATE INDEX run_checkpoints_lookup ON run_checkpoints (run_id, step_key);

ALTER TABLE run_checkpoints ENABLE ROW LEVEL SECURITY;

-- Pipeline-only, like the rest of the ingestion tables: this is bookkeeping
-- about work in progress, not knowledge, and it is never read at the boundary.
CREATE POLICY run_checkpoints_ingest ON run_checkpoints
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, DELETE ON run_checkpoints TO app_ingest;
