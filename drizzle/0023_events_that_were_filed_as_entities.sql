-- Un événement rangé au mauvais endroit, remis où les événements vont.
--
-- The extraction returns four lists — entities, assertions, events, mysteries —
-- and the ontology also carries `event` and `mystery` as node *types*, because a
-- relation has to be able to point at one: `participates_in` takes an event,
-- `resolves_mystery` takes a mystery. The prompt listed the predicates and never
-- listed the types, so the only statement of what a type meant was the arrows in
-- the predicate signatures. A model reading that proposes a scene as an entity
-- of type `event`, with the sentence for a name, and every check downstream
-- agrees with it: the type exists, the evidence anchors, the card says
-- « entité » and shows a sentence — which is exactly what an event card shows.
--
-- What it produced is an `entities` row with no row in `events`, and that is
-- not a cosmetic difference. It is absent from the chronology, which reads
-- `events`. It is absent from story mode's « il arrive », which reads it too,
-- and is caught instead by the arm that announces whoever has no beat of their
-- own — so a chapter's six scenes arrived as six characters walking on,
-- labelled « entre en scène · Événement ». It carries no `is_flashback`, so a
-- flashback lands on the timeline as if it happened now; one chapter has the
-- marker written into the prose — « Flashback : Shanks et Buggy, jeunes
-- pirates… » — which is the model saying the thing it had no field for.
--
-- The prompt now names the node types and says which list a scene goes in
-- (PROMPT_VERSION 6), and the extraction refiles one that arrives misfiled
-- anyway. This is for the rows already written. Re-importing the chapter would
-- not have healed them: publication joins an accepted entity carrying the same
-- normalised label at the same node type, so the second pass would find these
-- and reuse them — still with no `events` row.
--
-- Nothing is deleted and nothing is re-labelled. The entity keeps its id, its
-- name and its evidence; it gains the row that says what it is. `is_flashback`
-- stays false because nothing in an entity proposal ever said otherwise, and
-- guessing it from the wording would put a scene at the wrong place on the
-- story axis — which is the one thing the two-axis timeline exists to get
-- right. A memory imported this way is on the chronology at its chapter, and
-- can be corrected there.
--
-- ET LES COMBATS PARMI EUX
--
-- La 0022 relit le résumé de chaque événement pour retrouver les combats, et
-- elle part de `events` — donc précisément pas de ces lignes-là, qui n'y
-- figuraient pas encore. Une scène soignée ici reste un événement ordinaire,
-- même si c'est un duel. C'est le même arbitrage que la 0022 énonce pour
-- elle-même : un combat manqué reste un événement, ce qu'il était hier, et
-- cela ne coûte rien ; l'inverse est une affirmation fausse sur l'histoire. Le
-- type se change depuis la fiche de l'entité, une scène à la fois, par
-- quelqu'un qui a lu le chapitre.

INSERT INTO events (entity_id, user_id, work_id, summary, is_flashback, shown_in_chapter)
SELECT en.id,
       en.user_id,
       en.work_id,
       -- Its own name is the sentence, which is what an event's summary is.
       (SELECT l.label FROM entity_labels l
         WHERE l.entity_id = en.id
         ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
         LIMIT 1),
       false,
       en.first_seen_chapter
  FROM entities en
 WHERE en.node_type = 'event'
   AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id = en.id)
   -- An entity with no name at all cannot be an event: an event is named by
   -- its summary, and a row with a null summary would show as a blank line.
   AND EXISTS (SELECT 1 FROM entity_labels l WHERE l.entity_id = en.id)
ON CONFLICT (entity_id) DO NOTHING;

-- The same, for a question proposed as an entity of type `mystery`. It never
-- reached /mysteres, which reads this table, and « ouvert au chapitre » is the
-- chapter it was first seen — the only date any of these rows carries.
INSERT INTO mysteries (entity_id, user_id, work_id, question, opened_in_chapter, state)
SELECT en.id,
       en.user_id,
       en.work_id,
       (SELECT l.label FROM entity_labels l
         WHERE l.entity_id = en.id
         ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
         LIMIT 1),
       en.first_seen_chapter,
       'open'
  FROM entities en
 WHERE en.node_type = 'mystery'
   AND NOT EXISTS (SELECT 1 FROM mysteries m WHERE m.entity_id = en.id)
   AND EXISTS (SELECT 1 FROM entity_labels l WHERE l.entity_id = en.id)
ON CONFLICT (entity_id) DO NOTHING;
