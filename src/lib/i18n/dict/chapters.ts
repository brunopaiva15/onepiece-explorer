import type { Locale } from '../index.ts'

/** Strings for the chapters area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  // --- List (/chapitres) -------------------------------------------------
  metaTitle: 'Chapitres',
  title: 'Chapitres',
  importCta: '+ Importer',
  statImported: 'Importés',
  statToReview: 'À relire',
  statPublished: 'Publiés',
  statPages: 'Pages',
  emptyTitle: 'Rien encore',
  emptyBody:
    "Commencez par le premier chapitre que vous avez lu : c'est son numéro qui datera tout ce qu'il révèle.",
  emptyCta: 'Importer le chapitre 1',
  passagesN: (n: number) => `${n} passages`,
  pagesN: (n: number) => `${n} pages`,
  volumeN: (n: number) => `tome ${n}`,
  sourceWrittenTitle:
    'Chapitre écrit : les extraits citent votre texte, au caractère près',
  sourceTextLayerTitle: 'Couche texte : extraction exacte, sans OCR',
  sourceOcrTitle: 'Pas de couche texte : OCR requis',
  sourceWritten: 'texte écrit',
  sourceTextLayer: 'texte exact',
  sourceOcr: 'OCR',
  actionProcess: 'Traiter',
  actionFollow: 'Suivre',
  actionReview: 'Relire',
  actionDelta: 'Le delta',
  actionOpen: 'Ouvrir',

  // --- Detail (/chapitres/[id]) ------------------------------------------
  detailMetaTitle: 'Source du chapitre',
  breadcrumbJournal: 'Journal',
  breadcrumbImport: 'Import',
  chapterCartouche: 'Chapitre',
  unitPassages: 'passages',
  unitPages: 'pages',
  unitCharacters: 'caractères',
  sourceLanguageTitle: 'Langue de la source : celle des extraits cités',
  sourceLanguageBadge: (lang: string) => `source ${lang}`,
  lastRun: 'Dernier traitement',
  fixText: 'Corriger le texte',
  emptyWritten: "Ce chapitre n'a aucun passage. Réimportez son texte.",
  emptyPages: "Aucune page enregistrée pour ce chapitre. Relancez l'import.",
  parallelHeading: (lang: string) =>
    `Le même chapitre en ${lang === 'fr' ? 'français' : 'anglais'}`,
  parallelMeta: (n: number) => `${n} caractères · non citable`,
  parallelExplain:
    "Fourni au modèle pour les noms uniquement : la mise en regard des deux langues donne la forme française d'un nom au lieu de la lui faire deviner. Aucune preuve ne peut renvoyer ici, et un fait que ce texte serait seul à énoncer n'entre pas dans le graphe.",
  citeFooterWritten:
    "Chaque proposition devra citer mot pour mot un de ces passages. Un extrait qui n'y apparaît pas est mis en quarantaine et n'atteint jamais la revue — c'est ce qui empêche le modèle d'ajouter ce qu'il sait de One Piece par ailleurs.",
  citeFooterPages:
    "Les aperçus sont servis par des liens signés valables une minute. Aucune page n'a d'adresse permanente : un lien copié cesse de fonctionner.",

  // --- Page grid (client) -------------------------------------------------
  keptCount: (n: number) => `${n} page${n > 1 ? 's' : ''} retenue${n > 1 ? 's' : ''}`,
  excludedCount: (n: number) => `${n} exclue(s)`,
  readingRtl: 'Lecture droite à gauche',
  readingLtr: 'Lecture gauche à droite',
  savingEllipsis: 'Enregistrement…',
  saveOrder: 'Enregistrer l’ordre',
  orderSaved: 'Ordre enregistré.',
  orderFailed: 'Échec.',
  gridHelp:
    "Sélectionnez une page puis utilisez les flèches ← → pour la déplacer, ou les boutons. « Exclure » conserve la page et son fichier d'origine : elle cesse simplement de compter.",
  pageAria: (n: number, excluded: boolean) => `Page ${n}${excluded ? ', exclue' : ''}`,
  pageAlt: (n: number, chapter: number) => `Page ${n} du chapitre ${chapter}`,
  noPreview: 'Aperçu indisponible',
  doubleSpreadTitle: 'Double page probable',
  doubleSpreadBadge: 'double',
  textBlocksTitle: (n: number) => `${n} blocs de texte extraits`,
  moveEarlier: (n: number) => `Déplacer la page ${n} plus tôt`,
  moveLater: (n: number) => `Déplacer la page ${n} plus tard`,
  toggleExcludeAria: (n: number, excluded: boolean) =>
    `${excluded ? 'Réintégrer' : 'Exclure'} la page ${n}`,

  // --- Server actions -----------------------------------------------------
  unknownProvider: (provider: string) => `Fournisseur inconnu : ${provider}.`,
  startFailed: 'Lancement impossible.',
}

const en: typeof fr = {
  // --- List (/chapitres) -------------------------------------------------
  metaTitle: 'Chapters',
  title: 'Chapters',
  importCta: '+ Import',
  statImported: 'Imported',
  statToReview: 'To review',
  statPublished: 'Published',
  statPages: 'Pages',
  emptyTitle: 'Nothing yet',
  emptyBody:
    'Start with the first chapter you read: its number will date everything it reveals.',
  emptyCta: 'Import chapter 1',
  passagesN: (n: number) => `${n} passage${n === 1 ? '' : 's'}`,
  pagesN: (n: number) => `${n} page${n === 1 ? '' : 's'}`,
  volumeN: (n: number) => `volume ${n}`,
  sourceWrittenTitle:
    'Written chapter: excerpts quote your text, character for character',
  sourceTextLayerTitle: 'Text layer: exact extraction, no OCR',
  sourceOcrTitle: 'No text layer: OCR required',
  sourceWritten: 'written text',
  sourceTextLayer: 'exact text',
  sourceOcr: 'OCR',
  actionProcess: 'Process',
  actionFollow: 'Follow',
  actionReview: 'Review',
  actionDelta: 'The delta',
  actionOpen: 'Open',

  // --- Detail (/chapitres/[id]) ------------------------------------------
  detailMetaTitle: 'Chapter source',
  breadcrumbJournal: 'Journal',
  breadcrumbImport: 'Import',
  chapterCartouche: 'Chapter',
  unitPassages: 'passages',
  unitPages: 'pages',
  unitCharacters: 'characters',
  sourceLanguageTitle: 'Source language: the one quoted excerpts are in',
  sourceLanguageBadge: (lang: string) => `source ${lang}`,
  lastRun: 'Latest run',
  fixText: 'Fix the text',
  emptyWritten: 'This chapter has no passages. Re-import its text.',
  emptyPages: 'No pages recorded for this chapter. Run the import again.',
  parallelHeading: (lang: string) =>
    `The same chapter in ${lang === 'fr' ? 'French' : 'English'}`,
  parallelMeta: (n: number) => `${n} characters · not citable`,
  parallelExplain:
    'Provided to the model for names only: setting the two languages side by side gives the French form of a name instead of making the model guess it. No evidence can point here, and a fact this text alone states does not enter the graph.',
  citeFooterWritten:
    'Every proposal will have to quote one of these passages word for word. An excerpt that does not appear in them is quarantined and never reaches review — that is what keeps the model from adding what it otherwise knows about One Piece.',
  citeFooterPages:
    'Previews are served through signed links valid for one minute. No page has a permanent address: a copied link stops working.',

  // --- Page grid (client) -------------------------------------------------
  keptCount: (n: number) => `${n} page${n === 1 ? '' : 's'} kept`,
  excludedCount: (n: number) => `${n} excluded`,
  readingRtl: 'Right-to-left reading',
  readingLtr: 'Left-to-right reading',
  savingEllipsis: 'Saving…',
  saveOrder: 'Save order',
  orderSaved: 'Order saved.',
  orderFailed: 'Failed.',
  gridHelp:
    'Select a page, then move it with the ← → arrow keys, or with the buttons. “Exclude” keeps the page and its original file: it simply stops counting.',
  pageAria: (n: number, excluded: boolean) => `Page ${n}${excluded ? ', excluded' : ''}`,
  pageAlt: (n: number, chapter: number) => `Page ${n} of chapter ${chapter}`,
  noPreview: 'Preview unavailable',
  doubleSpreadTitle: 'Likely double-page spread',
  doubleSpreadBadge: 'double',
  textBlocksTitle: (n: number) => `${n} text block${n === 1 ? '' : 's'} extracted`,
  moveEarlier: (n: number) => `Move page ${n} earlier`,
  moveLater: (n: number) => `Move page ${n} later`,
  toggleExcludeAria: (n: number, excluded: boolean) =>
    `${excluded ? 'Restore' : 'Exclude'} page ${n}`,

  // --- Server actions -----------------------------------------------------
  unknownProvider: (provider: string) => `Unknown provider: ${provider}.`,
  startFailed: 'Could not start.',
}

export const chapters = { fr, en } satisfies Record<Locale, typeof fr>
