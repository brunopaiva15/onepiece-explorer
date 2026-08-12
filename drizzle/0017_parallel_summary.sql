-- The same chapter, in the other language.
--
-- Migration 0016 stopped the model from guessing French names by recording your
-- answers in a glossary. It works, and it starts empty: the first chapter of a
-- work asks about every term at once, and it asks with only one side of the
-- evidence. A model reading « Straw Hat Pirates » in English has to decide
-- whether French readers say « Équipage du Chapeau de Paille » or keep the
-- English — a convention it cannot find in the text it was given, because the
-- text it was given is the English one.
--
-- If you have both versions of the chapter, that answer is no longer a guess.
-- The English sentence and its French counterpart, side by side, *contain* the
-- correspondence: whoever wrote the French summary already made the naming
-- decision, chapter by chapter, and the model only has to read it off. So a
-- chapter can now carry a second text, in the other language, purely so that
-- naming stops being invention.
--
-- What it is emphatically not is a second source. Nothing in it can be cited.
-- Evidence anchors against the passages of the primary text and only those, the
-- extraction step never puts its refs in the allowed list, and a proposal that
-- cites it is quarantined by the same check that catches an invented reference.
-- Two citable texts would mean the same fact proposed once per language, a
-- reviewer deciding twice, and an entity sheet mixing languages with no rule
-- saying which wins. The gain here is naming; the cost of taking more than that
-- is paid in the one place this project cannot afford it.
--
-- Stored as one text rather than as passages, which reverses the reasoning of
-- 0015 for a reason that only holds here. That note refused a raw copy of the
-- *citable* summary beside its passages: two texts that can disagree, and an
-- excerpt checked against one while the other is on screen. A text that can
-- never be cited has nothing to disagree with — no excerpt is ever compared to
-- it — so a single column is the whole truth about it, and giving it passages
-- would only invite the mistake of citing them.

ALTER TABLE chapters
  ADD COLUMN parallel_text text,
  -- The language it is written in. Always the other one: a second text in the
  -- same language as the first is a paste that went wrong, and the import
  -- refuses it rather than handing the model the same sentences twice.
  ADD COLUMN parallel_language text
  CONSTRAINT chapters_parallel_language_check
    CHECK (parallel_language IS NULL OR parallel_language IN ('fr', 'en')),
  -- Both or neither. A language with no text says nothing; a text with no
  -- language would be handed to the model as "here is the other version" with
  -- no way to say which side of the pair it is, which is the one thing the
  -- prompt has to state.
  ADD CONSTRAINT chapters_parallel_pair_check
    CHECK ((parallel_text IS NULL) = (parallel_language IS NULL));

COMMENT ON COLUMN chapters.parallel_text IS
  'The same chapter written in the other language. A naming aid for extraction, '
  'never a citable source: no evidence may anchor against it.';

COMMENT ON COLUMN chapters.parallel_language IS
  'Language of parallel_text, always different from chapters.language.';
