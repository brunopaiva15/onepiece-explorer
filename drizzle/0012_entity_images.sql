-- ---------------------------------------------------------------------------
-- Illustrations for entities the pipeline extracted.
--
-- An image here is NOT knowledge. It is not an assertion, it proves nothing,
-- and no fact may ever be justified by one. That distinction is the whole
-- reason this is its own table rather than a column on `entities`: the founding
-- rule of this product is that only what you imported is canon, and these
-- pictures come from three public fan APIs. Putting them next to assertions
-- would blur the one line that must not blur.
--
-- What they are: a way to recognise a face in a graph of nine hundred nodes.
--
-- ---------------------------------------------------------------------------
-- The boundary applies to them, and the column it applies to is not obvious.
--
-- The naive choice is the entity's own first_seen_chapter — but the entity
-- policy already filters on that, so it would be redundant and would miss the
-- real leak. The real leak is the *name*.
--
-- An image is found by matching a label against an external catalogue. At
-- chapter 1 a character is "l'homme au tablier de cuir" and matches nothing; at
-- chapter 3 the same entity gains the label "Kaelo Renn" and suddenly matches.
-- If the resulting portrait were shown at chapter 1, the reader would be looking
-- at a face the story has not yet given a name to — found *because* of a name
-- they are not supposed to have yet.
--
-- So `revealed_in_chapter` is the revelation chapter of the label that produced
-- the match, and the image is invisible before it. The picture appears at the
-- exact moment the reader learns the name that finds it.
-- ---------------------------------------------------------------------------

CREATE TABLE entity_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,

  -- Provenance, in full. An illustration whose origin is not recorded is
  -- indistinguishable from one this application invented, and the second thing
  -- is something this application must never be able to do.
  source        text NOT NULL,
  source_ref    text NOT NULL,
  source_url    text NOT NULL,
  attribution   text NOT NULL,

  -- Storage keys, never URLs. Same rule as imported pages: reading requires a
  -- short-lived signed URL minted after an ownership check.
  storage_key   text NOT NULL,
  thumb_key     text,
  width         integer,
  height        integer,
  mime          text NOT NULL DEFAULT 'image/webp',
  bytes         integer,

  -- How this image came to be attached to this entity, kept so a wrong match
  -- can be explained rather than merely deleted.
  matched_label text NOT NULL,
  match_method  text NOT NULL,
  match_score   real NOT NULL,

  revealed_in_chapter integer NOT NULL,

  -- One entity can hold several candidates; exactly one is shown.
  is_primary    boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entity_images_score_range CHECK (match_score >= 0 AND match_score <= 1),
  CONSTRAINT entity_images_chapter_positive CHECK (revealed_in_chapter >= 0),
  CONSTRAINT entity_images_source_known
    CHECK (source IN ('onepieceapi', 'api-onepiece', 'anilist', 'manual'))
);

-- Re-running enrichment must not stack duplicates of the same picture.
CREATE UNIQUE INDEX entity_images_unique_source
  ON entity_images (entity_id, source, source_ref);

-- At most one primary per entity, enforced rather than hoped for: two primaries
-- would make the displayed portrait depend on row order, which is the sort of
-- bug that appears only in production and only sometimes.
CREATE UNIQUE INDEX entity_images_one_primary
  ON entity_images (entity_id)
  WHERE is_primary;

CREATE INDEX entity_images_boundary_idx
  ON entity_images (user_id, entity_id, revealed_in_chapter);

ALTER TABLE entity_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_images FORCE ROW LEVEL SECURITY;

CREATE POLICY entity_images_boundary_select ON entity_images
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND revealed_in_chapter <= app.boundary()
  );

-- Enrichment runs as the ingestion role: it reads entities across the whole
-- library, because "which of my entities still has no picture" is a question
-- about the library, not about the reader's current position.
CREATE POLICY entity_images_ingest_all ON entity_images
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT ON entity_images TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_images TO app_ingest;

COMMENT ON TABLE entity_images IS
  'External illustrations attached to extracted entities. Never evidence: no '
  'assertion may cite one. Visible from the chapter that reveals the label '
  'which matched it.';

COMMENT ON COLUMN entity_images.revealed_in_chapter IS
  'Revelation chapter of the label that produced the match — not the entity''s '
  'first appearance. A portrait found by a true name must not precede it.';
