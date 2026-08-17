-- ---------------------------------------------------------------------------
-- Relire toute l'histoire, et garder ce qu'on y a trouvé.
--
-- Le pipeline lit un chapitre à la fois, et c'est la bonne unité : celle de la
-- frontière, celle de la revue, celle du coût. Certains défauts n'existent
-- pourtant qu'*entre* les chapitres — une attaque annoncée comme nouvelle
-- trente chapitres après avoir été nommée, un nom révélé un chapitre trop tôt,
-- la même scène écrite deux fois par deux passages du pipeline. Aucune relecture
-- d'un seul chapitre ne peut les voir, et rien jusqu'ici ne les cherchait.
--
-- Deux tables, parce que ce sont deux choses :
--
--   `audit_findings` — ce qui a été trouvé, et ce que ça coûterait de corriger.
--   `audit_reads`    — quels chapitres le modèle a déjà relus, et pour combien.
--
-- La seconde existe parce que la relecture se paye au chapitre : sans elle, une
-- reprise après une interruption repaye ce qui a déjà été lu, et une
-- bibliothèque de mille chapitres se relit mille fois.
--
-- ---------------------------------------------------------------------------
-- Ces deux tables ne sont lisibles par personne d'autre que l'ingestion.
--
-- C'est le point à ne pas manquer. Un constat dit « ce nom apparaît au chapitre
-- 110 » — c'est-à-dire qu'il *contient* la révélation, sous la forme la plus
-- concentrée possible. Une politique de frontière serait donc à écrire avec
-- soin ; ne pas en écrire du tout, et refuser la table au rôle du lecteur, est
-- plus sûr et dit la même chose : ceci est un outil de bibliothécaire, lu par
-- les pages d'administration, qui passent déjà par le rôle d'ingestion.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  work_id       uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,

  -- Le chapitre où le lecteur bute dessus, qui n'est pas toujours celui qui a
  -- tort : un nom affiché trop tôt se constate au chapitre qui l'affiche.
  chapter       integer NOT NULL,

  -- La règle qui l'a trouvé. Du texte plutôt qu'un enum : une règle de plus ne
  -- doit pas demander une migration, et rien ici ne se branche sur la valeur.
  kind          text NOT NULL,
  -- 'regles' quand une règle l'a déduit du graphe, 'modele' quand une relecture
  -- l'a lu dans le chapitre. La différence se voit à l'écran, parce qu'elle
  -- change ce que le constat vaut.
  source        text NOT NULL DEFAULT 'regles',

  title         text NOT NULL,
  detail        text,

  subject_entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  object_entity_id  uuid REFERENCES entities(id) ON DELETE CASCADE,

  -- La correction proposée, sous la forme que `applyAuditFix` sait appliquer.
  -- Null quand il n'y en a pas de mécanique : fusionner deux fiches se décide
  -- sur la fiche, devant ce que chacune porte.
  fix           jsonb,

  -- Ce qui fait que ce constat est le même d'un balayage à l'autre. Même
  -- discipline que `review_decisions.proposal_fingerprint`, et pour la même
  -- raison : sans elle, « ignorer » ne tient que jusqu'au prochain clic.
  fingerprint   text NOT NULL,

  status        text NOT NULL DEFAULT 'open',
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_findings_status_known
    CHECK (status IN ('open', 'applied', 'ignored')),
  CONSTRAINT audit_findings_source_known
    CHECK (source IN ('regles', 'modele')),
  CONSTRAINT audit_findings_chapter_positive CHECK (chapter >= 0)
);

-- Un balayage se relance : le même constat retrouvé ne s'ajoute pas, et une
-- décision déjà prise dessus survit.
CREATE UNIQUE INDEX audit_findings_unique
  ON audit_findings (user_id, work_id, fingerprint);

CREATE INDEX audit_findings_open_idx
  ON audit_findings (user_id, work_id, status, chapter);

CREATE TABLE audit_reads (
  user_id       uuid NOT NULL,
  work_id       uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter       integer NOT NULL,
  model_id      text,
  -- Ce que ce chapitre a coûté, gardé au même format que les étapes du
  -- pipeline : un coût est fractionnaire par construction.
  cost_cents    numeric(14, 6) NOT NULL DEFAULT 0,
  findings      integer NOT NULL DEFAULT 0,
  read_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, work_id, chapter)
);

ALTER TABLE audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_findings FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_reads FORCE ROW LEVEL SECURITY;

-- Aucune politique pour `authenticated`, et aucun GRANT : la table est refusée
-- au rôle du lecteur, plutôt que filtrée pour lui.
CREATE POLICY audit_findings_ingest_all ON audit_findings
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

CREATE POLICY audit_reads_ingest_all ON audit_reads
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_findings TO app_ingest;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_reads TO app_ingest;

COMMENT ON TABLE audit_findings IS
  'Ce qu''une relecture de toute l''histoire a trouvé : doublons, noms affichés '
  'avant le chapitre qui les écrit, révélations à l''envers. Jamais lisible par '
  'le rôle du lecteur — un constat contient la révélation qu''il signale.';

COMMENT ON TABLE audit_reads IS
  'Les chapitres déjà relus par le modèle, avec leur coût. Ce qui rend la '
  'relecture reprenable sans repayer ce qui a été lu.';
