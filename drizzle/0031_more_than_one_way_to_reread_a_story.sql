-- ---------------------------------------------------------------------------
-- Plusieurs lectures payantes, et une seule mémoire ne suffit plus.
--
-- `audit_reads` retenait « quels chapitres le modèle a déjà relus, et pour
-- combien ». Une ligne, une clé : (utilisateur, œuvre, chapitre). C'était juste
-- tant qu'il n'y avait qu'une lecture payante à retenir.
--
-- Il y en a maintenant plusieurs, et elles ne portent pas sur la même sorte de
-- chose :
--
--   relire les scènes d'un chapitre        → sujet : un chapitre ;
--   juger une identité déjà acceptée       → sujet : une assertion ;
--   chercher les identités manquantes      → sujet : un chapitre ;
--   dater la réponse d'une question        → sujet : un mystère ;
--   départager deux scènes trop proches    → sujet : un chapitre ;
--   soupçonner une scène de couverture     → sujet : un chapitre.
--
-- Faire tenir tout cela dans une colonne `chapter` demanderait d'y écrire autre
-- chose qu'un chapitre, et une colonne qui ment est une reprise qui saute la
-- moitié de son travail sans le dire : le chapitre 113 et l'assertion 113 se
-- confondraient, et la seconde ne serait jamais lue.
--
-- `audit_passes` retient donc, pour chaque couple (analyse, sujet) :
--
--   **l'empreinte des entrées** — un condensé de ce qui a été *donné* au
--   modèle. C'est elle qui rend une seconde passe gratuite : rien n'a bougé,
--   même empreinte, on saute. Une scène reformulée, un passage de plus, une
--   identité redatée changent l'empreinte et redonnent le sujet à lire. C'est
--   `mysteries.swept_to_chapter` — « ce qui se paye à la question se paye
--   contre un état de la bibliothèque » — généralisé aux six analyses.
--
--   **la version de la consigne** — parce qu'une consigne s'améliore, et qu'une
--   lecture faite avec la précédente a laissé passer ce qu'une meilleure
--   trouverait. Sans elle, corriger un prompt ne change rien pour une
--   bibliothèque déjà lue, et personne ne s'en aperçoit. C'est exactement la
--   raison qui justifiait `forgetReadings`, la remise à zéro totale : elle
--   devient inutile, puisque changer la version suffit à rendre périmée la
--   seule analyse concernée.
--
--   **ce que la passe a coûté, et si elle a échoué**. Un échec est retenu comme
--   échec — `ok = false` — et non comme une absence : la page peut alors dire
--   « quatre chapitres en échec, reprenez » au lieu de les reproposer en
--   silence à chaque passage.
--
-- `audit_reads` disparaît, ses lignes reprises telles quelles dans la nouvelle
-- table sous l'analyse `scenes`. Une empreinte vide et une version `0` leur sont
-- données, ce qui les rend périmées à la première passe : c'est le bon défaut,
-- puisque la consigne de relecture a changé en même temps que cette migration.
-- Rien n'est perdu de ce qui a été payé — les constats sont dans
-- `audit_findings`, qui n'est pas touchée.
--
-- ---------------------------------------------------------------------------
-- Et `audit_findings` apprend de quelle analyse chaque constat vient.
--
-- Le nettoyage d'une passe retire les constats que cette passe n'a pas
-- retrouvés — c'est ce qui fait qu'un défaut corrigé disparaît de la liste.
-- Borné jusqu'ici à la « source » (règle ou modèle) et à une liste de
-- chapitres, il ne pouvait pas distinguer une lecture de mystères d'une
-- relecture de scènes : relire une question aurait effacé ce que la relecture
-- des chapitres avait trouvé, c'est-à-dire tout ce qui avait été payé.
--
-- Deux colonnes le rendent possible : `analysis`, et `subject` — le sujet
-- exact, pour qu'une passe sur une question ne touche jamais aux constats
-- d'une autre.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_findings
  ADD COLUMN analysis text NOT NULL DEFAULT 'regles',
  ADD COLUMN subject  text;

