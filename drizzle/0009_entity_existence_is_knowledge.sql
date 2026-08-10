-- ---------------------------------------------------------------------------
-- An entity's existence is knowledge.
--
-- Migration 0005 gave `entities` an ownership-only policy while filtering its
-- labels, its assertions and its evidence by the boundary. The reasoning was
-- that a node with no visible label and no visible relation is anonymous and
-- therefore harmless. It is not:
--
--   * the count leaks. "There are 87 characters you have not met" is a fact
--     about chapters the reader has not read.
--   * `first_seen_chapter` is a readable column. Reading it tells you a
--     character appears at chapter 300 — which is exactly the shape of spoiler
--     the whole design exists to prevent.
--   * `node_type` is readable too, so "twelve more Devil Fruits exist" leaks
--     the same way.
--
-- Demonstrated before writing this: at boundary 3, with one entity whose
-- first_seen_chapter is 300, `SELECT count(*) FROM entities` as `authenticated`
-- returned 1, and its first_seen_chapter read back as 300.
--
-- Fixing it in the projection query would have worked and would have been the
-- wrong place — ADR 0001 exists precisely because a query somebody writes in
-- six months must not be able to reintroduce this.
--
-- `first_seen_chapter` is the right column to filter on: it is the chapter the
-- entity was introduced by, set at publication from the chapter that revealed
-- it, never from the import order.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS entities_owner_select ON entities;

CREATE POLICY entities_boundary_select ON entities
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND review_status = 'accepted'
    AND first_seen_chapter <= app.boundary()
  );

-- The index that makes the predicate cheap. Without it every graph read scans
-- the entity table, and this predicate now runs on every one of them.
CREATE INDEX IF NOT EXISTS entities_boundary_idx
  ON entities (user_id, first_seen_chapter)
  WHERE review_status = 'accepted';

-- ---------------------------------------------------------------------------
-- The same reasoning applied to the two side tables.
--
-- `events` and `mysteries` are keyed by entity_id and already carry their own
-- boundary predicates, but they join back to `entities` — so before this
-- migration they were filtered while their parent row was not, which is the
-- kind of asymmetry that produces a half-visible node.
--
-- Nothing to change in their policies; the entity policy above now closes the
-- gap for both. This comment exists so the next person does not go looking for
-- a missing filter that is deliberately absent.
-- ---------------------------------------------------------------------------
