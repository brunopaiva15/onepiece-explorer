-- Un nom qu'aucun chapitre ne donne, et un nom qui vient d'ailleurs.
--
-- Le modèle d'identité progressive est déjà là et il est complet à un champ
-- près : une entité porte plusieurs libellés, chacun daté du chapitre qui le
-- révèle, et la fiche affiche le mieux classé parmi ceux que le lecteur a lus.
-- C'est ce qui tient « Klahadore » de 23 à 25 et « Kuro » ensuite. Deux cas de
-- la relecture du chapitre 1 tombent à côté, et pour la même raison : le nom
-- n'est pas dans le manga.
--
--   * « Lucky Roux » et « Benn Beckman » apparaissent tous deux au chapitre 1,
--     dessinés, sans un mot. Leurs noms sont donnés dans le SBS du tome 5, que
--     le lecteur atteint au chapitre 42. La date existe donc — c'est 42 — mais
--     la source n'est pas la page du chapitre, et rien dans la table ne
--     permettait de le dire. `reveal_source` est cette phrase.
--
--   * Le maire de Fuchsia apparaît lui aussi au chapitre 1. Son nom vient d'un
--     databook, et les databooks ne sont rattachés à aucun chapitre de cette
--     bibliothèque. Il n'y a pas de date à écrire. Lui en inventer une —
--     l'entrée en scène, le dernier chapitre importé, un nombre choisi pour
--     que ça passe — serait exactement la faute que la frontière existe pour
--     empêcher, en plus discret : un chapitre affirmerait une révélation qu'il
--     ne contient pas.
--
-- D'où le NULL. Il ne veut pas dire « on ne sait pas quand » ; il veut dire
-- « aucun chapitre ne le révèle », ce qui est une affirmation, vérifiable, et
-- la seule vraie ici. Le nom canonique reste dans la table — la recherche
-- interne, une fusion, un renommage futur en ont besoin — mais aucune frontière
-- ne le fait apparaître.
--
-- La contrainte est ce qui empêche le NULL de devenir un trou. Un libellé sans
-- chapitre doit dire d'où il vient ; « je ne sais pas » n'est pas une valeur
-- acceptable pour un nom que rien n'explique.

ALTER TABLE entity_labels
  ADD COLUMN IF NOT EXISTS reveal_source text;

ALTER TABLE entity_labels
  ALTER COLUMN revealed_in_chapter DROP NOT NULL;

ALTER TABLE entity_labels
  DROP CONSTRAINT IF EXISTS entity_labels_unrevealed_needs_source;

ALTER TABLE entity_labels
  ADD CONSTRAINT entity_labels_unrevealed_needs_source
  CHECK (revealed_in_chapter IS NOT NULL OR reveal_source IS NOT NULL);

COMMENT ON COLUMN entity_labels.revealed_in_chapter IS
  'Chapitre où le lecteur apprend ce nom. NULL = aucun chapitre ne le donne : '
  'le nom existe hors de la chronologie et n''est affiché à aucune frontière.';

COMMENT ON COLUMN entity_labels.reveal_source IS
  'D''où vient le nom quand ce n''est pas la page du chapitre — « SBS du tome 5 », '
  '« databook ». Obligatoire lorsque revealed_in_chapter est NULL.';

-- --------------------------------------------------------------------------
-- La politique, qui dit maintenant le NULL à voix haute.
--
-- `NULL <= app.boundary()` vaut NULL, donc la règle refusait déjà ces lignes :
-- une politique n'admet que TRUE. Réécrite quand même, parce qu'une sécurité
-- qui tient par le comportement des trois valeurs de vérité de SQL tient par
-- quelque chose que le prochain lecteur de ce fichier doit deviner. Ici elle
-- tient par une clause qu'il lit.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS entity_labels_boundary_select ON entity_labels;

CREATE POLICY entity_labels_boundary_select ON entity_labels
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND revealed_in_chapter IS NOT NULL
    AND revealed_in_chapter <= app.boundary()
  );
