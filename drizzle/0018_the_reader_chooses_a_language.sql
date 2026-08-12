-- The site speaks two languages, and the reader picks one.
--
-- The graph stays authored in French — one canonical form per fact, per name,
-- per event summary, exactly as migrations 0016 and 0017 argued. What becomes
-- bilingual is everything the site *says around* that content: navigation,
-- forms, type labels, generated answers. The reader's choice of language is a
-- preference like the reading position, and it lives in the same row.
--
-- 'fr' is the default because it is the language of every existing profile and
-- of the interface until now: nobody's site changes under them.
--
-- An anonymous visitor has no profile — public reading (migration 0011's
-- boundary lens, PUBLIC_LIBRARY_OWNER_ID) works without an account — so their
-- choice is held in a cookie by the application. This column is only the
-- signed-in half of the preference.

ALTER TABLE profiles
  ADD COLUMN language text NOT NULL DEFAULT 'fr'
  CONSTRAINT profiles_language_check CHECK (language IN ('fr', 'en'));

COMMENT ON COLUMN profiles.language IS
  'Interface and answer language for this reader: fr or en. The knowledge '
  'graph itself stays canonically French; this decides how it is displayed.';
