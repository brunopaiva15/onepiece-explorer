-- Une question déjà posée à toute l'histoire ne se repose pas pour rien.
--
-- Le balayage lit, question par question, toutes les scènes publiées postérieures
-- à celle-ci — neuf cents pour une question du chapitre 1, en trois fenêtres de
-- quatre cents. Il écrit quand il referme. Quand il *ne* referme pas, il
-- n'écrivait rien du tout.
--
-- La conséquence, mesurée sur un runner : `resolved_in_chapter IS NULL` étant le
-- seul filtre, une question laissée ouverte revient dans la passe suivante, et
-- l'on repaye les neuf cents scènes pour obtenir le même « laissée ouverte ». Le
-- script s'arrêtant de lui-même après trois échecs d'affilée — et le CLI mourant
-- sans un mot sur quatre appels sur dix — il meurt vers la vingtième question,
-- et la relance recommence par celles qu'il venait de lire. Cent trente et une
-- questions dont la plupart sont de vraies énigmes que l'histoire n'a pas encore
-- refermées : le lot ne converge jamais.
--
-- Ce n'est pas un défaut du modèle ni de la machine, c'est une absence de
-- mémoire. `audit_reads` l'a pour la relecture, avec la phrase qui va avec : « ce
-- qui se paye au chapitre doit se perdre au chapitre ». Ici, ce qui se paye se
-- paye à la question — contre un état de la bibliothèque.
--
-- D'où la colonne, et le choix de ce qu'elle retient. Pas une date, pas un
-- booléen : **le dernier chapitre publié au moment où la question a été posée**.
-- C'est ce qui rend l'oubli automatique et juste. Rien de neuf n'a été publié →
-- la réponse serait identique, on saute. Un chapitre de plus est entré dans la
-- bibliothèque → il y a des scènes qu'aucune passe n'a lues, et la question
-- redevient à poser. Aucune invalidation à écrire nulle part : publier suffit.
--
-- Nullable, et le null a un sens : jamais examinée. Les cent trente et une
-- existantes le sont donc toutes, et la première passe après cette migration
-- travaille comme avant — c'est la seconde qui devient une reprise.
--
-- Ce qu'elle ne retient PAS, et c'est délibéré : un refus du modèle et une panne
-- du CLI. Ni l'un ni l'autre n'est un verdict sur la question — le premier est un
-- modèle qui décline, le second une machine qui s'en va — et les marquer
-- reviendrait à enterrer une question sur un accident. Voir `closeIfAnswered` :
-- seul « unanswered » et « aucune scène à lire » écrivent ici.

ALTER TABLE mysteries
  ADD COLUMN swept_to_chapter integer;

COMMENT ON COLUMN mysteries.swept_to_chapter IS
  'Le dernier chapitre publié contre lequel cette question a été examinée et '
  'laissée ouverte. Null = jamais examinée. Ce qui rend un balayage reprenable '
  'plutôt que repayable : elle n''est reposée que si la bibliothèque a grandi '
  'depuis. Jamais écrite sur un refus du modèle ni sur une panne du CLI, qui ne '
  'sont pas des verdicts.';

-- Le balayage demande « les questions ouvertes que la bibliothèque actuelle n'a
-- pas encore vues », donc les deux colonnes ensemble, par œuvre.
CREATE INDEX mysteries_sweep_idx
  ON mysteries (work_id, resolved_in_chapter, swept_to_chapter);
