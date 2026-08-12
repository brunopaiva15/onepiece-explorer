import type { Locale } from '../index.ts'

/** Strings for the entity area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  // --- /graph (page header, counts, truncation notice) ---------------------
  graphTitle: 'Graphe',
  nodesUnit: 'nœuds',
  relationsUnit: 'relations',
  mergedUnit: 'regroupées',
  mergedCountTitle:
    'Entités fusionnées par une identité révélée à ce chapitre ou avant',
  tableView: 'Vue tableau',
  graphTruncated: (shown: number, total: number) =>
    `Graphe tronqué : ${shown} nœuds sur ${total}. Les plus connectés sont ` +
    "conservés — c'est l'ossature de l'histoire. Filtrez par type pour voir le reste.",

  // --- Graph explorer (filter chips, selection panel) ----------------------
  showAll: 'tout afficher',
  selectionTitle: 'Sélection',
  selectionHint: "Cliquez un nœud : sa fiche s'ouvre ici, sans quitter le graphe.",
  legendTitle: 'Lire le dessin',
  legendSize: 'La taille suit le nombre de relations.',
  legendInferred: 'Violet',
  legendInferredTail: ' : déduction.',
  legendHypothetical: 'Ambre',
  legendHypotheticalTail: ' : hypothèse. Gris : fait affirmé.',
  closeSelection: 'Fermer la sélection',
  firstAppearance: '1re apparition',
  relationsLabel: 'Relations',
  mergedLabel: 'Fusionnées',
  mergedNodeTitle: 'Apparitions distinctes identifiées comme une seule',
  visibleRelations: 'Relations visibles',
  offGraph: 'hors du graphe affiché',
  openFullSheet: 'Ouvrir la fiche complète',
  ch: (n: number) => `ch. ${n}`,

  // --- Graph canvas (WebGL rendering states, hover card) -------------------
  emptyGraph:
    'Rien de connu à ce chapitre. Remontez le curseur, ou importez et publiez un chapitre.',
  canvasAria: (nodes: number, edges: number, chapter: number) =>
    `Graphe de ${nodes} nœuds et ${edges} relations au chapitre ${chapter}`,
  computingLayout: 'Calcul de la disposition…',
  webglFailed: 'Le rendu WebGL a échoué.',
  webglFailedTail:
    'la vue tableau contient exactement les mêmes données et ne demande pas de GPU.',
  noIllustration: 'Aucune illustration',

  // --- /graph/table --------------------------------------------------------
  tableTitle: 'Graphe — vue tableau',
  graphView: 'Vue graphique',
  tableIntro:
    'Mêmes données que la vue graphique, au même chapitre. Aucun WebGL requis.',
  listTruncated: (shown: number, total: number) =>
    `Liste tronquée : ${shown} entités sur ${total}, les plus connectées d'abord.`,
  entitiesHeading: (n: number) => `Entités (${n})`,
  nothingKnownAt: (chapter: number) => `Rien de connu au chapitre ${chapter}.`,
  entitiesCaption: (chapter: number) =>
    `Entités connues au chapitre ${chapter}, par nombre de relations.`,
  entitiesCaptionImages: (shown: number) =>
    ` Les illustrations ne sont chargées que pour les ${shown} entités les plus reliées ; les autres lignes sont complètes mais sans image.`,
  thIllustration: 'Illustration',
  thName: 'Nom',
  thType: 'Type',
  thSeenFrom: 'Vue depuis',
  thRelations: 'Relations',
  thAppearances: 'Apparitions',
  unnamedBadge: '(sans nom)',
  unnamedBadgeTitle:
    'Aucun nom donné à ce stade : désignation tirée de l’image',
  relationsHeading: (n: number) => `Relations (${n})`,
  relationsCaption: (chapter: number) =>
    `Relations connues au chapitre ${chapter}`,
  thSubject: 'Sujet',
  thRelation: 'Relation',
  thObject: 'Objet',
  thStatus: 'Statut',
  thKnownSince: 'Su depuis',

  // Epistemic statuses that common.epistemic does not carry (it covers the
  // three visible-fact statuses); looked up after it, before the raw key.
  epistemicExtra: {
    contradicted: 'contredit',
    refuted: 'réfuté',
    user_validated: 'validé par vous',
  } as Record<string, string>,

  // --- /entite/[id] (the sheet) --------------------------------------------
  sheetTitle: 'Fiche',
  illustrationAlt: (label: string) => `Illustration de ${label}`,
  factsLabel: 'Faits',
  namesLabel: 'Noms connus',
  mergedPersonTitle:
    'Apparitions distinctes identifiées comme une seule personne',
  placeholderNote:
    "Aucun nom n'est donné à ce stade : cette désignation vient de l'image.",
  captionLead: 'Illustration',
  captionMatchedByName:
    ', rapprochée par le nom — pas une preuve tirée de vos pages.',
  namesIntro:
    "L'historique de ce qu'il fallait l'appeler. Reculez le curseur et le nom affiché change avec lui.",
  revealedCh: (n: number) => `révélé ch. ${n}`,
  knownFactsTitle: 'Ce que l’on sait',
  knownFactsEmpty: 'Rien d’affirmé à propos de cette entité à ce chapitre.',
  saidFactsTitle: 'Ce que l’on dit d’elle',
  provenanceNote:
    "Chaque fait porte le chapitre où vous avez pu l'apprendre et la case qui le prouve. Un fait sans preuve n'entre pas ici.",
  yourCorrection: 'votre correction',
  yourCorrectionTitle:
    'Corrigé par vous : jamais remplacé par une nouvelle extraction',
  knownSinceCh: (n: number) => `su depuis ch. ${n}`,
  beliefRefuted: (chapter: number) =>
    `Cette croyance sera démentie au chapitre ${chapter}.`,
  evidenceAlt: (page: number) => `Case source, page ${page}`,
  pageDot: (n: number) => ` · page ${n}`,

  // --- Portrait caption -----------------------------------------------------
  matchedFrom: (label: string) =>
    `· rapprochée depuis « ${label} »`,
  matchMethod: {
    exact: 'nom identique',
    tokens: 'mêmes mots, autre ordre',
    subset: 'nom partiel',
    trigram: 'orthographe proche',
  } as Record<string, string>,
}

const en: typeof fr = {
  graphTitle: 'Graph',
  nodesUnit: 'nodes',
  relationsUnit: 'relations',
  mergedUnit: 'merged',
  mergedCountTitle:
    'Entities merged by an identity revealed at this chapter or earlier',
  tableView: 'Table view',
  graphTruncated: (shown: number, total: number) =>
    `Graph truncated: ${shown} of ${total} nodes. The most connected are ` +
    'kept — that is the backbone of the story. Filter by type to see the rest.',

  showAll: 'show all',
  selectionTitle: 'Selection',
  selectionHint: 'Click a node: its sheet opens here, without leaving the graph.',
  legendTitle: 'Reading the drawing',
  legendSize: 'Size follows the number of relations.',
  legendInferred: 'Purple',
  legendInferredTail: ': inference.',
  legendHypothetical: 'Amber',
  legendHypotheticalTail: ': hypothesis. Grey: stated fact.',
  closeSelection: 'Close the selection',
  firstAppearance: 'First appearance',
  relationsLabel: 'Relations',
  mergedLabel: 'Merged',
  mergedNodeTitle: 'Distinct appearances identified as one',
  visibleRelations: 'Visible relations',
  offGraph: 'outside the displayed graph',
  openFullSheet: 'Open the full sheet',
  ch: (n: number) => `ch. ${n}`,

  emptyGraph:
    'Nothing known at this chapter. Move the slider back up, or import and publish a chapter.',
  canvasAria: (nodes: number, edges: number, chapter: number) =>
    `Graph of ${nodes} nodes and ${edges} relations at chapter ${chapter}`,
  computingLayout: 'Computing the layout…',
  webglFailed: 'WebGL rendering failed.',
  webglFailedTail:
    'the table view holds exactly the same data and needs no GPU.',
  noIllustration: 'No illustration',

  tableTitle: 'Graph — table view',
  graphView: 'Graph view',
  tableIntro: 'Same data as the graph view, at the same chapter. No WebGL required.',
  listTruncated: (shown: number, total: number) =>
    `List truncated: ${shown} of ${total} entities, most connected first.`,
  entitiesHeading: (n: number) => `Entities (${n})`,
  nothingKnownAt: (chapter: number) => `Nothing known at chapter ${chapter}.`,
  entitiesCaption: (chapter: number) =>
    `Entities known at chapter ${chapter}, by number of relations.`,
  entitiesCaptionImages: (shown: number) =>
    ` Illustrations are only loaded for the ${shown} most connected entities; the other rows are complete but have no image.`,
  thIllustration: 'Illustration',
  thName: 'Name',
  thType: 'Type',
  thSeenFrom: 'Seen from',
  thRelations: 'Relations',
  thAppearances: 'Appearances',
  unnamedBadge: '(unnamed)',
  unnamedBadgeTitle:
    'No name given at this point: designation taken from the image',
  relationsHeading: (n: number) => `Relations (${n})`,
  relationsCaption: (chapter: number) => `Relations known at chapter ${chapter}`,
  thSubject: 'Subject',
  thRelation: 'Relation',
  thObject: 'Object',
  thStatus: 'Status',
  thKnownSince: 'Known since',

  epistemicExtra: {
    contradicted: 'contradicted',
    refuted: 'refuted',
    user_validated: 'validated by you',
  } as Record<string, string>,

  sheetTitle: 'Sheet',
  illustrationAlt: (label: string) => `Illustration of ${label}`,
  factsLabel: 'Facts',
  namesLabel: 'Known names',
  mergedPersonTitle: 'Distinct appearances identified as a single person',
  placeholderNote:
    'No name is given at this point: this designation comes from the image.',
  captionLead: 'Illustration',
  captionMatchedByName: ', matched by name — not evidence drawn from your pages.',
  namesIntro:
    'The history of what to call them. Move the slider back and the displayed name changes with it.',
  revealedCh: (n: number) => `revealed ch. ${n}`,
  knownFactsTitle: 'What is known',
  knownFactsEmpty: 'Nothing asserted about this entity at this chapter.',
  saidFactsTitle: 'What is said about them',
  provenanceNote:
    'Every fact carries the chapter where you could have learned it and the panel that proves it. A fact without evidence does not enter here.',
  yourCorrection: 'your correction',
  yourCorrectionTitle: 'Corrected by you: never replaced by a new extraction',
  knownSinceCh: (n: number) => `known since ch. ${n}`,
  beliefRefuted: (chapter: number) =>
    `This belief will be disproved at chapter ${chapter}.`,
  evidenceAlt: (page: number) => `Source panel, page ${page}`,
  pageDot: (n: number) => ` · page ${n}`,

  matchedFrom: (label: string) => `· matched from “${label}”`,
  matchMethod: {
    exact: 'identical name',
    tokens: 'same words, different order',
    subset: 'partial name',
    trigram: 'close spelling',
  } as Record<string, string>,
}

export const entity = { fr, en } satisfies Record<Locale, typeof fr>
