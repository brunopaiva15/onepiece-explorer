-- Une seconde lecture avant la vôtre, et ce qu'elle a répondu.
--
-- La 0029 a donné au chapitre le droit de se publier tout seul : la passe
-- automatique accepte ce qui ne demande personne et garde ce qui demande
-- quelqu'un. Ce qu'elle garde n'est pas peu — un nom dont le modèle n'est pas
-- sûr, une carte sous le seuil de confiance, un rapprochement, une
-- contradiction — et sur un lot de cinquante chapitres, « ce qui demande
-- quelqu'un » redevient une soirée de clics.
--
-- L'arbitrage est la passe qui manquait entre les deux : un second modèle,
-- qui ne relit pas les pages mais **la page du chapitre sur le Fandom**, en
-- anglais et en français, et qui tranche ce qu'elle permet de trancher. Ce
-- qu'il n'arrive pas à trancher reste en file, et c'est la seule chose qui
-- arrive au relecteur.
--
-- Cette colonne est ce qu'il a répondu, carte par carte, appliqué ou non.
-- Elle existe pour deux usages qui ne se remplacent pas :
--
--   La carte encore en file porte l'avis et sa citation. Sur un rapprochement
--   ou une révélation — tout ce que `requires_explicit_review` marque — c'est
--   même tout ce que l'arbitrage a le droit de faire : proposer, avec la phrase
--   du wiki qui le dit, et laisser le clic à qui de droit. Un avis sourcé
--   remplace une enquête, ce qui est exactement le travail qu'on cherche à
--   supprimer.
--
--   La carte décidée sans vous garde par écrit *pourquoi*. « Qu'est-ce qui a
--   été accepté sans moi, et sur quelle phrase » est la question qu'on se pose
--   trois mois plus tard, et une décision sans sa raison n'y répond pas.
--
-- Nullable, et nulle veut dire quelque chose : cette carte n'a pas été
-- arbitrée. Une bibliothèque migrée n'a que des colonnes nulles, ce qui est la
-- vérité — rien n'a relu ces cartes-là.

ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS arbitration jsonb;

COMMENT ON COLUMN review_items.arbitration IS
  'Ce qu''un second modèle a répondu sur cette carte, à partir de la page '
  'Fandom du chapitre : le verdict, la phrase citée mot pour mot, la raison, '
  'et s''il a été appliqué ou seulement affiché. Nul tant que la carte n''a '
  'pas été arbitrée.';
