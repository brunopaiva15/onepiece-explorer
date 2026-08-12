-- Which proposal produced an entity.
--
-- Assertions have carried their provenance since the beginning — run_id and the
-- fingerprint of the proposal they came from — and entities never did. It cost
-- nothing while a chapter was published in one go, because the mapping from a
-- model's local id ("e1") to the row it created lived in memory for the length
-- of that one transaction.
--
-- It stops being free the moment a chapter is published in two batches, which is
-- exactly what reviewing only the names does: the entity whose French form is in
-- question is held back, the relations that name it are held with it, and both
-- are published later — in a different transaction, with a different in-memory
-- map. The relation then arrives with a subject of "e1", finds nothing, and
-- fails with "son entité a été rejetée ou reportée" about an entity that was in
-- fact accepted a second earlier.
--
-- Recording the local id and the run makes the mapping reconstructible instead
-- of remembered. Nullable, because entities created before this have no proposal
-- to point at and inventing one would be worse than admitting the gap.

ALTER TABLE entities
  ADD COLUMN run_id uuid REFERENCES ingestion_runs(id) ON DELETE SET NULL,
  -- The id the model used for this entity inside its own answer. Scoped to that
  -- answer, which is why it is stored beside the run rather than alone: "e1"
  -- means nothing without knowing which run said it.
  ADD COLUMN proposal_local_id text;

CREATE INDEX entities_proposal_idx
  ON entities (run_id, proposal_local_id)
  WHERE run_id IS NOT NULL;

COMMENT ON COLUMN entities.proposal_local_id IS
  'Local id from the extraction response that produced this entity, scoped to '
  'run_id. Lets a relation published in a later batch resolve its subject.';
