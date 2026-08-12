-- The French name, decided once.
--
-- The best chapter summaries on the internet are often English, and the graph
-- is read in French, so the extraction step is asked to author French labels
-- from an English source. Most of that is unambiguous. Some of it is not:
-- «  the Red-Haired Pirates » has an obvious French form and «  Going Merry »
-- has none, and there is no way for a model to know which of those it is
-- looking at — the distinction is a convention, held by the reader, not a fact
-- in the text.
--
-- A model asked to decide anyway will decide, silently and differently each
-- time: «  Équipage du Roux » in chapter 1, «  Pirates aux Cheveux Rouges » in
-- chapter 4, and two entities where there is one person. That failure is not
-- caught by evidence anchoring, because both labels are honestly derived from
-- the source; it is only caught by someone noticing the graph has split.
--
-- So the model stops guessing and asks. An entity whose naming it is unsure of
-- is queued for explicit review with the source wording attached, you answer
-- once, and the answer is recorded here. Every later chapter of the same work
-- receives the glossary in its prompt as settled vocabulary — the question is
-- asked once per term, not once per chapter.
--
-- This is the same shape as review_decisions, which makes a correction survive
-- a re-import. Here it makes a naming decision survive the *next* chapter.

CREATE TABLE glossary_terms (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_id            uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  -- The wording as the source has it, quoted exactly: this is what a later
  -- chapter's model will recognise.
  source_term        text NOT NULL,
  normalized_source  text NOT NULL,
  -- What it is called in the graph. Your decision, not a proposal.
  french_term        text NOT NULL,
  note               text,
  /*
   * When you decided, and therefore when the term may be used.
   *
   * A glossary entry is knowledge: learning that «  the man with the scar » is
   * to be called «  Shanks » is the chapter-1 reveal itself. Feeding the whole
   * glossary to a chapter-3 extraction would hand the model vocabulary the
   * reader has not met, which is the leak this project exists to prevent —
   * exactly the reasoning of migration 0009 for entity existence.
   */
  decided_in_chapter integer NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- One French form per source term, per work. Answering again replaces the
  -- answer rather than creating a rival.
  UNIQUE (work_id, normalized_source)
);

CREATE INDEX glossary_terms_lookup
  ON glossary_terms (work_id, decided_in_chapter);

ALTER TABLE glossary_terms ENABLE ROW LEVEL SECURITY;

-- Bounded like everything else that carries a revelation. Reading your own
-- glossary at chapter 3 shows the terms settled by chapter 3.
CREATE POLICY glossary_terms_boundary_select ON glossary_terms
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    AND decided_in_chapter <= app.boundary()
  );

CREATE POLICY glossary_terms_ingest ON glossary_terms
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT ON glossary_terms TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON glossary_terms TO app_ingest;
