-- ---------------------------------------------------------------------------
-- 0011 — The default view is the whole graph, not an empty one.
--
-- `profiles.boundary_chapter` was NOT NULL DEFAULT 0, which meant a reader who
-- had never touched the slider had a boundary of chapter zero and saw nothing
-- at all. Every chapter they had imported, reviewed and published was hidden
-- from them by the feature meant to protect them.
--
-- That inverted the product. The point of dating everything by revelation
-- chapter is not to restrict the graph — it is to make the *whole* graph safe
-- to accumulate while you are still reading, and to let you rewind afterwards.
-- With the work fully imported, the default view is the complete
-- interconnected graph; the slider is a lens you reach for deliberately, not a
-- gate you have to unlock.
--
-- NULL is the right representation for "this reader has not chosen a
-- position". A sentinel like 999999 would work and would lie: it would claim a
-- choice was made. NULL says there is none, and the session resolves it to the
-- latest published chapter — so the default follows the library as it grows
-- instead of freezing at whatever number happened to be current on first login.
-- ---------------------------------------------------------------------------

ALTER TABLE profiles ALTER COLUMN boundary_chapter DROP NOT NULL;
ALTER TABLE profiles ALTER COLUMN boundary_chapter DROP DEFAULT;

-- Existing profiles sitting at 0 never made that choice — the column default
-- did. Anyone who genuinely wants chapter 0 can set it again in one drag, and
-- the alternative is a reader with a permanently blank graph and no clue why.
UPDATE profiles SET boundary_chapter = NULL WHERE boundary_chapter = 0;

COMMENT ON COLUMN profiles.boundary_chapter IS
  'Reader position. NULL = follow the latest published chapter, which is the '
  'default and shows the entire graph. A number is an explicit choice to look '
  'at a past state of the reader''s own knowledge.';
