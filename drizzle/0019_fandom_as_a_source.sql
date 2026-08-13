-- The wiki, as a fourth source of pictures.
--
-- The three catalogues cover famous characters, the known Devil Fruits, sixteen
-- ships and thirty-one islands. The graph is full of everything else: a bar, a
-- village, a crew, a race, a title. None of those has a row in any catalogue,
-- and until now none of them was even *queued* for illustration — the run
-- reported them as nothing at all rather than as unmatched, so "why does the
-- Partys Bar have no picture" had no answer anywhere.
--
-- The wiki answers one title at a time rather than handing over a catalogue, so
-- it is asked only about what the catalogues could not place, and only when a
-- name exists to ask with. An article must really exist under that title —
-- after page redirects, never a redirect into a section of a larger page, which
-- is the wiki saying it has no article for this thing and would otherwise hand
-- back a picture of something else.
--
-- This constraint is why the feature could not simply be written in the
-- application: the database keeps the list of sources it will accept, and it
-- refused every row until this migration. That is the check working.

ALTER TABLE entity_images
  DROP CONSTRAINT IF EXISTS entity_images_source_known;

ALTER TABLE entity_images
  ADD CONSTRAINT entity_images_source_known
  CHECK (source IN ('onepieceapi', 'api-onepiece', 'anilist', 'fandom', 'manual'));

COMMENT ON CONSTRAINT entity_images_source_known ON entity_images IS
  'Sources a picture may come from. Adding one is a migration on purpose: the '
  'caption shown to the reader names the source, and an unknown value there '
  'would be a provenance nobody can check.';
