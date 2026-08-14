-- Une affiche n'est pas un portrait.
--
-- La table des illustrations tient une image par entité et par source, choisie
-- pour une seule chose : reconnaître un visage dans un graphe. Un avis de
-- recherche fait autre chose. Il porte un visage, une épithète et un nombre, et
-- ces trois-là ne valent que pour un moment précis du récit : Luffy vaut trente
-- millions au chapitre 96 et trois milliards au 1053. Montrer la seconde
-- affiche à quelqu'un qui lit la première lui raconte, sous la forme la plus
-- convaincante qu'ait une interface, ce que valaient les quatre cents chapitres
-- entre les deux.
--
-- D'où cette colonne, et d'où le fait qu'elle ne s'accompagne d'aucune
-- politique nouvelle. La règle qui protège une affiche est déjà écrite :
-- `revealed_in_chapter <= app.boundary()`, posée en 0012 et resserrée en 0022.
-- Une affiche entre en base datée du chapitre qui la montre — un nombre écrit à
-- la main dans src/domains/images/bounties.ts, jamais deviné — et la frontière
-- fait le reste sans savoir qu'il s'agit d'une affiche.
--
-- Plusieurs lignes par entité, donc, une par tirage, et c'est le point : le
-- lecteur au chapitre 500 voit la mise à prix de 300 millions, celui du 1100
-- voit celle de 3 milliards, et c'est la même requête qui répond aux deux. La
-- contrainte d'unicité existante (entity_id, source, source_ref) les distingue
-- déjà, le source_ref étant le fichier du wiki.
--
-- `kind` vaut 'portrait' pour tout ce qui existait avant, ce qui est exact :
-- les quatre catalogues ne rendent que des portraits, et aucune ligne écrite
-- jusqu'ici ne montrait une affiche.

ALTER TABLE entity_images
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'portrait';

DO $$
BEGIN
  ALTER TABLE entity_images
    ADD CONSTRAINT entity_images_kind_known
    CHECK (kind IN ('portrait', 'poster'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN entity_images.kind IS
  'portrait : une illustration du sujet, une par entité et par source. '
  'poster : un avis de recherche, daté du chapitre qui le montre, plusieurs '
  'par entité — un par tirage de la prime.';

-- La lecture d'une affiche demande toujours la même chose : les affiches de ces
-- entités, visibles à ce chapitre, la plus récente d'abord. Sans cet index,
-- c'est un tri de la table entière à chaque affichage de l'accueil.
CREATE INDEX IF NOT EXISTS entity_images_kind_idx
  ON entity_images (entity_id, kind, revealed_in_chapter DESC);
