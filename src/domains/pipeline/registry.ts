/**
 * The pipeline, as data.
 *
 * Every step is declared here with its order, its label and whether it needs a
 * model. Declaring them rather than hard-coding a sequence buys three things
 * that matter more than the indirection costs:
 *
 *   the progress view can list steps that have not run yet, so the user sees
 *   what is coming instead of a spinner that might mean anything;
 *
 *   a step can be skipped for a good reason and say so — a chapter with a PDF
 *   text layer legitimately skips OCR, and "skipped: source carried exact
 *   text" is information, while a silently absent step looks like a bug;
 *
 *   the cost estimate is a sum over declared steps, computed before the run
 *   starts rather than discovered as the bill arrives.
 *
 * Steps marked `implemented: false` are declared and visible but not yet
 * built. Showing them greyed out is honest; pretending the pipeline is
 * complete would not be.
 */

export type StepKey =
  | 'panel_detect'
  | 'text_detect'
  | 'ocr'
  | 'panel_describe'
  | 'extract_candidates'
  | 'resolve_entities'
  | 'detect_conflicts'
  | 'summarize_chapter'
  | 'embed'
  | 'build_review_batch'

export interface StepDefinition {
  key: StepKey
  /** Shown in the progress view. */
  label: string
  /** One line on what it does, for the same view. */
  detail: string
  /** Does it call a model? Drives the cost estimate and the no-key banner. */
  usesModel: boolean
  implemented: boolean
}

export const STEPS: readonly StepDefinition[] = [
  {
    key: 'panel_detect',
    label: 'Découpage en cases',
    detail:
      'Profils de projection sur les gouttières, puis découpe récursive et tri en ordre de lecture. Déterministe, sans modèle.',
    usesModel: false,
    implemented: true,
  },
  {
    key: 'text_detect',
    label: 'Repérage du texte',
    detail:
      'Rattache chaque bloc de texte à la case qui le contient. Gratuit quand le PDF portait déjà sa couche texte.',
    usesModel: false,
    implemented: true,
  },
  {
    key: 'ocr',
    label: 'Transcription',
    detail:
      'Ignorée si la source portait une couche texte : celle-ci est exacte et gratuite. Sinon tesseract, puis un modèle si la confiance est basse.',
    usesModel: true,
    implemented: true,
  },
  {
    key: 'panel_describe',
    label: 'Description des cases',
    detail: 'Description factuelle de ce qui est dessiné, case par case.',
    usesModel: true,
    implemented: true,
  },
  {
    key: 'extract_candidates',
    label: 'Extraction des candidats',
    detail:
      'Entités, événements et relations, chacun obligatoirement ancré à une case ou à un bloc de texte réel.',
    usesModel: true,
    implemented: true,
  },
  {
    key: 'resolve_entities',
    label: 'Rapprochement des entités',
    detail:
      'Blocage par trigramme puis score multi-signaux. Propose des candidats justifiés ; ne fusionne jamais seul.',
    usesModel: true,
    implemented: true,
  },
  {
    key: 'detect_conflicts',
    label: 'Détection des contradictions',
    detail: 'Confronte chaque proposition aux assertions déjà acceptées.',
    usesModel: false,
    implemented: true,
  },
  {
    key: 'summarize_chapter',
    label: 'Résumé du chapitre',
    detail: 'Chaque phrase pointe les assertions qui la soutiennent.',
    usesModel: true,
    implemented: false,
  },
  {
    key: 'embed',
    label: 'Indexation sémantique',
    detail: 'Vecteurs pour la recherche et pour l’assistant.',
    usesModel: true,
    implemented: false,
  },
  {
    key: 'build_review_batch',
    label: 'Constitution de la revue',
    detail:
      'Range les propositions par priorité. Identités, révélations, morts et contradictions passent toujours par une revue explicite.',
    usesModel: false,
    implemented: false,
  },
] as const

export function stepDefinition(key: string): StepDefinition | undefined {
  return STEPS.find((step) => step.key === key)
}

/** Steps that can actually run today, in order. */
export const RUNNABLE_STEPS: readonly StepDefinition[] = STEPS.filter(
  (step) => step.implemented,
)
