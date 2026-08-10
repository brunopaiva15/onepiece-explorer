-- 0002 — Library, chapters, and the document model (document → page → panel →
-- text block). These are the tables that hold what was actually imported;
-- everything in 0004 is derived from them and must point back here.

-- --------------------------------------------------------------------------
-- Profiles
--
-- Supabase Auth owns identity (auth.users). This table holds preferences only.
-- Deliberately no foreign key to auth.users: the local test database has no
-- such table, and the same migration must apply to both targets.
-- --------------------------------------------------------------------------
CREATE TABLE profiles (
  id                uuid PRIMARY KEY,
  display_name      text,
  theme             text NOT NULL DEFAULT 'system',
  -- Where the reader currently is. The server clamps any requested boundary
  -- to [0, last published chapter]; this is the remembered default.
  boundary_chapter  integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Works
--
-- The engine is not hard-wired to One Piece; a work is a first-class row.
-- In practice a user has one.
-- --------------------------------------------------------------------------
CREATE TABLE works (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL,
  slug                      text NOT NULL,
  title                     text NOT NULL,
  default_reading_direction reading_direction NOT NULL DEFAULT 'rtl',
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- --------------------------------------------------------------------------
-- Chapters
-- --------------------------------------------------------------------------
CREATE TABLE chapters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id            uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  number             integer NOT NULL,
  title              text,
  volume             integer,
  language           text NOT NULL DEFAULT 'fr',
  reading_direction  reading_direction NOT NULL DEFAULT 'rtl',
  notes              text,
  status             chapter_status NOT NULL DEFAULT 'draft',
  -- Content fingerprint over the ordered page hashes. Re-importing the same
  -- chapter is idempotent because this matches.
  source_fingerprint text,
  page_count         integer NOT NULL DEFAULT 0,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, number),
  CONSTRAINT chapter_number_non_negative CHECK (number >= 0)
);

CREATE INDEX chapters_work_number_idx ON chapters (work_id, number);
CREATE INDEX chapters_user_status_idx ON chapters (user_id, status);

-- --------------------------------------------------------------------------
-- Documents — the uploaded file itself
-- --------------------------------------------------------------------------
CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id        uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL,
  kind              document_kind NOT NULL,
  original_filename text NOT NULL,
  byte_size         bigint NOT NULL,
  -- Content hash. Duplicate detection is by content, not by filename.
  sha256            text NOT NULL,
  mime              text NOT NULL,
  -- Key in the private bucket. Never a URL: assets are only ever reachable
  -- through a short-lived signed URL minted server-side.
  storage_key       text NOT NULL,
  has_text_layer    boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_chapter_idx ON documents (chapter_id);
CREATE INDEX documents_sha_idx ON documents (user_id, sha256);

-- --------------------------------------------------------------------------
-- Pages
-- --------------------------------------------------------------------------
CREATE TABLE pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id            uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  user_id               uuid NOT NULL,
  -- Denormalised from chapters.number so the row-level security predicate is
  -- a plain integer comparison. An RLS policy runs on every row of every
  -- read; it cannot afford a join.
  chapter_number        integer NOT NULL,
  index                 integer NOT NULL,
  kind                  page_kind NOT NULL DEFAULT 'narrative',
  width                 integer NOT NULL,
  height                integer NOT NULL,
  is_double_spread      boolean NOT NULL DEFAULT false,
  rotation              integer NOT NULL DEFAULT 0,
  excluded              boolean NOT NULL DEFAULT false,
  storage_key_original  text NOT NULL,
  storage_key_display   text,
  storage_key_thumb     text,
  -- Perceptual hash, for duplicate-page detection across imports.
  phash                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chapter_id, index),
  CONSTRAINT page_rotation_valid CHECK (rotation IN (0, 90, 180, 270))
);

CREATE INDEX pages_chapter_index_idx ON pages (chapter_id, index);

-- --------------------------------------------------------------------------
-- Panels
--
-- bbox is normalised to [0,1] relative to page dimensions so it survives a
-- change of derivative resolution.
-- --------------------------------------------------------------------------
CREATE TABLE panels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chapter_id     uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  chapter_number integer NOT NULL,
  index          integer NOT NULL,
  bbox           jsonb NOT NULL,
  reading_order  integer NOT NULL,
  confidence     real NOT NULL DEFAULT 1,
  source         detection_source NOT NULL DEFAULT 'auto',
  -- Factual visual description, produced by the model and itself anchored to
  -- this panel. Claims derived from imagery cite it.
  description       text,
  description_model text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, index),
  CONSTRAINT panel_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX panels_page_order_idx ON panels (page_id, reading_order);
CREATE INDEX panels_chapter_idx ON panels (chapter_id);

-- --------------------------------------------------------------------------
-- Text blocks
--
-- normalized_text is what evidence anchoring matches against: NFKC, folded,
-- whitespace collapsed. Keeping it as a column means the anchoring check is
-- an indexed comparison rather than a per-row transformation.
-- --------------------------------------------------------------------------
CREATE TABLE text_blocks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id          uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  panel_id         uuid REFERENCES panels(id) ON DELETE SET NULL,
  chapter_id       uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  chapter_number   integer NOT NULL,
  bbox             jsonb NOT NULL,
  text             text NOT NULL,
  normalized_text  text NOT NULL,
  lang             text,
  confidence       real NOT NULL DEFAULT 1,
  kind             text_block_kind NOT NULL DEFAULT 'bubble',
  source           text_source NOT NULL,
  reading_order    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX text_blocks_page_idx ON text_blocks (page_id, reading_order);
CREATE INDEX text_blocks_panel_idx ON text_blocks (panel_id);
CREATE INDEX text_blocks_chapter_idx ON text_blocks (chapter_id);
CREATE INDEX text_blocks_trgm_idx
  ON text_blocks USING gin (normalized_text gin_trgm_ops);
