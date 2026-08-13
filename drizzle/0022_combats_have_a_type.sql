-- « Combat » existait, et rien ne pouvait en produire un.
--
-- L'ontologie porte `battle` et `voyage` depuis qu'elle est écrite : une clé,
-- un libellé français, une description, une couleur, une case à cocher sur la
-- page du graphe. La publication, elle, lisait la *catégorie* de l'élément de
-- revue — qui vaut `event` pour toute scène extraite — et écrivait `event`
-- comme type de nœud. « Zoro affronte Baggy en duel et le découpe en
-- morceaux » devenait un événement ordinaire, et le filtre « Combat » ne
-- renvoyait rien, quel que soit le nombre de chapitres importés.
--
-- Le lecteur n'avait qu'une lecture possible de ce filtre vide : les combats ne
-- sont pas détectés. Ils l'étaient. Ils n'étaient distingués de rien.
--
-- Le code corrige la suite : l'extraction dit désormais de quelle sorte de
-- scène il s'agit, et la publication l'écrit. Restent les scènes déjà dans le
-- graphe, et c'est l'objet de ce fichier. Les republier voudrait dire
-- retraiter et revalider un travail déjà fait, pour un champ dont personne ne
-- savait qu'il manquait.
--
-- CE QUE CETTE MIGRATION DEVINE, ET CE QU'ELLE NE DEVINE PAS
--
-- Elle relit le résumé de chaque événement et le reclasse en combat quand le
-- vocabulaire ne laisse pas de doute. C'est une supposition, la seule de ce
-- système qui atteigne le graphe sans être soumise à une revue, et elle est
-- bornée pour cette raison :
--
--   • Elle ne peut pas spoiler. Elle change le *type* d'un nœud, jamais ce
--     qu'il raconte, jamais le chapitre où il devient visible, jamais ses
--     liens. La scène elle-même a été acceptée par un humain en son temps.
--   • Elle ne touche que `node_type = 'event'`. Un personnage, un lieu, un
--     mystère ne sont jamais lus.
--   • Elle ne produit JAMAIS `voyage`, uniquement `battle`. Deux raisons, et
--     la seconde est la contraignante : le vocabulaire du départ (« prend la
--     mer », « quitte », « arrive ») décrit le décor de cette œuvre autant que
--     la scène, donc aucune liste prudente n'existe ; et surtout, `event` et
--     `battle` sont acceptés exactement aux mêmes endroits par tous les
--     prédicats de l'ontologie, alors que `voyage` ne l'était pas jusqu'à ce
--     commit. Comme le déclencheur de typage ne se rejoue pas sur une mise à
--     jour d'entité, un `event` promu en `voyage` pourrait laisser derrière lui
--     une assertion devenue invalide, en silence. `event` → `battle` ne le peut
--     pas, et c'est vérifiable ligne à ligne dans ontology.ts.
--   • Le vocabulaire sous-classe volontairement. Un combat manqué reste un
--     événement — ce qu'il était hier, et cela ne coûte rien. Une scène
--     paisible promue en « Combat » est une affirmation fausse sur l'histoire,
--     en rouge, sur le graphe.
--
-- La liste vit dans src/domains/knowledge/occurrence.ts, qui est aussi ce que
-- la publication applique aux propositions restées sans `kind`. Le motif
-- ci-dessous en est la copie, et un test le relit dans ce fichier pour vérifier
-- que les deux n'ont pas divergé.
--
-- POUR ANNULER
--
--   UPDATE entities e SET node_type = 'event'
--   FROM audit_log a
--   WHERE a.action = 'occurrence_reclassified' AND a.subject_id = e.id;
--
-- Chaque ligne modifiée est tracée dans audit_log avec son ancien type, son
-- nouveau type et le résumé qui a décidé.

-- Une seule instruction : le motif n'est écrit qu'une fois, et la trace ne peut
-- pas se désynchroniser de la mise à jour qu'elle décrit. Le fichier est joué
-- par le protocole simple, qui l'enveloppe déjà dans une transaction implicite
-- — un BEGIN explicite ici serait un second, refusé.
WITH matched AS (
  SELECT
    e.id,
    e.user_id,
    e.node_type AS was,
    ev.summary
  FROM entities e
  JOIN events ev ON ev.entity_id = e.id
  WHERE e.node_type = 'event'
    AND ev.summary IS NOT NULL
    AND translate(
          lower(ev.summary),
          'àâäéèêëîïôöùûüç',
          'aaaeeeeiioouuuc'
        ) ~ ('\y(' ||
          'affront(e|es|ent|er|ement|ements)' || '|' ||
          'combat(s|tre|tent|tant|tants)?' || '|' ||
          'duel(s)?' || '|' ||
          'bat(s|tent|tre|tu|tue|tus|tues|tait|taient)?' || '|' ||
          'vainc(u|ue|us|ues|re|ent)?' || '|' ||
          'vainqueur(s)?' || '|' ||
          'neutralis(e|es|ent|er)' || '|' ||
          'assomm(e|es|ent|er)' || '|' ||
          'attaqu(e|ee|es|ees|ent|er|ant)' || '|' ||
          'contre-attaqu(e|es|ent)' || '|' ||
          'ripost(e|es|ent|er)' || '|' ||
          'degain(e|es|ent|er)' || '|' ||
          'coups? de poing' || '|' ||
          'coups? de pied' ||
        ')\y')
),
updated AS (
  UPDATE entities
  SET node_type = 'battle'
  WHERE id IN (SELECT id FROM matched)
  RETURNING id
)
-- Tracé, donc annulable et lisible. Sans cela la reprise serait indistinguable
-- d'un classement fait par le modèle, et personne ne pourrait la défaire.
INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
SELECT
  m.user_id,
  'occurrence_reclassified',
  'entity',
  m.id,
  jsonb_build_object(
    'from', m.was,
    'to', 'battle',
    'by', 'migration_0022',
    'summary', left(m.summary, 200)
  )
FROM matched m
JOIN updated u ON u.id = m.id;

DO $reclassement$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM audit_log WHERE action = 'occurrence_reclassified';
  RAISE NOTICE 'combats retrouvés dans les événements déjà publiés : %', n;
END $reclassement$;
