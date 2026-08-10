-- 0004 — The knowledge graph itself.
--
-- Read ADR 0002 before changing anything here. The short version: nothing in
-- `assertions` is ever updated or deleted, and the two time axes
-- (story validity vs reader knowledge) are separate columns on purpose.

-- --------------------------------------------------------------------------
-- Ontology, stored as data (ADR 0004)
-- --------------------------------------------------------------------------
CREATE TABLE node_types (
  key         text PRIMARY KEY,
  label_fr    text NOT NULL,
  description text,
  builtin     boolean NOT NULL DEFAULT true
);

CREATE TABLE predicates (
  key                      text PRIMARY KEY,
  label_fr                 text NOT NULL,
  -- `symmetric` is a reserved word in SQL, hence the is_ prefixes.
  is_directed              boolean NOT NULL DEFAULT true,
  is_symmetric             boolean NOT NULL DEFAULT false,
  inverse_key              text,
  subject_types            text[] NOT NULL,
  object_types             text[] NOT NULL,
  -- same_as drives the boundary-aware union-find.
  is_identity              boolean NOT NULL DEFAULT false,
  -- Forces human review whatever the model's confidence.
  requires_explicit_review boolean NOT NULL DEFAULT false,
  builtin                  boolean NOT NULL DEFAULT true,
  description              text
);

-- --------------------------------------------------------------------------
-- Entities
--
-- An entity is a node. It deliberately carries no name: names are labels with
-- their own reveal chapters, because "what is this character called" has a
-- different answer at chapter 20 and at chapter 300.
-- --------------------------------------------------------------------------
CREATE TABLE entities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id            uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  node_type          text NOT NULL REFERENCES node_types(key),
  first_seen_chapter integer NOT NULL,
  review_status      review_status NOT NULL DEFAULT 'proposed',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entities_work_type_idx ON entities (work_id, node_type);
CREATE INDEX entities_first_seen_idx ON entities (work_id, first_seen_chapter);

-- --------------------------------------------------------------------------
-- Entity labels
--
-- The display name at a given boundary is the highest-precedence label whose
-- revealed_in_chapter <= boundary. A placeholder generated from a panel
-- description holds until the alias lands; the alias holds until the true
-- name is revealed. Nothing is ever rewritten.
-- --------------------------------------------------------------------------
CREATE TABLE entity_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  label               text NOT NULL,
  -- NFKC + unaccent + fold + collapse. Used for trigram blocking during
  -- entity resolution.
  normalized_label    text NOT NULL,
  kind                label_kind NOT NULL DEFAULT 'alias',
  revealed_in_chapter integer NOT NULL,
  -- true_name > epithet > alias > translation > placeholder
  precedence          integer NOT NULL DEFAULT 0,
  source_assertion_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entity_labels_entity_idx
  ON entity_labels (entity_id, revealed_in_chapter, precedence DESC);
CREATE INDEX entity_labels_trgm_idx
  ON entity_labels USING gin (normalized_label gin_trgm_ops);

-- --------------------------------------------------------------------------
-- Assertions — append-only (ADR 0002)
-- --------------------------------------------------------------------------
CREATE TABLE assertions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id           uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,

  subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate         text NOT NULL REFERENCES predicates(key),
  object_entity_id  uuid REFERENCES entities(id) ON DELETE CASCADE,
  object_value      jsonb,

  -- Reader-knowledge axis. This is what the RLS policy filters on.
  knowledge_from_chapter  integer NOT NULL,
  knowledge_until_chapter integer,

  -- In-world validity axis. Deliberately fuzzy: exact date, approximate date,
  -- relative order, or unknown. Never fabricated precision.
  story_valid_from  jsonb,
  story_valid_until jsonb,

  -- The chapter whose pages provide the evidence. Differs from
  -- knowledge_from_chapter for a flashback: shown late, happened early.
  observed_in_chapter integer NOT NULL,

  confidence        real NOT NULL DEFAULT 0,
  epistemic_status  epistemic_status NOT NULL,
  review_status     review_status NOT NULL DEFAULT 'proposed',
  proposed_by       proposer NOT NULL,

  -- Reproducibility of an AI proposal.
  pipeline_version  text,
  model_id          text,
  prompt_version    text,
  run_id            uuid REFERENCES ingestion_runs(id) ON DELETE SET NULL,

  proposal_fingerprint text,

  -- A correction never overwrites: it inserts a new row and points the old
  -- one here.
  superseded_by     uuid REFERENCES assertions(id) ON DELETE SET NULL,
  -- User-authored. Never superseded by the AI on re-import.
  locked            boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assertion_has_object
    CHECK (object_entity_id IS NOT NULL OR object_value IS NOT NULL),
  CONSTRAINT assertion_knowledge_window
    CHECK (knowledge_until_chapter IS NULL
           OR knowledge_until_chapter > knowledge_from_chapter),
  CONSTRAINT assertion_confidence_range
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT assertion_chapters_non_negative
    CHECK (knowledge_from_chapter >= 0 AND observed_in_chapter >= 0)
);

-- The index that carries the boundary projection.
CREATE INDEX assertions_boundary_idx
  ON assertions (work_id, review_status, knowledge_from_chapter, knowledge_until_chapter);
