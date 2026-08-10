-- 0003 — The pipeline's own bookkeeping: runs, steps, the review queue, the
-- durable record of human decisions, and quarantine.
--
-- Created before the knowledge tables because assertions reference the run
-- that produced them.

-- --------------------------------------------------------------------------
-- Runs
-- --------------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id       uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  status           run_status NOT NULL DEFAULT 'pending',
  pipeline_version text NOT NULL,
  provider         text NOT NULL,
  -- Was bulk extraction sent through the Batches API (50% cheaper) or run
  -- interactively? Recorded so cost figures are interpretable after the fact.
  used_batch_api   boolean NOT NULL DEFAULT false,
  -- Pre-flight estimate from a real countTokens() call, kept next to the
  -- observed total so the estimator can be checked against reality.
  estimated_cost_cents integer,
  total_cost_cents integer NOT NULL DEFAULT 0,
  error            text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_runs_chapter_idx ON ingestion_runs (chapter_id);
CREATE INDEX ingestion_runs_user_status_idx ON ingestion_runs (user_id, status);

-- --------------------------------------------------------------------------
-- Steps
--
-- input_hash is what makes replay free: an unchanged step returns its cached
-- output instead of re-running. Each attempt is its own row, so a retry never
-- overwrites the record of what failed.
-- --------------------------------------------------------------------------
CREATE TABLE ingestion_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  step_key     text NOT NULL,
  status       step_status NOT NULL DEFAULT 'pending',
  attempt      integer NOT NULL DEFAULT 1,
  input_hash   text,
  output_ref   text,
  duration_ms  integer,
  cost_cents   integer NOT NULL DEFAULT 0,
  tokens_in    integer,
  tokens_out   integer,
  cache_read_tokens     integer,
  cache_write_tokens    integer,
  model_id     text,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_key, attempt)
);

CREATE INDEX ingestion_steps_run_idx ON ingestion_steps (run_id, step_key);
CREATE INDEX ingestion_steps_hash_idx ON ingestion_steps (user_id, input_hash)
  WHERE input_hash IS NOT NULL;

-- --------------------------------------------------------------------------
-- Review queue
-- --------------------------------------------------------------------------
CREATE TABLE review_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  chapter_id           uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,
  category             text NOT NULL,
  priority             integer NOT NULL DEFAULT 0,
  -- The proposed assertion, its candidates, confidence and reasons.
  payload              jsonb NOT NULL,
  proposal_fingerprint text NOT NULL,
  -- Identity claims, reveals, deaths, hidden affiliations, contradictions and
  -- mystery resolutions can never be bulk-accepted, whatever the confidence.
  requires_explicit_review boolean NOT NULL DEFAULT false,
  confidence           real NOT NULL DEFAULT 0,
  status               review_status NOT NULL DEFAULT 'proposed',
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_items_run_idx ON review_items (run_id, status, priority DESC);
CREATE INDEX review_items_fingerprint_idx
  ON review_items (user_id, proposal_fingerprint);

-- --------------------------------------------------------------------------
-- Review decisions — why human corrections survive a re-import
--
-- Keyed by a fingerprint of the normalised proposal plus its evidence anchors,
-- not by row id. Re-processing the same chapter produces the same fingerprints,
-- so a decision recorded once is re-applied automatically and the item never
-- returns to the queue.
-- --------------------------------------------------------------------------
CREATE TABLE review_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,
  work_id              uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  proposal_fingerprint text NOT NULL,
  decision             review_decision NOT NULL,
  corrected_payload    jsonb,
  comment              text,
  decided_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_id, proposal_fingerprint)
);

-- --------------------------------------------------------------------------
-- Quarantine
--
-- Where a model proposal goes when it cannot be anchored to real evidence —
-- the mechanism that stops the model answering from its own training
-- knowledge (ADR 0003). Surfaced in the review centre so the rejection is
-- visible rather than silent.
-- --------------------------------------------------------------------------
CREATE TABLE quarantine (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  chapter_id uuid REFERENCES chapters(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  reason     text NOT NULL,
  detail     text,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX quarantine_run_idx ON quarantine (run_id);
CREATE INDEX quarantine_user_idx ON quarantine (user_id, created_at DESC);
