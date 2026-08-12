-- English, as a display layer.
--
-- Migration 0018 let the reader choose a language. This one gives the site
-- something to show them. The rule, decided once and applied everywhere: the
-- graph keeps ONE canonical form — French — and English is carried alongside
-- it, never instead of it. Two canonical texts would mean every fact proposed
-- once per language, a reviewer deciding twice, and no rule about which wins
-- when they drift; 0016 and 0017 already refused that trade and nothing about
-- a bilingual interface changes the arithmetic.
--
-- Four surfaces, four small additions:
--
--   1. The ontology speaks both languages. `label_en` beside `label_fr` on
--      node_types and predicates. Reference data, seeded by db-push for the
--      builtin rows; a user-created row without an English label falls back to
--      its French one at display time.
--
--   2. The glossary becomes a two-way correspondence. 0016 recorded
--      source_term → french_term; `english_term` records the English side when
--      it is known — mechanically when the source chapter was English (the
--      source wording IS the English form), or read off the parallel text of
--      0017. Nullable on purpose: an English form the system never saw is a
--      fact it does not have, and inventing one is the exact guessing 0016
--      exists to stop.
--
--   3. An entity label knows its language. Existing rows are French — that has
--      been the authored output language since the first prompt — so the
--      default backfills them correctly. English rows are added at publication
--      when the English form is known, with the same kind and the same
--      revealed_in_chapter as their French twin: a name the reader has not met
--      in one language is still a name they have not met in the other.
--      Display picks the best label in the reader's language and falls back to
--      French; resolution, embedding and conflict detection keep reading only
--      the French rows, so the graph's internal vocabulary stays single.
--
--   4. Search stems each text in its own language. The generated tsvector of
--      0010 pinned fr_unaccent into storage; it becomes a CASE on the row's
--      language, so « Marées » and "tides" each meet the stemmer that
--      understands them. events, mysteries and panels keep the French config —
--      their text is canonical French by construction.

-- ---------------------------------------------------------------------------
-- An English text-search configuration, the exact twin of fr_unaccent (0010):
-- unaccent folded into the dictionary chain so it stays usable from generated
-- columns, for the same IMMUTABLE reason explained there.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'en_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION en_unaccent (COPY = english);
  END IF;
END
$$;

ALTER TEXT SEARCH CONFIGURATION en_unaccent
  ALTER MAPPING FOR hword, hword_part, word, asciiword, asciihword, numword
  WITH unaccent, english_stem;

-- ---------------------------------------------------------------------------
-- 1. Ontology labels.
-- ---------------------------------------------------------------------------

ALTER TABLE node_types ADD COLUMN label_en text;
ALTER TABLE predicates ADD COLUMN label_en text;

COMMENT ON COLUMN node_types.label_en IS
  'English display label. NULL falls back to label_fr; builtin rows are seeded.';
COMMENT ON COLUMN predicates.label_en IS
  'English display label. NULL falls back to label_fr; builtin rows are seeded.';

-- ---------------------------------------------------------------------------
-- 2. The English side of a naming decision.
-- ---------------------------------------------------------------------------

ALTER TABLE glossary_terms ADD COLUMN english_term text;

COMMENT ON COLUMN glossary_terms.english_term IS
  'The English form of this term, when the system has seen one: the source '
  'wording of an English chapter, or the correspondence read off a parallel '
  'text. NULL means no English form is known — display falls back to French.';

-- ---------------------------------------------------------------------------
-- 3. Labels carry their language.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_labels
  ADD COLUMN lang text NOT NULL DEFAULT 'fr'
  CONSTRAINT entity_labels_lang_check CHECK (lang IN ('fr', 'en'));

COMMENT ON COLUMN entity_labels.lang IS
  'Language of this label. French rows are the canonical graph vocabulary; '
  'English rows exist only for display and lexical search, added at '
  'publication when the English form is known and differs from the French.';

-- The display query becomes "best label in my language at my boundary, else
-- best French one" — same shape as entity_labels_entity_idx with the language
-- in front of the ordering columns.
CREATE INDEX entity_labels_lang_idx
  ON entity_labels (entity_id, lang, revealed_in_chapter, precedence DESC);

-- ---------------------------------------------------------------------------
-- 4. Language-aware indexing where the text itself can be English.
--
-- A generated column cannot change expression in place: drop and re-add. The
-- rewrite is proportional to the table, which is fine at library scale, and
-- dropping the column drops its GIN index — recreated below.
--
-- text_blocks has carried `lang` since 0003; NULL means French, as every
-- existing row was.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_labels DROP COLUMN IF EXISTS search_vector;
ALTER TABLE entity_labels
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      CASE WHEN lang = 'en' THEN 'en_unaccent'::regconfig
           ELSE 'fr_unaccent'::regconfig END,
      coalesce(label, '')
    )
  ) STORED;

ALTER TABLE text_blocks DROP COLUMN IF EXISTS search_vector;
ALTER TABLE text_blocks
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      CASE WHEN lang = 'en' THEN 'en_unaccent'::regconfig
           ELSE 'fr_unaccent'::regconfig END,
      coalesce(text, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS entity_labels_search_idx ON entity_labels USING gin (search_vector);
CREATE INDEX IF NOT EXISTS text_blocks_search_idx   ON text_blocks   USING gin (search_vector);
