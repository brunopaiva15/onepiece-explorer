import type { Locale } from '../index.ts'

/** Strings for the runs area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  // --- Page (runs/[id]/page.tsx) --------------------------------------------
  metaTitle: 'Progression du traitement',
  breadcrumbJournal: 'Journal',
  breadcrumbChapters: 'Chapitres',
  intro:
    'Chaque étape est enregistrée avec sa durée, son coût réel et ses ' +
    "éventuelles tentatives. Rien n'est publié automatiquement : un " +
    'traitement réussi produit des propositions, jamais du canon.',
  noKeyTitle: 'Aucune clé Anthropic configurée.',
  noKeyBody:
    'Les étapes qui appellent un modèle sont désactivées. Le découpage en ' +
    'cases et le rattachement du texte, eux, sont déterministes et ' +
    "fonctionnent : ils ne dépendent d'aucun modèle.",

  // --- Progress view (run-progress.tsx) --------------------------------------
  // Step status (ingestion_steps.status database values).
  stepStatus: {
    pending: 'en attente',
    running: 'en cours',
    succeeded: 'terminé',
    failed: 'échec',
    skipped: 'ignoré',
    cached: 'réutilisé',
  } as Record<string, string>,

  // Run status (ingestion_runs.status database values), as a sentence.
  runStatus: {
    pending: 'en attente de démarrage',
    running: 'en cours',
    succeeded: 'terminé — les propositions attendent votre revue',
    failed: 'échec',
    cancelled: 'annulé',
    paused: 'en pause',
  } as Record<string, string>,

  // The recorded provider choice, in words. Older rows hold a resolved name.
  provider: {
    auto: 'modèle par défaut',
    anthropic: 'Anthropic',
    local: 'modèle auto-hébergé',
    synthetic: 'fournisseur synthétique — extraction générée, pas issue des pages',
    replay: 'réponses rejouées',
  } as Record<string, string>,

  /**
   * Step names, keyed by the pipeline registry's step keys
   * (src/domains/pipeline/registry.ts). The server still sends the registry's
   * French label; an unknown key falls back to it.
   */
  stepLabels: {
    panel_detect: 'Découpage en cases',
    text_detect: 'Repérage du texte',
    ocr: 'Transcription',
    panel_describe: 'Description des cases',
    extract_candidates: 'Extraction des candidats',
    resolve_entities: 'Rapprochement des entités',
    detect_conflicts: 'Détection des contradictions',
    summarize_chapter: 'Résumé du chapitre',
    embed: 'Indexation sémantique',
  } as Record<string, string>,

  stepsOf: (done: number, total: number) => `${done} / ${total} étapes`,
  streamLost: ' · connexion au flux perdue, reconnexion',
  stalled:
    'Plus rien ne bouge depuis plusieurs minutes. Le traitement a ' +
    "probablement été interrompu avant d'avoir pu enregistrer son " +
    'échec. Relancez-le depuis le chapitre : les tranches déjà ' +
    'payées sont rejouées, pas rachetées.',
  realCost: (amount: string) => `coût réel ${amount} $`,
  progressAria: 'Progression du pipeline',
  attempt: (n: number) => `essai ${n}`,
  modelBadge: 'modèle',
  modelBadgeTitle: 'Cette étape appelle un modèle',

  // Technical details table.
  techDetails: 'Détails techniques',
  thStep: 'étape',
  thState: 'état',
  thSlices: 'tranches',
  thAttempt: 'essai',
  thDuration: 'durée',
  thTokIn: 'tok. in',
  thTokOut: 'tok. out',
  thCache: 'cache r/w',
  thCost: 'coût ¢',
  thModel: 'modèle',
  dtRun: 'run',
  dtChapter: 'chapitre',
  dtProvider: 'fournisseur',
  dtPipelineVersion: 'version pipeline',
  dtCreated: 'créé',
  dtStarted: 'démarré',
  dtFinished: 'terminé',
  dtWorkTime: 'temps de travail',
  workedFor: (seconds: string) => `${seconds}s cumulés sur les étapes`,

  reviewProposals: 'Revoir les propositions',
  viewChapterPages: 'Voir les pages du chapitre',
  importNext: 'Importer le suivant',

  /** A completed duration, at a glance. */
  duration: (ms: number) => {
    if (ms < 1_000) return `${ms} ms`
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
    const minutes = Math.floor(ms / 60_000)
    return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`
  },
  /** A duration a human reads while watching it grow. */
  elapsed: (ms: number) => {
    const total = Math.max(0, Math.round(ms / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return minutes > 0
      ? `${minutes} min ${String(seconds).padStart(2, '0')} s`
      : `${seconds} s`
  },
}

const en: typeof fr = {
  // --- Page -----------------------------------------------------------------
  metaTitle: 'Run progress',
  breadcrumbJournal: 'Journal',
  breadcrumbChapters: 'Chapters',
  intro:
    'Every step is recorded with its duration, its actual cost and any ' +
    'retries. Nothing is published automatically: a successful run produces ' +
    'proposals, never canon.',
  noKeyTitle: 'No Anthropic key configured.',
  noKeyBody:
    'The steps that call a model are disabled. Panel segmentation and text ' +
    'attachment, however, are deterministic and work: they depend on no model.',

  // --- Progress view ----------------------------------------------------------
  stepStatus: {
    pending: 'pending',
    running: 'running',
    succeeded: 'done',
    failed: 'failed',
    skipped: 'skipped',
    cached: 'reused',
  } as Record<string, string>,

  runStatus: {
    pending: 'waiting to start',
    running: 'running',
    succeeded: 'finished — the proposals await your review',
    failed: 'failed',
    cancelled: 'cancelled',
    paused: 'paused',
  } as Record<string, string>,

  provider: {
    auto: 'default model',
    anthropic: 'Anthropic',
    local: 'self-hosted model',
    synthetic: 'synthetic provider — generated extraction, not drawn from the pages',
    replay: 'replayed responses',
  } as Record<string, string>,

  stepLabels: {
    panel_detect: 'Panel segmentation',
    text_detect: 'Text detection',
    ocr: 'Transcription',
    panel_describe: 'Panel descriptions',
    extract_candidates: 'Candidate extraction',
    resolve_entities: 'Entity reconciliation',
    detect_conflicts: 'Contradiction detection',
    summarize_chapter: 'Chapter summary',
    embed: 'Semantic indexing',
  } as Record<string, string>,

  stepsOf: (done: number, total: number) => `${done} / ${total} steps`,
  streamLost: ' · stream connection lost, reconnecting',
  stalled:
    'Nothing has moved for several minutes. The run was probably ' +
    'interrupted before it could record its failure. Relaunch it from the ' +
    'chapter: slices already paid for are replayed, not repurchased.',
  realCost: (amount: string) => `actual cost $${amount}`,
  progressAria: 'Pipeline progress',
  attempt: (n: number) => `attempt ${n}`,
  modelBadge: 'model',
  modelBadgeTitle: 'This step calls a model',

  techDetails: 'Technical details',
  thStep: 'step',
  thState: 'state',
  thSlices: 'slices',
  thAttempt: 'attempt',
  thDuration: 'duration',
  thTokIn: 'tok. in',
  thTokOut: 'tok. out',
  thCache: 'cache r/w',
  thCost: 'cost ¢',
  thModel: 'model',
  dtRun: 'run',
  dtChapter: 'chapter',
  dtProvider: 'provider',
  dtPipelineVersion: 'pipeline version',
  dtCreated: 'created',
  dtStarted: 'started',
  dtFinished: 'finished',
  dtWorkTime: 'work time',
  workedFor: (seconds: string) => `${seconds}s accumulated across the steps`,

  reviewProposals: 'Review the proposals',
  viewChapterPages: 'View the chapter pages',
  importNext: 'Import the next one',

  duration: (ms: number) => {
    if (ms < 1_000) return `${ms} ms`
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
    const minutes = Math.floor(ms / 60_000)
    return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`
  },
  elapsed: (ms: number) => {
    const total = Math.max(0, Math.round(ms / 1000))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return minutes > 0
      ? `${minutes} min ${String(seconds).padStart(2, '0')} s`
      : `${seconds} s`
  },
}

export const runs = { fr, en } satisfies Record<Locale, typeof fr>