CREATE INDEX assertions_subject_idx ON assertions (subject_entity_id, predicate);
CREATE INDEX assertions_object_idx ON assertions (object_entity_id, predicate);
CREATE INDEX assertions_run_idx ON assertions (run_id);
CREATE INDEX assertions_fingerprint_idx
  ON assertions (user_id, proposal_fingerprint)
  WHERE proposal_fingerprint IS NOT NULL;
-- Identity resolution walks this constantly.
CREATE INDEX assertions_identity_idx
  ON assertions (work_id, knowledge_from_chapter)
  WHERE predicate = 'same_as';

-- --------------------------------------------------------------------------
-- Evidence
--
-- At least one row per accepted assertion, enforced at publication time.
-- excerpt must be a substring of the cited text block's normalized_text —
-- checked in code before insert, and again by a trigger in 0006.
-- --------------------------------------------------------------------------
CREATE TABLE evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assertion_id  uuid NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  chapter_id    uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  page_id       uuid REFERENCES pages(id) ON DELETE SET NULL,
  panel_id      uuid REFERENCES panels(id) ON DELETE SET NULL,
  text_block_id uuid REFERENCES text_blocks(id) ON DELETE SET NULL,
  bbox          jsonb,
  kind          evidence_kind NOT NULL,
  excerpt       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evidence_assertion_idx ON evidence (assertion_id);
CREATE INDEX evidence_chapter_idx ON evidence (chapter_id);
CREATE INDEX evidence_panel_idx ON evidence (panel_id);

-- --------------------------------------------------------------------------
-- Events
--
-- An event is an entity of type 'event'; this table adds its temporal shape.
-- Participants are ordinary `participates_in` assertions, so they inherit the
-- boundary and the provenance for free.
-- --------------------------------------------------------------------------
CREATE TABLE events (
  entity_id         uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,
  work_id           uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  summary           text,
  -- { kind: 'exact' | 'approximate' | 'relative' | 'unknown', ... }
  story_time        jsonb,
  duration_estimate text,
  is_flashback      boolean NOT NULL DEFAULT false,
  -- Shown vs told: a flashback is shown late and told about early, or the
  -- reverse. Both are recorded; neither is inferred from the other.
  shown_in_chapter  integer,
  told_in_chapter   integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_work_idx ON events (work_id);

-- --------------------------------------------------------------------------
-- Mysteries
-- --------------------------------------------------------------------------
CREATE TABLE mysteries (
  entity_id            uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,
  work_id              uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  question             text NOT NULL,
  opened_in_chapter    integer NOT NULL,
  state                mystery_state NOT NULL DEFAULT 'open',
  resolved_in_chapter  integer,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mysteries_work_state_idx ON mysteries (work_id, state);

-- --------------------------------------------------------------------------
-- User theories — a separate layer, never promoted to canon automatically
-- --------------------------------------------------------------------------
CREATE TABLE user_theories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  work_id            uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title              text NOT NULL,
  body               text NOT NULL DEFAULT '',
  related_entity_ids uuid[] NOT NULL DEFAULT '{}',
  related_mystery_id uuid REFERENCES entities(id) ON DELETE SET NULL,
  -- The boundary the user held when writing it, so a theory is never shown
  -- as if it were informed by chapters read later.
  written_at_chapter integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_theories_work_idx ON user_theories (work_id);

-- --------------------------------------------------------------------------
-- Occurrences — cheap appearance/mention index, for "where does X show up"
-- without walking assertions.
-- --------------------------------------------------------------------------
CREATE TABLE occurrences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  page_id    uuid REFERENCES pages(id) ON DELETE CASCADE,
  panel_id   uuid REFERENCES panels(id) ON DELETE CASCADE,
  kind       occurrence_kind NOT NULL,
  chapter_number integer NOT NULL,
  confidence real NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX occurrences_entity_idx ON occurrences (entity_id, chapter_number);
CREATE INDEX occurrences_chapter_idx ON occurrences (chapter_id);

-- --------------------------------------------------------------------------
-- Embeddings
--
-- real[] is the storage of record so the same rows work on Supabase and on
-- the local test database. Where pgvector exists, 0007 adds an indexed
-- vector column alongside (ADR 0005).
-- --------------------------------------------------------------------------
CREATE TABLE embeddings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  work_id      uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  subject_id   uuid NOT NULL,
  chapter_number integer NOT NULL,
  model_id     text NOT NULL,
  dimensions   integer NOT NULL,
  embedding    real[] NOT NULL,
  content      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id, model_id)
);

CREATE INDEX embeddings_work_idx ON embeddings (work_id, subject_kind);
CREATE INDEX embeddings_chapter_idx ON embeddings (work_id, chapter_number);

-- --------------------------------------------------------------------------
-- Audit log
-- --------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  action       text NOT NULL,
  subject_kind text,
  subject_id   uuid,
  detail       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);

-- Late-bound FK: a label can be justified by the assertion that revealed it.
ALTER TABLE entity_labels
  ADD CONSTRAINT entity_labels_source_assertion_fk
  FOREIGN KEY (source_assertion_id) REFERENCES assertions(id) ON DELETE SET NULL;
