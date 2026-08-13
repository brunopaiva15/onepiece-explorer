-- ---------------------------------------------------------------------------
-- 0022 — Un visage d'avant l'ellipse.
--
-- Two years pass between the last page of chapter 597 and the first of 598.
-- Everyone comes back changed, and the changes are not cosmetic: Luffy carries
-- a scar across his chest, Zoro has lost an eye, Franky is a different machine.
-- They are the pay-off of the arc that precedes them.
--
-- The boundary already protected *when* a portrait may appear — 0012 dates each
-- one by the revelation chapter of the label that found it, so a face located
-- by a true name cannot precede that name. It said nothing about *which*
-- portrait, and that turned out to be the larger hole. « Nami » is named in
-- chapter 8, so her picture is visible from chapter 8; the picture the wiki
-- hands back for that name is whatever sits at the top of the article today,
-- and what sits at the top of the article today is
-- `Nami_Anime_Post_Timeskip_Infobox.png`. A reader forty chapters in was being
-- shown the woman she becomes six hundred chapters later, by a feature whose
-- entire job is to stop exactly that.
--
-- So a picture now carries the period it depicts, and the period is checked
-- against the reader's position by the same policy that checks the chapter.
--
-- ---------------------------------------------------------------------------
-- `unknown` is a value, not a gap.
--
-- The three catalogues hand over one portrait per character and say nothing
-- about when it depicts them. Recording that as `unknown` is the truth; reading
-- it as "probably the current artwork, therefore post-ellipse" would be a
-- guess, and hiding every undated portrait from every reader below 598 would
-- empty the graph of faces to act on that guess. An undated picture stays
-- visible at every position. Only a picture whose *source names it* as
-- post-ellipse is withheld — which, on the wiki, is most of the ones that
-- matter.
--
-- The constant lives twice, here and in src/domains/images/era.ts. It has to:
-- the policy is what enforces this, and a policy cannot import TypeScript.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_images
  ADD COLUMN era text NOT NULL DEFAULT 'unknown';

ALTER TABLE entity_images
  ADD CONSTRAINT entity_images_era_known
  CHECK (era IN ('pre_timeskip', 'post_timeskip', 'unknown'));

COMMENT ON COLUMN entity_images.era IS
  'Which side of the two-year ellipse this picture depicts, when the source '
  'says so. Existing rows are ''unknown'' because nothing recorded it and '
  'nothing can now infer it: re-run the enrichment to date them.';

-- The reader's own period first, then the undated, then the other one. Used by
-- the DISTINCT ON in imagesFor(); without it that ordering is a sort of the
-- whole table for entities that hold three pictures.
CREATE INDEX entity_images_era_idx ON entity_images (entity_id, era);

DROP POLICY IF EXISTS entity_images_boundary_select ON entity_images;

CREATE POLICY entity_images_boundary_select ON entity_images
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND revealed_in_chapter <= app.boundary()
    -- 597 is the last chapter before the ellipse; 598 opens two years later.
    -- A picture from before it is never withheld from a reader past it — it is
    -- out of date, which is not a spoiler.
    AND (era <> 'post_timeskip' OR app.boundary() > 597)
  );

COMMENT ON POLICY entity_images_boundary_select ON entity_images IS
  'A picture appears with the name that found it, and never shows a face from '
  'after the ellipse to a reader who has not reached chapter 598.';
