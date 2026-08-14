-- Une question ne répond pas à une question.
--
-- La carte, telle qu'elle se lisait en revue :
--
--   MYSTÈRE  Qui a réellement fait exploser le rhum de Dorry ?
--            résout le mystère
--   MYSTÈRE  Qui a réellement fait exploser le rhum de Dorry ?
--
-- La même question des deux côtés d'une flèche, en revue explicite obligatoire,
-- à 80 % de confiance. Rien ne l'a arrêtée parce que rien ne disait qu'elle
-- était fausse : `resolves_mystery` était écrit avec `ANY_ENTITY` en sujet, et
-- `ANY_ENTITY` contient `mystery`. Les deux bouts étaient donc du bon type, le
-- déclencheur de la 0006 acquiesçait, et le lien s'écrivait.
--
-- Ce n'est pas seulement une ligne de trop dans le graphe. Publier une
-- résolution écrit `resolved_in_chapter` sur la question elle-même — c'est ce
-- que fait `applyMysteryVerdict` —, donc /mystères affichait « refermée » sous
-- une question qu'aucun chapitre n'avait refermée, et le lecteur ne la
-- retrouvait plus le jour où la réponse arrivait vraiment. Une question fermée
-- par elle-même est fermée pour de bon.
--
-- Trois choses ici, et l'ontologie en TypeScript est la quatrième : les
-- prédicats y refusent désormais `mystery` en sujet, et `scripts/db-push.ts`
-- réécrit `predicates` à partir d'elle à chaque poussée. La mise à jour
-- ci-dessous dit la même chose pour une base migrée sans ce semis.
--
-- Rien n'est supprimé. Les assertions sont en ajout seul (ADR 0002) et une
-- correction se dit en passant `review_status` à « rejected » : la ligne reste,
-- datée, avec sa preuve, et cesse d'être lue. C'est réversible en une requête.

-- --------------------------------------------------------------------------
-- 1. Les prédicats des mystères n'acceptent plus une question en sujet.
-- --------------------------------------------------------------------------
UPDATE predicates
   SET subject_types = array_remove(subject_types, 'mystery')
 WHERE builtin
   AND key IN ('resolves_mystery', 'reopens_mystery', 'hints_at')
   AND 'mystery' = ANY (subject_types);

-- --------------------------------------------------------------------------
-- 2. Une relation joint deux choses, et une chose n'en fait pas deux.
--
-- Le cas du rhum de Dorry est un sujet du mauvais type ; le point 1 le règle.
-- La boucle, elle, se refait autrement : la publication rattache une
-- proposition à une entité déjà présente par son libellé normalisé, de sorte
-- qu'une question reproposée dans le chapitre qui y répond devient le nœud
-- même que la relation vise — deux identifiants sur la carte, une seule fiche
-- en dessous. L'application vérifie maintenant les deux bouts après résolution
-- ; ceci est le filet, comme la 0006 l'est pour les types.
--
-- Vrai de tout prédicat, pas seulement des mystères : « Zoro rencontre Zoro »
-- ne dit rien, et une boucle sur un prédicat d'identité soude un nœud à
-- lui-même dans l'union-find pour toujours.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.validate_assertion_types() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pred            predicates%ROWTYPE;
  subject_type    text;
  object_type     text;
BEGIN
  IF NEW.object_entity_id IS NOT NULL
     AND NEW.object_entity_id = NEW.subject_entity_id
  THEN
    RAISE EXCEPTION
      'Le prédicat « % » relierait une entité à elle-même : une relation joint deux choses distinctes.',
      NEW.predicate
      USING ERRCODE = 'check_violation';
  END IF;

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

-- --------------------------------------------------------------------------
-- 3. Les liens déjà écrits, et les questions qu'ils avaient refermées.
-- --------------------------------------------------------------------------
DO $reparation$
DECLARE
  liens      integer;
  boucles    integer;
  rouvertes  integer;
  redatees   integer;
