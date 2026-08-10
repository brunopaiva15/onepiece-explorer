-- 0006 — Integrity that the type system cannot express.
--
-- Three invariants are enforced here rather than in application code, because
-- each of them being violated once silently corrupts the product's guarantees:
--
--   * assertions are append-only
--   * a predicate is only used between node types it declares
--   * a text-anchored excerpt really occurs in the block it cites
--
-- The application checks all three before writing. These triggers are the
-- backstop for the path nobody thought of.

-- --------------------------------------------------------------------------
-- Shared text normalisation.
--
-- MUST stay in lockstep with normalizeText() in
-- src/domains/knowledge/normalize.ts — a divergence would make the trigger
-- reject rows the application considers valid. A test asserts the two agree
-- on a shared corpus of cases.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.normalize_text(input text) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT btrim(
    regexp_replace(
      lower(unaccent(coalesce(input, ''))),
      '\s+', ' ', 'g'
    )
  )
$$;

GRANT EXECUTE ON FUNCTION app.normalize_text(text) TO authenticated, app_ingest;

-- --------------------------------------------------------------------------
-- updated_at
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER profiles_touch BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER chapters_touch BEFORE UPDATE ON chapters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER user_theories_touch BEFORE UPDATE ON user_theories
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- --------------------------------------------------------------------------
-- Assertions are append-only (ADR 0002)
--
-- Only two columns may change after insert:
--   review_status — a proposal becomes accepted or rejected
--   superseded_by — a correction points the old row at its replacement
--
-- Everything else is history. Rewriting it would make a past view
-- unreproducible, which is precisely what this product exists to prevent.
--
-- Deletion is refused unless the caller has explicitly opted in by setting
-- app.allow_destructive — the chapter-deletion path does, and it writes an
-- audit entry first. Nothing else should.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.assertions_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  superseding_author proposer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('app.allow_destructive', true), 'off') <> 'on' THEN
      RAISE EXCEPTION
        'Les assertions sont en ajout seul : une correction crée une nouvelle ligne et renseigne superseded_by. (assertion %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id                      IS DISTINCT FROM OLD.id
  OR NEW.work_id                 IS DISTINCT FROM OLD.work_id
  OR NEW.user_id                 IS DISTINCT FROM OLD.user_id
  OR NEW.subject_entity_id       IS DISTINCT FROM OLD.subject_entity_id
  OR NEW.predicate               IS DISTINCT FROM OLD.predicate
  OR NEW.object_entity_id        IS DISTINCT FROM OLD.object_entity_id
  OR NEW.object_value            IS DISTINCT FROM OLD.object_value
  OR NEW.knowledge_from_chapter  IS DISTINCT FROM OLD.knowledge_from_chapter
  OR NEW.knowledge_until_chapter IS DISTINCT FROM OLD.knowledge_until_chapter
  OR NEW.story_valid_from        IS DISTINCT FROM OLD.story_valid_from
  OR NEW.story_valid_until       IS DISTINCT FROM OLD.story_valid_until
  OR NEW.observed_in_chapter     IS DISTINCT FROM OLD.observed_in_chapter
  OR NEW.epistemic_status        IS DISTINCT FROM OLD.epistemic_status
  OR NEW.proposed_by             IS DISTINCT FROM OLD.proposed_by
  OR NEW.created_at              IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'Assertion % : seuls review_status et superseded_by peuvent changer après insertion.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A human correction is not overwritten by a later machine proposal.
  -- This is the durable half of "les corrections humaines survivent au
  -- retraitement": the fingerprint index short-circuits re-proposal, and this
  -- refuses the write if anything gets past it.
  IF OLD.locked
     AND NEW.superseded_by IS NOT NULL
     AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
  THEN
    SELECT proposed_by INTO superseding_author
      FROM assertions WHERE id = NEW.superseded_by;

    IF superseding_author = 'ai' THEN
      RAISE EXCEPTION
        'Assertion % : validée par l''utilisateur, elle ne peut pas être remplacée par une proposition de l''IA.', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assertions_append_only_trg
  BEFORE UPDATE OR DELETE ON assertions
  FOR EACH ROW EXECUTE FUNCTION app.assertions_append_only();

-- --------------------------------------------------------------------------
-- Predicate/type agreement (ADR 0004)
--
-- The ontology lives in data, so the database cannot express this as a type
-- constraint. It can still refuse a nonsensical edge — "a place is the parent
-- of an island" — before it reaches the graph.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.validate_assertion_types() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pred            predicates%ROWTYPE;
  subject_type    text;
  object_type     text;
