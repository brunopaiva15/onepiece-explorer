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
 *
 * Two steps from the original plan are deliberately absent rather than listed
 * as unbuilt. `build_review_batch` had nothing to do: the steps that produce
 * proposals write them with their own priority and explicit-review flag, and a
 * separate pass to sort what is already sorted would be ceremony. And the
 * chapter summary cannot run in this sequence at all — a summary written before
 * review would summarise unvalidated proposals, which is precisely the thing
 * this pipeline refuses to present as knowledge. It belongs after publication,
 * with the narrative delta.
 */

import type { ChapterSourceKind } from '@/db/schema/documents.ts'

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
  | 'auto_publish'

export interface StepDefinition {
  key: StepKey
  /** Shown in the progress view. */
  label: string
  /** One line on what it does, for the same view. */
  detail: string
  /** Does it call a model? Drives the cost estimate and the no-key banner. */
  usesModel: boolean
  implemented: boolean
  /**
   * Which kinds of source this step can read.
   *
   * A chapter written as text has no pages, so panel detection and
   * transcription have nothing to operate on. They are filtered out rather than
   * recorded as skipped: a permanent row saying "découpage en cases — ignoré"
   * on every chapter of a product that no longer reads images is noise
   * pretending to be information.
   */
  appliesTo: readonly ChapterSourceKind[]
}

const PAGES_ONLY = ['pages'] as const
const BOTH = ['pages', 'summary'] as const

export const STEPS: readonly StepDefinition[] = [
  {
    key: 'panel_detect',
    label: 'Découpage en cases',
    detail:
      'Profils de projection sur les gouttières, puis découpe récursive et tri en ordre de lecture. Déterministe, sans modèle.',
    usesModel: false,
    implemented: true,
    appliesTo: PAGES_ONLY,
  },
  {
    key: 'text_detect',
    label: 'Repérage du texte',
    detail:
      'Rattache chaque bloc de texte à la case qui le contient. Gratuit quand le PDF portait déjà sa couche texte.',
    usesModel: false,
    implemented: true,
    appliesTo: PAGES_ONLY,
  },
  {
    key: 'ocr',
    label: 'Transcription',
    detail:
      'Ignorée si la source portait une couche texte : celle-ci est exacte et gratuite. Sinon tesseract, puis un modèle si la confiance est basse.',
    usesModel: true,
    implemented: true,
    appliesTo: PAGES_ONLY,
  },
  {
    key: 'panel_describe',
    label: 'Description des cases',
    detail: 'Description factuelle de ce qui est dessiné, case par case.',
    usesModel: true,
    implemented: true,
    appliesTo: PAGES_ONLY,
  },
  {
    key: 'extract_candidates',
    label: 'Extraction des candidats',
    detail:
      'Entités, événements et relations, chacun obligatoirement ancré à un passage réel du texte source.',
    usesModel: true,
    implemented: true,
    appliesTo: BOTH,
  },
  {
    key: 'resolve_entities',
    label: 'Rapprochement des entités',
    detail:
      'Blocage par trigramme puis score multi-signaux. Propose des candidats justifiés ; ne fusionne jamais seul.',
    usesModel: true,
    implemented: true,
    appliesTo: BOTH,
  },
  {
    key: 'detect_conflicts',
    label: 'Détection des contradictions',
    detail: 'Confronte chaque proposition aux assertions déjà acceptées.',
    usesModel: false,
    implemented: true,
    appliesTo: BOTH,
  },
  {
    key: 'summarize_chapter',
    label: 'Résumé du chapitre',
    detail:
      "Chaque phrase pointe les assertions qui la soutiennent. Ne peut pas s'exécuter ici : " +
      'un résumé écrit avant la revue résumerait des propositions non validées. Il est produit ' +
      'après publication, avec le delta narratif.',
    usesModel: true,
    implemented: false,
    // Pointless on a chapter you wrote yourself: the source *is* a summary, and
    // asking a model to summarise your summary before anything is validated
    // would produce a worse text with no citations.
    appliesTo: PAGES_ONLY,
  },
  {
    key: 'embed',
    label: 'Indexation sémantique',
    detail:
      'Vecteurs pour la recherche sémantique. Sans fournisseur d’embeddings configuré, '
      + 'l’étape se déclare ignorée : la recherche plein texte, approchante et par graphe '
      + 'fonctionne sans elle.',
    usesModel: true,
    implemented: true,
    appliesTo: BOTH,
  },
  {
    key: 'auto_publish',
    label: 'Publication automatique',
    detail:
      'Ignorée sauf si AUTO_REVIEW_NAMES_ONLY=1. Accepte alors les propositions sans les soumettre, '
      + 'à partir de AUTO_ACCEPT_CONFIDENCE (0,75 par défaut), et laisse en revue les questions de '
      + 'nom, les propositions sous ce seuil — plus les relations qui en dépendent. Rapprochements '
      + 'laissés à trancher, contradictions reportées : leur publication n’est pas implémentée. '
      + 'Le chapitre s’ouvre dès qu’il ne reste rien à trancher.',
    usesModel: false,
    implemented: true,
    appliesTo: BOTH,
  },
] as const

export function stepDefinition(key: string): StepDefinition | undefined {
  return STEPS.find((step) => step.key === key)
}

/**
 * The pipeline for one kind of source, in order.
 *
 * Every list shown or written about a run goes through this — the pending rows
 * created at launch, the progress view, the cost estimate — so that all three
 * agree about what is supposed to happen. Three lists derived independently
 * from the same registry is how a run comes to display a step it never
 * intended to execute.
 */
export function stepsFor(sourceKind: ChapterSourceKind): readonly StepDefinition[] {
  return STEPS.filter((step) => step.appliesTo.includes(sourceKind))
}

/** Steps that can actually run today, for this kind of source, in order. */
export function runnableSteps(
  sourceKind: ChapterSourceKind,
): readonly StepDefinition[] {
  return stepsFor(sourceKind).filter((step) => step.implemented)
}
