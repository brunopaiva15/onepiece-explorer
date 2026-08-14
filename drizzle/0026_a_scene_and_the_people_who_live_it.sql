-- Une scène et les gens qui la vivent — pour les chapitres déjà publiés.
--
-- An event is a node like any other, and until now it was a node joined to
-- nothing. Publication recorded a scene's cast as *presence* — a row saying
-- « Nami est au chapitre 14 » — and an occurrence points at a chapter, never at
-- the event, so no row anywhere said « Nami est dans *cette* scène ». The graph
-- drew the consequence honestly: a library of fifty chapters showed several
-- hundred events and combats as a halo of loose dots around everything else,
-- each of degree zero, reachable from no character's fiche and joined to no
-- place. A chapter imported as a written summary produces mostly events, so
-- this was not the exotic case — it was most of the graph.
--
-- The cast was never in doubt. The extraction states it, anchoring filters the
-- identifiers it could not resolve, the review card lists the names, and the
-- reviewer accepted the card with them on it. Nothing here is inferred, guessed
-- or re-read from the text: this replays, as relations, the answer that was
-- stored all along — exactly what publication now writes for a new chapter
-- (`linkCast`).
--
-- WHICH RELATION, AND WHY NOT ONE
--
-- `participants` is a flat list of whoever the passage put in the scene, and
-- the ontology does not accept them all on the same predicate:
--
--   * a character or a group *takes part* — « participe à », pointing from them
--     at the scene, which is the direction the fiche reads to fill its
--     « Participants » section;
--   * a place is *where it happened* — « se trouve à », pointing from the scene
--     at the place, since that is the direction the ontology gives it.
--
-- Anything else — a fruit, an espèce, a mystère among the participants — gets
-- no relation. Not an oversight: no predicate in the ontology carries « an
-- object was involved in an event », and adding one from inside a migration
-- would be extending the ontology by data repair. Their presence rows are
-- untouched, so nothing is lost.
--
-- QUATRE LIMITES, CHACUNE VOULUE
--
--   * Only accepted proposals. A rejected scene, or a participant whose own
--     card was refused, describes something the reader decided was not there.
--   * Only pairs the graph does not already carry. The prompt asks the model
--     for « participe à » as well as for `participants`, so a compliant chapter
--     already has the relation; assertions are append-only, and a duplicate
--     written here could not be taken back.
--   * Only participants that resolve to an entity by one of the three routes
--     below. An identifier that resolves to nothing is skipped in silence — it
--     means that entity was rejected or deferred.
--   * Scenes that reached the graph as misfiled entities (migration 0023) carry
--     no `participants` — they were never event proposals — so they stay as
--     they are. Their cast can only come from re-reading the chapter.
--
-- Réversible : `UPDATE assertions SET review_status = 'rejected'` sur les
-- lignes visées ci-dessous les retire du graphe sans rien effacer, ce que le
-- déclencheur d'ajout-seul autorise explicitement. Elles se reconnaissent à
-- `pipeline_version IS NULL` avec l'un des deux prédicats.

