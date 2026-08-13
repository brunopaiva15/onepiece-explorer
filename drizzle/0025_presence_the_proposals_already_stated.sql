-- Entendre parler de quelqu'un n'est pas le voir — pour les chapitres publiés avant.
--
-- `occurrences.stated` exists because the medium of the evidence stopped being
-- a usable signal the day a chapter could be prose: a scanned page distinguishes
-- a drawing from a caption, a written summary is text all the way down, so
-- everything derived from it was a `mention` and the distinction was gone. The
-- extraction states it instead — `presence` on every proposal — and publication
-- records that answer with `stated = true`.
--
-- All of which arrived after this library's first twenty chapters were already
-- published. Their occurrences carry `stated = false`, which is not a claim
-- that nobody was seen: it is the absence of an answer, and story mode reads it
-- as exactly that. Its fallback is deliberate and documented — with no stated
-- row, the old behaviour holds and the entity walks on — because reading those
-- rows as « merely mentioned » would have demoted every character in every
-- library imported before the column existed.
--
-- The cost of that fallback is that it never ends. Zoro is spoken of at chapter
-- 2 and seen at chapter 3; Koby names him, he is nowhere on the page. The graph
-- has always known this — the proposal said `presence: mention` — and the fiche
-- says « entre en scène · Roronoa Zoro » at chapter 2 regardless, because the
-- row that would have said otherwise was written before there was a column to
-- write it in. A correction that only applies to the next import leaves the
-- chapters already read wrong for good, and nothing anywhere says so.
--
-- So this replays the answers that were stored all along. `review_items` keeps
-- every proposal with its payload, and a proposal published before this column
-- existed still carries the `presence` the model gave it. Nothing here is
-- inferred, guessed, or re-read from the text: where the proposal stated an
-- answer, that answer becomes the row publication would have written.
--
-- Three limits, each on purpose:
--
--   * Only where no stated row exists for that entity and chapter. A chapter
--     published after the column arrived has its answer already, and this must
--     not add a second one beside it.
--   * Only proposals that were accepted. A rejected one describes something the
--     reader decided was not there.
--   * Chapters extracted before `presence` was in the schema have no answer to
--     replay, and none is invented for them. In this library that is chapters 1
--     to 8, and their occurrences stay exactly as they are — the fallback keeps
--     applying, which is the correct behaviour for « nobody ever said ».
--
-- Reversible in one statement: `DELETE FROM occurrences WHERE stated AND ...`
-- by created_at, or simply set `stated = false` on the rows this inserted.

INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated,
                         chapter_number, confidence)
SELECT DISTINCT
       en.id,
       en.user_id,
       ri.chapter_id,
       (COALESCE(rd.corrected_payload->>'presence', ri.payload->>'presence'))::occurrence_kind,
       true,
       c.number,
       -- The proposal's own confidence where it carries one. `occurrences`
       -- defaults this to 1 and nothing reads it as a threshold; keeping the
       -- number the model gave is simply more honest than inventing certainty.
       COALESCE((ri.payload->>'confidence')::real, 1)
  FROM review_items ri
  JOIN chapters c ON c.id = ri.chapter_id
  /*
   * The decision, because a corrected proposal is the one that was published.
   * « Freaky Domingos » reached the graph from a naming answer, not from the
   * payload the model wrote, and matching on the payload alone would miss it.
   */
  LEFT JOIN review_decisions rd
         ON rd.user_id = ri.user_id
        AND rd.work_id = c.work_id
        AND rd.proposal_fingerprint = ri.proposal_fingerprint
  /*
   * The entity the proposal produced, found the way publication finds it:
   * exact normalised label, same node type, same owner, visible at this
   * chapter. That is `exactTwin`, which is what joined this proposal to this
   * row in the first place — so this cannot land somewhere publication would
   * not have.
   */
  JOIN entity_labels l
    ON l.user_id = ri.user_id
   AND l.normalized_label = app.normalize_text(
         COALESCE(rd.corrected_payload->>'label', ri.payload->>'label'))
   AND l.revealed_in_chapter <= c.number
  JOIN entities en
    ON en.id = l.entity_id
   AND en.work_id = c.work_id
   AND en.node_type = COALESCE(rd.corrected_payload->>'node_type',
                               ri.payload->>'node_type')
   AND en.review_status = 'accepted'
   AND en.first_seen_chapter <= c.number
 WHERE ri.category = 'entity'
   AND ri.status = 'accepted'
   AND COALESCE(rd.corrected_payload->>'presence', ri.payload->>'presence')
       IN ('appearance', 'mention')
   AND NOT EXISTS (
         SELECT 1 FROM occurrences o
          WHERE o.entity_id = en.id
            AND o.chapter_id = ri.chapter_id
            AND o.stated
       );

DO $$
DECLARE
  restored bigint;
BEGIN
  SELECT count(*) INTO restored FROM occurrences WHERE stated;
  RAISE NOTICE 'présences explicites après reprise : %', restored;
END
$$;
