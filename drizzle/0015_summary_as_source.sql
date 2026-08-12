-- A chapter can be a text you wrote.
--
-- Until now a chapter was a file: pages, panels, bounding boxes, OCR. That
-- path worked and cost too much — a hundred and twenty vision calls to turn
-- drawings back into sentences, three to five minutes a slice, four dollars a
-- chapter, with more than a thousand chapters to go. The pixels were never the
-- point. What the pipeline actually needed from a page was *prose*, and there
-- is a shorter way to get prose: write it.
--
-- So the source becomes a detailed written summary of the chapter, and every
-- guarantee this project rests on survives the change intact — one of them
-- gets stronger:
--
--   The boundary is unchanged. A summary is written for chapter N, its
--   passages carry chapter_number = N, and the same row-level policies apply.
--
--   Evidence anchoring is unchanged *and sharper*. app.validate_evidence_anchor
--   already requires an excerpt to occur inside the text block it cites. On the
--   OCR path that comparison ran against an approximation of what was drawn; on
--   this path it runs against the exact characters you typed. A model that
--   embroiders is caught by string comparison, as before, with no OCR noise to
--   hide in.
--
--   "Zero external knowledge" is unchanged. The model still sees only the
--   supplied text and the entities already visible at this chapter.
--
-- What changes is where a passage lives. A paragraph of prose has no page and
-- no bounding box, and inventing a synthetic page for it would be a lie told
-- to satisfy a NOT NULL — a page row pointing at a stored image that does not
-- exist. Both columns become nullable instead, which says the true thing: this
-- block of text came from somewhere that has no geometry.

ALTER TABLE text_blocks ALTER COLUMN page_id DROP NOT NULL;
ALTER TABLE text_blocks ALTER COLUMN bbox    DROP NOT NULL;

-- Passages are ordered within a chapter, not within a page. The existing index
-- is (page_id, reading_order) and cannot serve a query whose page_id is null.
CREATE INDEX text_blocks_chapter_order_idx ON text_blocks (chapter_id, reading_order);

-- --------------------------------------------------------------------------
-- What kind of source a chapter has.
--
-- Derivable — no pages and some text blocks means a summary — and deliberately
-- not derived. The pipeline decides from this column which steps apply, and a
-- chapter whose import died between creating the row and writing its passages
-- would derive as "summary with nothing in it" or "pages with nothing in it"
-- depending on the order of two writes. A declared kind is a fact about intent;
-- an inferred one is a guess about a half-finished state.
--
-- 'pages' stays the default so that every chapter imported before today keeps
-- describing itself correctly without a data migration.
-- --------------------------------------------------------------------------
ALTER TABLE chapters
  ADD COLUMN source_kind text NOT NULL DEFAULT 'pages'
  CONSTRAINT chapters_source_kind_check CHECK (source_kind IN ('pages', 'summary'));

COMMENT ON COLUMN chapters.source_kind IS
  'pages: imported from a file, panels and OCR apply. '
  'summary: a written text, whose paragraphs are the citable source.';

-- --------------------------------------------------------------------------
-- Not done here, on purpose.
--
-- No new enum value for text_source or text_block_kind. A passage you typed is
-- exactly source = 'manual' and kind = 'other', both of which already exist and
-- already mean what is meant. Adding 'summary' and 'passage' beside them would
-- be two enum values earning their keep by looking tidier in a table dump,
-- against ALTER TYPE ... ADD VALUE, which cannot be used in the same
-- transaction that adds it.
--
-- No table for the raw summary text either. The passages are the source; the
-- source view joins them back together. Storing the original beside them would
-- create two texts that can disagree, and the one shown on screen would not be
-- the one an excerpt is checked against — which is the entire guarantee.
-- --------------------------------------------------------------------------
