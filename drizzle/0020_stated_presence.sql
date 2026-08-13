-- Seen, or merely spoken of — said rather than guessed.
--
-- `occurrence_kind` has carried `appearance | mention` since the schema was
-- written, and publication derived it from the *medium* of the evidence: a
-- drawing was an appearance, text was a mention. That was true of scanned pages
-- and became meaningless the day a chapter became prose. Everything is text
-- now, so every occurrence ever written says `mention`, including the ones
-- about characters who are plainly on the page.
--
-- The distinction can only come from the model reading the passage — « Koby
-- parle de Zoro » against « Zoro dégaine » — so the extraction states it and
-- publication records what was stated.
--
-- Which leaves the rows already written, and they are the reason for this
-- column rather than a rewrite. They are not wrong so much as uninformative:
-- they mean "there was text evidence", not "this was a mention". Reading them
-- as the latter would turn every character in an existing library into someone
-- merely spoken of. So they keep their meaning and are ignored, and only rows
-- flagged here are read as a statement about presence.
--
-- Nothing is deleted. A row that meant little still means what it meant.

ALTER TABLE occurrences
  ADD COLUMN IF NOT EXISTS stated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN occurrences.stated IS
  'True when the extraction declared this presence rather than it being '
  'inferred from the medium of the evidence. Only stated rows may be read as '
  '"seen" versus "spoken of"; the rest predate the field and mean only that '
  'evidence of some kind existed.';

-- The read the story thread makes: is there a stated presence of this kind for
-- this entity, at or before this chapter.
CREATE INDEX IF NOT EXISTS occurrences_stated_idx
  ON occurrences (entity_id, kind, chapter_number)
  WHERE stated;
