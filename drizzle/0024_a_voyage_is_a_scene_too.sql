-- Un combat et un voyage sont des scènes, eux aussi.
--
-- La 0023 a remis dans `events` les scènes proposées comme entités de type
-- `event`. Elle ne connaissait que ce mot-là. L'ontologie porte trois types
-- d'occurrence — `event`, `battle`, `voyage` — et le modèle les écrit tous les
-- trois dans le champ `node_type` d'une entité, pour la meilleure des raisons :
-- il a mieux classé la scène.
--
-- « Dix ans plus tard, Luffy quitte seul le Village de Fuchsia pour prendre la
-- mer, sous le regard de Makino, Hoop Slap et des villageois. » est un voyage.
-- Le modèle l'a dit, et c'est exactement ce qui l'a fait passer : le garde-fou
-- de l'extraction et la reprise de la 0023 guettaient l'un le mot `event`,
-- l'autre la ligne `node_type = 'event'`. La réponse la plus précise est celle
-- qui n'a été rattrapée par rien.
--
-- Ce que ça laisse dans le graphe est une ligne `entities` sans ligne `events`,
-- et ce n'est pas une différence cosmétique. La scène est absente de la
-- chronologie, qui lit `events` ; absente du « il arrive » du mode histoire,
-- qui la lit aussi ; et présente partout où on l'attend le moins, parce qu'un
-- nœud dont le nom est une phrase reste une entité comme une autre. La
-- recherche l'affiche sous l'étiquette « entité ». L'extraction du chapitre
-- suivant la reçoit parmi les gens et les lieux, avec les trois personnages
-- que sa phrase nomme — et `se trouve à`, `part de` et `se rend à` acceptent
-- tous une occurrence comme sujet, donc « <la phrase où Luffy quitte Fuchsia>
-- se trouve à la Base de la Marine » est bien typée, franchit tous les
-- contrôles, et se lit sur la carte de revue comme une affirmation sur Luffy.
-- La scène est devenue le personnage qu'elle mentionne.
--
-- L'extraction reclasse désormais les trois types (`refileMisfiled`). Ceci est
-- pour les lignes déjà écrites, et c'est la même opération que la 0023 : rien
-- n'est supprimé, rien n'est renommé, le nœud garde son identifiant, son nom et
-- ses preuves — il gagne la ligne qui dit ce qu'il est. `is_flashback` reste
-- faux parce qu'aucune proposition d'entité n'a jamais dit le contraire, et le
-- deviner d'après la formulation placerait la scène au mauvais endroit sur
-- l'axe du récit, ce que la chronologie à deux axes existe précisément pour
-- éviter. Le type, lui, ne bouge pas : `battle` et `voyage` sont ce que le
-- modèle a dit en lisant le passage, et la 0022 rappelle pourquoi on ne le
-- redevine pas — un combat manqué reste un événement, l'inverse est une
-- affirmation fausse sur l'histoire.
--
-- CE QU'ON NE TOUCHE PAS
--
-- Un type choisi à la main depuis la fiche est une décision, pas un mauvais
-- rangement. Elle est tracée dans `audit_log` sous `entity_retyped`, et ces
-- nœuds-là sont laissés tels quels : leur écrire un résumé d'événement les
-- enfermerait dans les types d'occurrence — `retypeEntity` refuse de sortir un
-- nœud qui porte un résumé — et personne n'a demandé ça.

DO $voyages$
DECLARE
  n integer;
BEGIN
  WITH repares AS (
    INSERT INTO events (entity_id, user_id, work_id, summary, is_flashback, shown_in_chapter)
    SELECT en.id,
           en.user_id,
           en.work_id,
           -- Son propre nom est la phrase, et la phrase est le résumé : c'est
           -- ainsi qu'un événement est nommé.
           (SELECT l.label FROM entity_labels l
             WHERE l.entity_id = en.id
             ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
             LIMIT 1),
           false,
           en.first_seen_chapter
      FROM entities en
     WHERE en.node_type IN ('battle', 'voyage')
       -- Une occurrence publiée par la voie normale a toujours sa ligne ici ;
       -- son absence est la signature du rangement manqué.
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.entity_id = en.id)
       -- Une entité sans nom ne peut pas être une scène : un événement est
       -- nommé par son résumé, et un résumé nul s'afficherait en ligne vide.
       AND EXISTS (SELECT 1 FROM entity_labels l WHERE l.entity_id = en.id)
       AND NOT EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.action = 'entity_retyped'
            AND a.subject_kind = 'entity'
            AND a.subject_id = en.id
       )
    ON CONFLICT (entity_id) DO NOTHING
    RETURNING entity_id
  )
  SELECT count(*) INTO n FROM repares;
  RAISE NOTICE 'scènes classées en combat ou en voyage, remises parmi les événements : %', n;
END $voyages$;
