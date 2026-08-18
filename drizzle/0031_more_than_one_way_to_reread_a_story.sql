-- ---------------------------------------------------------------------------
-- Plusieurs lectures payantes, et une seule mémoire ne suffit plus.
--
-- Cette migration accompagne le système d'analyse qui remplace la mémoire
-- mono-analyse `audit_reads` par `audit_passes`, indexée par analyse et sujet.
--
-- Important pour le déploiement actuel : `audit_reads` est volontairement
-- conservée. Le code actuellement sur `main` la lit encore, tandis qu'un
-- déploiement de la nouvelle analyse peut déjà lire `audit_passes`. Garder les
-- deux tables rend la migration compatible avec les deux versions pendant la
-- transition, au lieu de casser l'une au moment où l'autre devient utilisable.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_findings
  ADD COLUMN IF NOT EXISTS analysis text NOT NULL DEFAULT 'regles',
  ADD COLUMN IF NOT EXISTS subject text;

-- Les constats produits par l'ancienne relecture modèle portent sur un chapitre.
UPDATE audit_findings
   SET analysis = 'scenes', subject = chapter::text
 WHERE source = 'modele'
   AND analysis = 'regles'
   AND subject IS NULL;

CREATE INDEX IF NOT EXISTS audit_findings_analysis_idx
  ON audit_findings (user_id, work_id, analysis, subject);

COMMENT ON COLUMN audit_findings.analysis IS
  'Quelle analyse a produit ce constat. Ce qui borne le nettoyage : une passe '
  'sur les mystères ne doit jamais effacer ce qu''une relecture de chapitre a '
  'trouvé.';

COMMENT ON COLUMN audit_findings.subject IS
  'Le sujet exact examiné — numéro de chapitre, identifiant d''assertion ou de '
  'mystère. Null pour les règles, qui repassent sur toute la bibliothèque.';

CREATE TABLE IF NOT EXISTS audit_passes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  work_id           uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  analysis          text NOT NULL,
  subject_kind      text NOT NULL,
  subject           text NOT NULL,
  input_fingerprint text NOT NULL,
  prompt_version    text NOT NULL,
  model_id          text,
  cost_cents        numeric(14, 6) NOT NULL DEFAULT 0,
  findings          integer NOT NULL DEFAULT 0,
  ok                boolean NOT NULL DEFAULT true,
  failure           text,
  read_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_passes_subject_known
    CHECK (subject_kind IN ('chapter', 'identity', 'mystery'))
);

CREATE UNIQUE INDEX IF NOT EXISTS audit_passes_unique
  ON audit_passes (user_id, work_id, analysis, subject);

CREATE INDEX IF NOT EXISTS audit_passes_analysis_idx
  ON audit_passes (user_id, work_id, analysis, ok);

-- Reprendre l'historique déjà payé. Empreinte vide et version 0 rendent ces
-- lectures périmées pour la nouvelle consigne sans perdre leur coût historique.
INSERT INTO audit_passes (
  user_id, work_id, analysis, subject_kind, subject,
  input_fingerprint, prompt_version, model_id, cost_cents, findings, read_at
)
SELECT user_id, work_id, 'scenes', 'chapter', chapter::text,
       '', '0', model_id, cost_cents, findings, read_at
  FROM audit_reads
ON CONFLICT (user_id, work_id, analysis, subject) DO NOTHING;

-- Ne pas supprimer audit_reads ici : le main actuel l'utilise encore. Elle
-- pourra être retirée dans une migration ultérieure une fois tous les
-- déploiements passés sur audit_passes.

ALTER TABLE audit_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_passes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_passes_ingest_all ON audit_passes;
CREATE POLICY audit_passes_ingest_all ON audit_passes
  FOR ALL TO app_ingest
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_passes TO app_ingest;

COMMENT ON TABLE audit_passes IS
  'Ce que chaque analyse a déjà lu, sujet par sujet, avec l''empreinte de ses '
  'entrées et la version de sa consigne. Une passe n''est refaite que si son '
  'sujet ou sa consigne change.';

COMMENT ON COLUMN audit_passes.input_fingerprint IS
  'Condensé de la matière donnée au modèle. Elle change quand le sujet change, '
  'et ne change pas quand on reclique.';

COMMENT ON COLUMN audit_passes.prompt_version IS
  'La version de la consigne au moment de la lecture. La changer rend périmée '
  'cette analyse-là, et elle seule.';