BEGIN
  -- Une question donnée pour sujet d'un prédicat de mystère : le cas de la
  -- capture d'écran, qu'elle boucle sur elle-même ou qu'elle en vise une autre.
  WITH ecartes AS (
    UPDATE assertions a
       SET review_status = 'rejected'
      FROM entities s
     WHERE s.id = a.subject_entity_id
       AND s.node_type = 'mystery'
       AND a.predicate IN ('resolves_mystery', 'reopens_mystery', 'hints_at')
       AND a.review_status = 'accepted'
    RETURNING a.id
  )
  SELECT count(*) INTO liens FROM ecartes;
  RAISE NOTICE 'mystères qui en « résolvaient » un autre, écartés : %', liens;

  -- Et toute boucle, quel que soit le prédicat : ce que le déclencheur refuse
  -- désormais ne doit pas rester lisible dans le graphe.
  WITH ecartees AS (
    UPDATE assertions a
       SET review_status = 'rejected'
     WHERE a.object_entity_id = a.subject_entity_id
       AND a.review_status = 'accepted'
    RETURNING a.id
  )
  SELECT count(*) INTO boucles FROM ecartees;
  RAISE NOTICE 'relations d''une entité vers elle-même, écartées : %', boucles;

  /*
   * Les questions redeviennent ce qu'elles sont.
   *
   * `resolved_in_chapter` est recalculé depuis ce qui subsiste : le plus tôt
   * des chapitres qui répondent encore, et rien du tout quand il n'en reste
   * aucun. Le plus tôt, parce que c'est là que le lecteur a appris la réponse —
   * la même règle qu'à la publication, et la seule qui rende ce calcul
   * rejouable.
   *
   * `state` ne repasse à « open » que depuis « resolved ». Une question
   * « refuted » ou « partially_resolved » dit autre chose que « on a répondu »,
   * et ce n'est pas à cette réparation de trancher à sa place ; elle perd sa
   * date, qui était fausse, et garde son état.
   *
   * Les questions rouvertes (`resolved_in_chapter` déjà nul) ne sont pas
   * touchées : il n'y a pas de date à corriger.
   */
  WITH subsistant AS (
    SELECT m.entity_id,
           m.state,
           m.resolved_in_chapter,
           (SELECT min(a.knowledge_from_chapter)
              FROM assertions a
             WHERE a.object_entity_id = m.entity_id
               AND a.user_id = m.user_id
               AND a.predicate = 'resolves_mystery'
               AND a.review_status = 'accepted') AS chapitre
      FROM mysteries m
     WHERE m.resolved_in_chapter IS NOT NULL
  ),
  corrigees AS (
    UPDATE mysteries m
       SET resolved_in_chapter = s.chapitre,
           state = CASE
                     WHEN s.chapitre IS NULL AND m.state = 'resolved' THEN 'open'::mystery_state
                     ELSE m.state
                   END
      FROM subsistant s
     WHERE s.entity_id = m.entity_id
       AND m.resolved_in_chapter IS DISTINCT FROM s.chapitre
    RETURNING m.entity_id, s.chapitre
  )
  SELECT count(*) FILTER (WHERE chapitre IS NULL),
         count(*) FILTER (WHERE chapitre IS NOT NULL)
    INTO rouvertes, redatees
    FROM corrigees;

  RAISE NOTICE 'questions rendues à « sans réponse » : %', rouvertes;
  RAISE NOTICE 'questions redatées sur la réponse qui subsiste : %', redatees;
END $reparation$;

-- --------------------------------------------------------------------------
-- 4. Et les cartes qui attendent encore une décision.
--
-- Celle de la capture est en file, en 3 sur 18 : une proposition que la
-- publication refuse désormais et que personne ne peut donc accepter. La
-- laisser là revient à demander au relecteur de cliquer « Rejeter » sur une
-- absurdité, dix-huit fois. L'extraction les met maintenant en quarantaine
-- avant la file — elles ne reviendront pas au prochain import.
--
-- Deux formes, parce qu'un identifiant de proposition est soit l'UUID d'une
-- entité déjà validée, soit un identifiant local du genre « e3 » : la boucle se
-- voit sans rien résoudre, le sujet de type « mystery » se voit quand c'est un
-- UUID.
-- --------------------------------------------------------------------------
DO $file$
DECLARE
  cartes integer;
BEGIN
  WITH ecartees AS (
    UPDATE review_items ri
       SET status = 'rejected'
     WHERE ri.category = 'assertion'
       AND ri.status = 'proposed'
       AND (
            (ri.payload->>'object') IS NOT NULL
        AND btrim(ri.payload->>'object') <> ''
        AND (
             btrim(ri.payload->>'object') = btrim(ri.payload->>'subject')
          OR (
               ri.payload->>'predicate' IN ('resolves_mystery', 'reopens_mystery', 'hints_at')
           AND EXISTS (
                 SELECT 1 FROM entities e
                  WHERE e.id::text = lower(btrim(ri.payload->>'subject'))
                    AND e.node_type = 'mystery'
               )
             )
        )
       )
    RETURNING ri.id
  )
  SELECT count(*) INTO cartes FROM ecartees;
  RAISE NOTICE 'cartes en attente écartées (mystère se résolvant lui-même) : %', cartes;
END $file$;