WITH scene AS (
  /*
   * The event proposals that were published, with the decision applied — a
   * corrected payload is the one that reached the graph, so matching on the
   * model's own words alone would miss every scene the reviewer edited.
   */
  SELECT ri.run_id,
         ri.user_id,
         c.work_id,
         c.number                                    AS chapter_number,
         ri.proposal_fingerprint,
         ri.confidence,
         rd.decision                                 AS decision,
         COALESCE(rd.corrected_payload, ri.payload)  AS payload
    FROM review_items ri
    JOIN chapters c ON c.id = ri.chapter_id
    LEFT JOIN review_decisions rd
           ON rd.user_id = ri.user_id
          AND rd.work_id = c.work_id
          AND rd.proposal_fingerprint = ri.proposal_fingerprint
   WHERE ri.category = 'event'
     AND ri.status = 'accepted'
),
proposal AS (
  /*
   * The entity proposals of the same runs, for the third resolution route
   * below. Same decision-aware read, for the same reason.
   */
  SELECT ri.run_id,
         ri.user_id,
         COALESCE(rd.corrected_payload, ri.payload)->>'local_id'  AS local_id,
         COALESCE(rd.corrected_payload, ri.payload)->>'label'     AS label,
         COALESCE(rd.corrected_payload, ri.payload)->>'node_type' AS node_type
    FROM review_items ri
    JOIN chapters c ON c.id = ri.chapter_id
    LEFT JOIN review_decisions rd
           ON rd.user_id = ri.user_id
          AND rd.work_id = c.work_id
          AND rd.proposal_fingerprint = ri.proposal_fingerprint
   WHERE ri.category = 'entity'
     AND ri.status = 'accepted'
),
staged AS (
  /*
   * The entity each scene became, found the way publication finds one: the
   * summary is the label, cut to the same 200 characters, normalised the same
   * way. Restricted to the three occurrence types, so a character who happens
   * to be named with the same sentence cannot be mistaken for the scene.
   */
  SELECT s.*, en.id AS event_id
    FROM scene s
    JOIN entity_labels l
      ON l.user_id = s.user_id
     AND l.normalized_label = app.normalize_text(left(s.payload->>'summary', 200))
    JOIN entities en
      ON en.id = l.entity_id
     AND en.work_id = s.work_id
     AND en.node_type IN ('event', 'battle', 'voyage')
     AND en.review_status = 'accepted'
),
cast_member AS (
  SELECT st.*, p.value AS ref
    FROM staged st
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(st.payload->'participants') = 'array'
           THEN st.payload->'participants'
           ELSE '[]'::jsonb
      END
    ) AS p(value)
),
resolved AS (
  /*
   * A participant identifier is one of two things, and which one depends on
   * when the entity was published: a UUID for someone already in the graph, or
   * a local id like « e3 » for someone the same run proposed. The local id
   * needs two routes rather than one, because publication records
   * `proposal_local_id` on a row it *creates* and not on one it *reuses* — and
   * reuse is the common case, a character being re-proposed in every chapter
   * they appear in.
   *
   * Compared as text rather than cast to uuid: a `ref` that is not a UUID would
   * raise on the cast, and nothing guarantees the planner evaluates the guard
   * first.
   */
  SELECT DISTINCT
         cm.user_id,
         cm.work_id,
         cm.chapter_number,
         cm.proposal_fingerprint,
         cm.confidence,
         cm.decision,
         cm.event_id,
         pe.id        AS participant_id,
         pe.node_type AS participant_type
    FROM cast_member cm
    JOIN entities pe
      ON pe.user_id = cm.user_id
     AND pe.work_id = cm.work_id
     AND pe.review_status = 'accepted'
     AND pe.first_seen_chapter <= cm.chapter_number
     AND (
          -- (a) an identifier the model reused: the entity itself.
          pe.id::text = lower(cm.ref)
          -- (b) a local id, on the row that proposal created.
       OR (pe.run_id = cm.run_id AND pe.proposal_local_id = cm.ref)
          -- (c) a local id whose proposal joined an entity already in the graph.
       OR EXISTS (
            SELECT 1
              FROM proposal pr
              JOIN entity_labels pl
                ON pl.entity_id = pe.id
               AND pl.user_id = pr.user_id
               AND pl.normalized_label = app.normalize_text(pr.label)
             WHERE pr.run_id = cm.run_id
               AND pr.user_id = cm.user_id
               AND pr.local_id = cm.ref
               AND pr.node_type = pe.node_type
          )
     )
   WHERE pe.id <> cm.event_id
),
link AS (
  SELECT r.user_id,
         r.work_id,
         r.chapter_number,
         r.proposal_fingerprint,
         r.confidence,
         r.decision,
         CASE WHEN r.participant_type = 'place'
              THEN r.event_id ELSE r.participant_id END AS subject_id,
         CASE WHEN r.participant_type = 'place'
              THEN 'located_at' ELSE 'participates_in' END AS predicate,
         CASE WHEN r.participant_type = 'place'
              THEN r.participant_id ELSE r.event_id END AS object_id
    FROM resolved r
   WHERE r.participant_type IN ('character', 'group', 'place')
)
INSERT INTO assertions (
  work_id, user_id, subject_entity_id, predicate, object_entity_id,
  knowledge_from_chapter, observed_in_chapter, confidence,
  epistemic_status, review_status, proposed_by, proposal_fingerprint
)
/*
 * The earliest chapter that stated it, when several did. A relation is dated by
 * when the reader learnt it, and giving it the later chapter would hide from
 * the boundary slider something they have already read.
 */
SELECT DISTINCT ON (l.user_id, l.subject_id, l.predicate, l.object_id)
       l.work_id,
       l.user_id,
       l.subject_id,
       l.predicate,
       l.object_id,
       l.chapter_number,
       l.chapter_number,
       l.confidence,
       -- Stated by the extraction in the same answer that stated the scene; a
       -- fact affirmed, not a deduction. A scene the reviewer edited is theirs.
       CASE WHEN l.decision = 'correct' THEN 'user_validated' ELSE 'explicit' END::epistemic_status,
       'accepted'::review_status,
       CASE WHEN l.decision = 'correct' THEN 'user' ELSE 'ai' END::proposer,
       l.proposal_fingerprint
  FROM link l
 WHERE NOT EXISTS (
         SELECT 1
           FROM assertions a
          WHERE a.user_id = l.user_id
            AND a.subject_entity_id = l.subject_id
            AND a.predicate = l.predicate
            AND a.object_entity_id = l.object_id
       )
 ORDER BY l.user_id, l.subject_id, l.predicate, l.object_id, l.chapter_number;

DO $$
DECLARE
  drawn    bigint;
  isolated bigint;
BEGIN
  SELECT count(*) INTO drawn
    FROM assertions
   WHERE predicate IN ('participates_in', 'located_at')
     AND pipeline_version IS NULL;

  SELECT count(*) INTO isolated
    FROM entities en
   WHERE en.node_type IN ('event', 'battle', 'voyage')
     AND NOT EXISTS (
           SELECT 1 FROM assertions a
            WHERE a.subject_entity_id = en.id OR a.object_entity_id = en.id
         );

  RAISE NOTICE 'scènes reliées à leur distribution : % relations ; scènes encore isolées : %',
    drawn, isolated;
END
$$;
