-- 0008 — Normalise both sides of the anchoring check.
--
-- 0006 normalised the excerpt with app.normalize_text() and compared it
-- against text_blocks.normalized_text, which the *application* had written
-- using its own TypeScript normalisation. That made the trigger depend on the
-- two implementations agreeing character for character.
--
-- They do not, and more importantly they cannot be relied on to. PostgreSQL's
-- unaccent() reads unaccent.rules, whose contents vary by installation: it
-- folds ß→ss, …→..., «→<<, and full-width forms to ASCII, none of which
-- Unicode NFD decomposition does. Supabase and a local PostgreSQL can ship
-- different rule files. A parity test caught this before it reached anyone,
-- but the underlying design was the bug: an integrity backstop should not be
-- brittle against a locale data file.
--
-- Applying the same normalisation to *both* sides fixes it structurally.
-- These transformations are character-local, so they preserve substring
-- containment: if the excerpt is contained in the block under the
-- application's normalisation, it stays contained under any additional
-- folding applied uniformly to both. The trigger can therefore be stricter or
-- looser than the application without ever rejecting a valid write.

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

    -- Both sides, same function. That is the whole point.
    IF position(
         app.normalize_text(NEW.excerpt) IN app.normalize_text(block_text)
       ) = 0
    THEN
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
