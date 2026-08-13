-- A chapter that is waiting its turn.
--
-- Importing ten chapters in one go is cheap; *processing* ten in one go loses
-- the one thing the resolution step is for. `runResolve` compares a proposed
-- entity only against entities already in the graph at that chapter, and nothing
-- enters the graph until a human publishes it. Ten runs launched together each
-- see the graph as it stood before the batch.
--
-- What that costs is not the obvious thing, and the obvious thing is already
-- handled: publication joins an accepted entity carrying exactly the same
-- normalised name (`exactTwin`), so a character re-proposed under an identical
-- name across chapters 12 to 21 still lands on one node. That mitigation exists
-- because importing far ahead of review is normal here.
--
-- What is lost is everything weaker than an exact name — an alias, a descriptor,
-- a spelling variant, a French form of an English one. « L'homme au tablier de
-- cuir » in chapter 12 and « Kaelo Renn » in chapter 13 are the same person and
-- share no characters; only `runResolve` can raise that question, only against
-- entities already in the graph, and it is never asked again afterwards. Run the
-- batch in parallel and you get two entities and no rapprochement to decide —
-- silently, which is the part that matters. That is the case the resolution step
-- exists for, and the one a batch would quietly skip.
--
-- The secondary cost is volume: extraction is handed the already-accepted
-- entities as known, so a blind run re-proposes what you have already decided,
-- and the review queue fills with copies of answered questions.
--
-- So the batch imports the texts and processes them one at a time, each run
-- starting when the previous chapter is published and its entities are in the
-- graph to be matched against. This column is what makes that queue a fact in
-- the database rather than an inference.
--
-- It has to be stored, not derived. "The next chapter with no run" would sweep
-- up a chapter deliberately imported with « lancer le traitement » unticked —
-- turning an explicit choice not to spend into a spend, hours later, triggered
-- by something else entirely. A chapter is in the queue because it was put
-- there.

ALTER TABLE chapters
  ADD COLUMN IF NOT EXISTS queued_for_run boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN chapters.queued_for_run IS
  'True while this chapter waits for the previous one to be published before '
  'its own run starts. Set by a batch import, cleared when the run is launched '
  'or when the queue is abandoned. Never set for a chapter imported on its own: '
  'unticking "lancer le traitement" must stay a decision, not a delay.';

-- The only read there is: the lowest-numbered chapter still waiting, for one
-- reader. Partial, because the rows that matter are a handful out of a library.
CREATE INDEX IF NOT EXISTS chapters_queued_idx
  ON chapters (user_id, number)
  WHERE queued_for_run;