-- Ce qui existe vient de deux endroits, et les deux se rangent sans ambiguïté :
-- les règles n'ont pas de sujet — elles repassent sur toute la bibliothèque —,
-- et une relecture porte sur son chapitre.
UPDATE audit_findings
   SET analysis = 'scenes', subject = chapter::text
 WHERE source = 'modele';

CREATE INDEX audit_findings_analysis_idx
  ON audit_findings (user_id, work_id, analysis, subject);

COMMENT ON COLUMN audit_findings.analysis IS
  'Quelle analyse a produit ce constat. Ce qui borne le nettoyage : une passe '
  'sur les mystères ne doit jamais effacer ce qu''une relecture de chapitre a '
  'trouvé.';

COMMENT ON COLUMN audit_findings.subject IS
  'Le sujet exact examiné — numéro de chapitre, identifiant d''assertion ou de '
  'mystère. Null pour les règles, qui repassent sur toute la bibliothèque.';

CREATE TABLE audit_passes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  work_id       uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,

  -- Du texte plutôt qu'un enum, comme `audit_findings.kind` : une analyse de
  -- plus ne doit pas demander une migration, et rien ici ne se branche sur la
  -- valeur.
  analysis      text NOT NULL,
  subject_kind  text NOT NULL,
  subject       text NOT NULL,

  input_fingerprint text NOT NULL,
  prompt_version    text NOT NULL,

  model_id      text,
  -- Au même format que les étapes du pipeline : un coût est fractionnaire par
  -- construction.
  cost_cents    numeric(14, 6) NOT NULL DEFAULT 0,
  findings      integer NOT NULL DEFAULT 0,

  -- Un échec est un fait, pas une absence. Le retenir permet à la page de dire
  -- ce qui a raté plutôt que de le reproposer en silence à chaque passage.
  ok            boolean NOT NULL DEFAULT true,
  failure       text,

  read_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_passes_subject_known
    CHECK (subject_kind IN ('chapter', 'identity', 'mystery'))
);

-- Une passe par sujet et par analyse : c'est la clé de la reprise, et c'est ce
-- qui fait qu'une relance ne réécrit pas une seconde ligne.
CREATE UNIQUE INDEX audit_passes_unique
  ON audit_passes (user_id, work_id, analysis, subject);

CREATE INDEX audit_passes_analysis_idx
  ON audit_passes (user_id, work_id, analysis, ok);

INSERT INTO audit_passes (
  user_id, work_id, analysis, subject_kind, subject,
  input_fingerprint, prompt_version, model_id, cost_cents, findings, read_at
)
SELECT user_id, work_id, 'scenes', 'chapter', chapter::text,
       '', '0', model_id, cost_cents, findings, read_at
  FROM audit_reads;

DROP TABLE audit_reads;

ALTER TABLE audit_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_passes FORCE ROW LEVEL SECURITY;

-- Aucune politique pour `authenticated`, et aucun GRANT : comme les deux tables
-- de la 0029, celle-ci est refusée au rôle du lecteur plutôt que filtrée pour
-- lui. Un sujet lu est le numéro d'un chapitre ou l'identifiant d'une
-- révélation, et c'est un outil de bibliothécaire.
CREATE POLICY audit_passes_ingest_all ON audit_passes
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_passes TO app_ingest;

COMMENT ON TABLE audit_passes IS
  'Ce que chaque analyse a déjà lu, sujet par sujet, avec l''empreinte de ses '
  'entrées et la version de sa consigne. Ce qui rend les lectures payantes '
  'reprenables sans repayer : une passe n''est refaite que si son sujet a '
  'changé, si la consigne a changé, ou si l''utilisateur l''efface.';

COMMENT ON COLUMN audit_passes.input_fingerprint IS
  'Condensé de la matière donnée au modèle. Elle change quand le sujet change, '
  'et ne change pas quand on reclique.';

COMMENT ON COLUMN audit_passes.prompt_version IS
  'La version de la consigne au moment de la lecture. La changer rend périmée '
  'cette analyse-là, et elle seule.';
