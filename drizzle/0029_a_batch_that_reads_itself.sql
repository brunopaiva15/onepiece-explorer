-- A chapter that publishes itself, and hands back only the real questions.
--
-- Migration 0021 gave a batch import a queue: twenty chapters imported at once,
-- processed one at a time, each run starting when the chapter before it was
-- published. That ordering is not a preference — `runResolve` compares a
-- proposed entity only against entities *already in the graph*, and only a
-- publication puts one there.
--
-- What it did not say is who publishes. The answer was: a person, every time,
-- through eighty-six review cards per chapter. So a batch of twenty imported in
-- one click, ran one chapter, and stopped — waiting on an event that would take
-- the rest of the afternoon to produce nineteen times.
--
-- The automatic pass that decides everything a name does not depend on already
-- existed (`domains/review/auto.ts`), behind AUTO_REVIEW_NAMES_ONLY. An
-- environment variable is the wrong shape for this: it is all-or-nothing across
-- the library, it cannot be answered per import, and turning it on to catch up
-- on a hundred chapters would silently change how the next single chapter is
-- reviewed months later.
--
-- This column carries the answer where it belongs — on the chapter that was
-- imported under it. A chapter with `auto_review` publishes what needs nobody,
-- keeps back what does (a name the model hesitated on, an identity question, a
-- contradiction, a relation the ontology refuses) and, when nothing is left
-- proposed, opens itself — which is exactly the event the queue waits for. A
-- chapter imported on its own does not carry it and reviews the way it always
-- did.
--
-- It stays set after the run, deliberately. Answering the held question in the
-- review centre must release the rest the same way, and re-processing the
-- chapter later must behave the way its import asked for rather than the way
-- the environment happens to be configured that day.

ALTER TABLE chapters
  ADD COLUMN IF NOT EXISTS auto_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN chapters.auto_review IS
  'True when this chapter was imported to be processed and published without a '
  'stop: the run accepts every proposal that needs no human, holds back names, '
  'identities and contradictions, and opens the chapter when nothing is left. '
  'Set by a batch import that asked for it; never set by a single import.';

-- The only read there is: "does the chain still hold a chapter that needs me",
-- for one reader. Partial, because these are a handful of rows out of a library.
CREATE INDEX IF NOT EXISTS chapters_auto_review_idx
  ON chapters (user_id, number)
  WHERE auto_review;