BEGIN
  SELECT * INTO pred FROM predicates WHERE key = NEW.predicate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prédicat inconnu : %', NEW.predicate
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT node_type INTO subject_type FROM entities WHERE id = NEW.subject_entity_id;
  IF subject_type IS NULL OR NOT (subject_type = ANY (pred.subject_types)) THEN
    RAISE EXCEPTION
      'Le prédicat « % » n''accepte pas un sujet de type « % » (attendu : %).',
      NEW.predicate, COALESCE(subject_type, 'inconnu'),
      array_to_string(pred.subject_types, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.object_entity_id IS NOT NULL THEN
    SELECT node_type INTO object_type FROM entities WHERE id = NEW.object_entity_id;
    IF object_type IS NULL OR NOT (object_type = ANY (pred.object_types)) THEN
      RAISE EXCEPTION
        'Le prédicat « % » n''accepte pas un objet de type « % » (attendu : %).',
        NEW.predicate, COALESCE(object_type, 'inconnu'),
        array_to_string(pred.object_types, ', ')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER assertions_validate_types_trg
  BEFORE INSERT ON assertions
  FOR EACH ROW EXECUTE FUNCTION app.validate_assertion_types();

-- --------------------------------------------------------------------------
-- Evidence anchoring (ADR 0003)
--
-- If a piece of evidence cites a text block and quotes an excerpt, that
-- excerpt must actually occur in that block. This is the backstop behind the
-- application-level anchoring check — the mechanism that stops the model
-- answering from what it already knows about One Piece rather than from the
-- pages in front of it.
--
-- Image-derived evidence carries no excerpt and is anchored by panel_id
-- instead; that pairing is checked here too.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.validate_evidence_anchor() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  block_text text;
BEGIN
  IF NEW.excerpt IS NOT NULL AND btrim(NEW.excerpt) <> '' THEN
    IF NEW.text_block_id IS NULL THEN
      RAISE EXCEPTION
        'Une preuve citant un extrait doit référencer le bloc de texte source.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT normalized_text INTO block_text
      FROM text_blocks WHERE id = NEW.text_block_id;

    IF block_text IS NULL THEN
      RAISE EXCEPTION 'Bloc de texte introuvable : %', NEW.text_block_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF position(app.normalize_text(NEW.excerpt) IN block_text) = 0 THEN
      RAISE EXCEPTION
        'Extrait non ancré : « % » n''apparaît pas dans le bloc de texte cité (%).',
        left(NEW.excerpt, 80), NEW.text_block_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'image' AND NEW.panel_id IS NULL THEN
    RAISE EXCEPTION
      'Une preuve visuelle doit référencer la case dont elle provient.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER evidence_validate_anchor_trg
  BEFORE INSERT ON evidence
  FOR EACH ROW EXECUTE FUNCTION app.validate_evidence_anchor();

-- --------------------------------------------------------------------------
-- Denormalised chapter_number stays true to chapters.number.
--
-- The RLS predicate reads this column, so a stale value is a spoiler leak.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.sync_chapter_number() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT number INTO NEW.chapter_number FROM chapters WHERE id = NEW.chapter_id;
  IF NEW.chapter_number IS NULL THEN
    RAISE EXCEPTION 'Chapitre introuvable : %', NEW.chapter_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pages_sync_chapter_number BEFORE INSERT OR UPDATE OF chapter_id ON pages
  FOR EACH ROW EXECUTE FUNCTION app.sync_chapter_number();
CREATE TRIGGER panels_sync_chapter_number BEFORE INSERT OR UPDATE OF chapter_id ON panels
  FOR EACH ROW EXECUTE FUNCTION app.sync_chapter_number();
CREATE TRIGGER text_blocks_sync_chapter_number BEFORE INSERT OR UPDATE OF chapter_id ON text_blocks
  FOR EACH ROW EXECUTE FUNCTION app.sync_chapter_number();
CREATE TRIGGER occurrences_sync_chapter_number BEFORE INSERT OR UPDATE OF chapter_id ON occurrences
  FOR EACH ROW EXECUTE FUNCTION app.sync_chapter_number();

-- Renumbering a chapter must carry through to every denormalised copy.
CREATE OR REPLACE FUNCTION app.propagate_chapter_number() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number THEN
    UPDATE pages       SET chapter_number = NEW.number WHERE chapter_id = NEW.id;
    UPDATE panels      SET chapter_number = NEW.number WHERE chapter_id = NEW.id;
    UPDATE text_blocks SET chapter_number = NEW.number WHERE chapter_id = NEW.id;
    UPDATE occurrences SET chapter_number = NEW.number WHERE chapter_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER chapters_propagate_number AFTER UPDATE OF number ON chapters
  FOR EACH ROW EXECUTE FUNCTION app.propagate_chapter_number();
