import type { Locale } from '../index.ts'

/** Strings for the settings area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  metaTitle: 'Réglages et santé',
  breadcrumb: "Journal d'exploration",
  title: 'Réglages et santé',

  // Configuration
  configHeading: 'Configuration',
  modelProviderLabel: 'Fournisseur de modèle',
  modelProviderNote:
    "Aucune clé Anthropic : l'extraction affichée est dérivée du texte, pas d'une lecture des pages.",
  semanticSearchLabel: 'Recherche sémantique',
  semanticActive: 'active',
  semanticDisabled: 'désactivée',
  semanticNote:
    'La recherche plein texte, approchante et par graphe fonctionne sans elle.',
  assistantLabel: 'Assistant conversationnel',
  assistantActive: 'actif',
  assistantDisabled: 'désactivé',
  assistantOnNote:
    'Chaque question appelle un modèle et se facture à la question.',
  assistantOffNote:
    "Interrupteur distinct de la clé du modèle : une clé pour le pipeline n'ouvre pas une facturation à la question. ASSISTANT_ENABLED=1 pour l'activer.",
  readingPositionLabel: 'Position de lecture',
  readingAll: (max: number) => `tout (jusqu'au chapitre ${max})`,
  readingAt: (chapter: number, max: number) => `chapitre ${chapter} sur ${max}`,

  // AI cost
  costHeading: "Coût de l'IA",
  costNone: 'Aucun traitement encore lancé.',
  costTotals: (total: string, average: string, count: number) =>
    `${total} $ au total · ${average} $ par chapitre en moyenne, sur ${count} chapitre(s).`,
  estimateSentence: (judgement: string) => `L'estimation était ${judgement}.`,
  estimateOptimistic: (factor: string) => `optimiste d'un facteur ${factor}`,
  estimatePessimistic: (factor: string) => `pessimiste d'un facteur ${factor}`,
  estimateFair: 'juste',
  cacheHits: (percent: number) =>
    `${percent} % des tokens d'entrée sont venus du cache.`,
  dollars: (amount: string) => `${amount} $`,
  costTableCaption: 'Coût par étape du pipeline',
  costColStep: 'Étape',
  costColRuns: 'Exécutions',
  costColTotal: 'Total',
  costColTokens: 'Tokens',
  costColModel: 'Modèle',

  // Public reading
  publicHeading: 'Lecture publique',
  publicOpenStrong: 'Ouverte.',
  publicOpenBody:
    "N'importe qui peut explorer le graphe, la chronologie, les fiches et la recherche, et déplacer le curseur où il en est de sa lecture. Les pages de manga, elles, restent derrière l'authentification : un visiteur voit la référence de la case et l'extrait cité, jamais l'image. L'import, la revue, la suppression, l'export, l'enrichissement et l'assistant restent à vous seul.",
  publicClosedStrong: 'Fermée.',
  publicClosedBeforeCode:
    "Chaque page exige une connexion. Pour ouvrir la lecture, posez la variable d'environnement",
  publicClosedAfterCode: "sur l'identifiant ci-dessous, et redéployez.",
  publicMismatchStrong: 'Ouverte sur une autre bibliothèque.',
  publicMismatchAfterCode:
    "ne correspond pas à la vôtre : les visiteurs ne voient donc rien de ce qui suit. C'est presque toujours une faute de frappe.",
  libraryIdLabel: 'Identifiant de votre bibliothèque',
  libraryIdNote:
    "À coller dans PUBLIC_LIBRARY_OWNER_ID pour ouvrir la lecture publique. Ce n'est pas un secret : c'est un identifiant, et il ne donne aucun droit d'écriture.",

  // Illustrations
  illustrationsHeading: 'Illustrations',
  illustrationsBody:
    "Les portraits, fruits, navires et lieux viennent de trois catalogues publics et gratuits — onepieceapi.com, api-onepiece.com et AniList — rapprochés de vos entités par leur nom. Ce sont des illustrations, pas des sources : aucune ne peut justifier un fait, et une image n'apparaît qu'à partir du chapitre où vous apprenez le nom qui l'a trouvée. Les fichiers sont recopiés dans votre bucket privé plutôt que chargés depuis chez eux, pour que trois tiers n'aient pas la liste des personnages que vous consultez.",

  // Spending guard
  spendGuardHeading: 'Garde-fou de dépense',
  spendGuardBody:
    "Les opérations qui appellent un modèle sont plafonnées par heure. Ce n'est pas une protection contre un intrus — vous êtes seul ici — mais contre une boucle : un script relancé, un onglet qui rejoue une requête à chaque focus. La facture, elle, ne fait pas la différence. La lecture, la navigation et le graphe ne sont jamais comptés.",
  actionLabels: {
    ask: "Questions à l'assistant",
    start_run: 'Traitements de chapitre',
    export: 'Exports complets',
  } as Record<string, string>,
  lastHour: 'sur la dernière heure',

  // Pipeline health
  pipelineHeading: 'Santé du pipeline',
  quarantineHeading: 'Quarantaine',
  quarantineBody:
    'Une même raison qui domine indique un problème systématique, pas une mauvaise passe du modèle.',
  stepFailuresHeading: "Échecs d'étape",
  attempts: (n: number) => `${n} tentative(s)`,

  // Orphaned assertions
  orphansHeading: (n: number) => `Faits sans source (${n})`,
  orphansBody:
    "Ces faits restent dans votre graphe mais leur chapitre a été supprimé : ils ne sont plus vérifiables. Réimportez le chapitre concerné et la preuve se rattache d'elle-même.",
  orphanChapter: (n: number) => `chapitre ${n}`,

  // Data export
  dataHeading: 'Vos données',
  dataBody:
    "L'export contient tout : chapitres, entités, assertions, preuves, vos théories et chacune de vos décisions de revue. Pas les pages elles-mêmes — ce sont vos fichiers, vous les avez déjà, et un export qui les embarquerait ferait de cet outil un canal de redistribution.",
  dataDownload: "Télécharger l'export complet (JSON)",

  // Delete-chapter section
  deleteHeading: 'Supprimer un chapitre',
  deleteBody:
    "Les pages et leurs dérivés sont effacés du stockage. Les faits appris, eux, sont conservés : vous les avez appris, et les effacer réécrirait votre graphe à votre place. Ils apparaîtront ci-dessus comme non vérifiables jusqu'à un réimport.",
  deleteSelectLabel: 'Chapitre à supprimer',
  deleteOption: (number: number, title: string | null, pageCount: number) =>
    `Chapitre ${number}${title ? ` — ${title}` : ''} (${pageCount} p.)`,
  deleteComputing: 'Calcul des conséquences…',
  deleteWillErase: (n: number) => `Supprimer le chapitre ${n} effacera :`,
  deletePagesObjects: (pages: number, objects: number) =>
    `${pages} page(s) et ${objects} objet(s) stockés`,
  deletePanelsBlocks: (panels: number, blocks: number) =>
    `${panels} case(s) et ${blocks} bloc(s) de texte`,
  deleteKeptLead: (n: number) =>
    `${n} fait(s) resteront dans votre graphe mais deviendront`,
  deleteKeptStrong: 'non vérifiables',
  deleteKeptTail: ' — leur preuve aura disparu. Un réimport les recolle.',
  deletePurgedLead: (facts: number, entities: number) =>
    `${facts} fait(s) et ${entities} entité(s) seront`,
  deletePurgedStrong: 'définitivement supprimés',
  deletePurgedTail: '.',
  deleteAlsoLabel:
    'Supprimer aussi les faits appris dans ce chapitre. Irréversible : vos décisions de revue les concernant sont conservées, mais les assertions elles-mêmes ne le seront pas.',
  deleteTypeLead: 'Tapez',
  deleteTypeTail: 'pour confirmer',
  deleting: 'Suppression…',
  deleteConfirmButton: 'Supprimer définitivement',
  deleteDone: (n: number) => `Chapitre ${n} supprimé.`,
  deleteDonePagesObjects: (pages: number, objects: number) =>
    `${pages} page(s), ${objects} objet(s) effacés`,
  deleteDoneOrphaned: (n: number) => `${n} fait(s) désormais sans preuve`,
  deleteDoneStillSourced: (n: number) =>
    `${n} fait(s) toujours vérifiables — ils citaient aussi un autre chapitre`,

  // Enrich images
  typeLabels: {
    character: 'Personnages',
    power: 'Fruits du démon et pouvoirs',
    object: 'Objets et navires',
    place: 'Lieux et îles',
  } as Record<string, string>,
  enrichEmpty:
    "Aucune entité illustrable pour l'instant. Importez et publiez un chapitre, et les personnages, fruits, navires et lieux qu'il révèle apparaîtront ici.",
  enrichShare: (share: number) => `${share} %`,
  enrichShareAria: (share: number) => `${share} % illustrés`,
  enrichSearching: 'Recherche des illustrations…',
  enrichAllIllustrated: 'Tout est illustré',
  enrichButton: (missing: number) =>
    `Chercher une image pour ${missing} entité(s)`,
  enrichPacing:
    'Une requête par image, à un rythme volontairement lent : les trois catalogues sont gratuits et ne nous doivent rien. Comptez quelques minutes sur une grande bibliothèque.',
  enrichStored: (stored: number, considered: number) =>
    `${stored} image(s) récupérée(s) sur ${considered} entité(s) examinée(s).`,
  enrichUnmatched: (unmatched: number, catalogueSize: number) =>
    `${unmatched} sans correspondance dans les ${catalogueSize} illustrations du catalogue — c'est le cas normal pour un personnage secondaire ou une désignation provisoire, pas une erreur.`,
  enrichFailures: (n: number) => `${n} échec(s) de téléchargement.`,

  // Server actions
  chapterNotFound: 'Chapitre introuvable.',
  previewFailed: 'Aperçu impossible.',
  confirmIncorrect: (n: number) =>
    `Confirmation incorrecte. Tapez ${n} pour confirmer la suppression du chapitre ${n}.`,
  deleteFailed: 'Suppression impossible.',
  rateLimited: (minutes: number) =>
    `Limite atteinte. Réessayez dans ${minutes} minute(s).`,
  enrichFailed: 'Enrichissement impossible.',
  noteCatalogueDown: (source: string, reason: string) =>
    `${source} injoignable : ${reason}`,
  noteEntityFailed: (label: string, reason: string) =>
    `« ${label} » : ${reason}`,
}

const en: typeof fr = {
  metaTitle: 'Settings and health',
  breadcrumb: 'Exploration journal',
  title: 'Settings and health',

  configHeading: 'Configuration',
  modelProviderLabel: 'Model provider',
  modelProviderNote:
    'No Anthropic key: the extraction shown is derived from the text, not from a reading of the pages.',
  semanticSearchLabel: 'Semantic search',
  semanticActive: 'active',
  semanticDisabled: 'disabled',
  semanticNote: 'Full-text, fuzzy and graph search all work without it.',
  assistantLabel: 'Conversational assistant',
  assistantActive: 'on',
  assistantDisabled: 'off',
  assistantOnNote: 'Each question calls a model and is billed per question.',
  assistantOffNote:
    'A switch separate from the model key: a key for the pipeline does not open per-question billing. Set ASSISTANT_ENABLED=1 to turn it on.',
  readingPositionLabel: 'Reading position',
  readingAll: (max: number) => `everything (up to chapter ${max})`,
  readingAt: (chapter: number, max: number) => `chapter ${chapter} of ${max}`,

  costHeading: 'AI cost',
  costNone: 'No processing has been run yet.',
  costTotals: (total: string, average: string, count: number) =>
    `$${total} in total · $${average} per chapter on average, across ${count} chapter${count === 1 ? '' : 's'}.`,
  estimateSentence: (judgement: string) => `The estimate was ${judgement}.`,
  estimateOptimistic: (factor: string) => `optimistic by a factor of ${factor}`,
  estimatePessimistic: (factor: string) =>
    `pessimistic by a factor of ${factor}`,
  estimateFair: 'accurate',
  cacheHits: (percent: number) =>
    `${percent}% of input tokens came from the cache.`,
  dollars: (amount: string) => `$${amount}`,
  costTableCaption: 'Cost per pipeline step',
  costColStep: 'Step',
  costColRuns: 'Runs',
  costColTotal: 'Total',
  costColTokens: 'Tokens',
  costColModel: 'Model',

  publicHeading: 'Public reading',
  publicOpenStrong: 'Open.',
  publicOpenBody:
    'Anyone can explore the graph, the timeline, the entity pages and search, and move the slider to wherever they are in their own reading. The manga pages themselves stay behind authentication: a visitor sees the panel reference and the quoted excerpt, never the image. Importing, review, deletion, export, enrichment and the assistant remain yours alone.',
  publicClosedStrong: 'Closed.',
  publicClosedBeforeCode:
    'Every page requires signing in. To open up reading, set the environment variable',
  publicClosedAfterCode: 'to the identifier below, and redeploy.',
  publicMismatchStrong: 'Open on another library.',
  publicMismatchAfterCode:
    'does not match yours: visitors therefore see none of what follows. It is almost always a typo.',
  libraryIdLabel: 'Your library identifier',
  libraryIdNote:
    'Paste it into PUBLIC_LIBRARY_OWNER_ID to open public reading. It is not a secret: it is an identifier, and it grants no write access.',

  illustrationsHeading: 'Illustrations',
  illustrationsBody:
    'Portraits, fruits, ships and places come from three free public catalogues — onepieceapi.com, api-onepiece.com and AniList — matched to your entities by name. They are illustrations, not sources: none of them can justify a fact, and an image only appears from the chapter where you learn the name that found it. The files are copied into your private bucket rather than loaded from their servers, so that three third parties do not hold the list of characters you look at.',

  spendGuardHeading: 'Spending guard',
  spendGuardBody:
    'Operations that call a model are capped per hour. Not protection against an intruder — you are alone here — but against a loop: a re-run script, a tab replaying a request on every focus. The bill does not know the difference. Reading, navigation and the graph are never counted.',
  actionLabels: {
    ask: 'Questions to the assistant',
    start_run: 'Chapter processing runs',
    export: 'Full exports',
  } as Record<string, string>,
  lastHour: 'over the last hour',

  pipelineHeading: 'Pipeline health',
  quarantineHeading: 'Quarantine',
  quarantineBody:
    'A single reason that dominates points to a systematic problem, not a bad run of the model.',
  stepFailuresHeading: 'Step failures',
  attempts: (n: number) => `${n} attempt${n === 1 ? '' : 's'}`,

  orphansHeading: (n: number) => `Facts without a source (${n})`,
  orphansBody:
    'These facts remain in your graph but their chapter has been deleted: they are no longer verifiable. Re-import the chapter concerned and the evidence reattaches itself.',
  orphanChapter: (n: number) => `chapter ${n}`,

  dataHeading: 'Your data',
  dataBody:
    'The export contains everything: chapters, entities, assertions, evidence, your theories and every one of your review decisions. Not the pages themselves — those are your files, you already have them, and an export that bundled them would turn this tool into a redistribution channel.',
  dataDownload: 'Download the full export (JSON)',

  deleteHeading: 'Delete a chapter',
  deleteBody:
    'The pages and their derivatives are erased from storage. The facts learned from them, however, are kept: you learned them, and erasing them would rewrite your graph on your behalf. They will appear above as unverifiable until a re-import.',
  deleteSelectLabel: 'Chapter to delete',
  deleteOption: (number: number, title: string | null, pageCount: number) =>
    `Chapter ${number}${title ? ` — ${title}` : ''} (${pageCount} p.)`,
  deleteComputing: 'Working out the consequences…',
  deleteWillErase: (n: number) => `Deleting chapter ${n} will erase:`,
  deletePagesObjects: (pages: number, objects: number) =>
    `${pages} page${pages === 1 ? '' : 's'} and ${objects} stored object${objects === 1 ? '' : 's'}`,
  deletePanelsBlocks: (panels: number, blocks: number) =>
    `${panels} panel${panels === 1 ? '' : 's'} and ${blocks} text block${blocks === 1 ? '' : 's'}`,
  deleteKeptLead: (n: number) =>
    `${n} fact${n === 1 ? '' : 's'} will remain in your graph but become`,
  deleteKeptStrong: 'unverifiable',
  deleteKeptTail:
    ' — their evidence will be gone. A re-import reattaches them.',
  deletePurgedLead: (facts: number, entities: number) =>
    `${facts} fact${facts === 1 ? '' : 's'} and ${entities} entit${entities === 1 ? 'y' : 'ies'} will be`,
  deletePurgedStrong: 'permanently deleted',
  deletePurgedTail: '.',
  deleteAlsoLabel:
    'Also delete the facts learned in this chapter. Irreversible: your review decisions about them are kept, but the assertions themselves will not be.',
  deleteTypeLead: 'Type',
  deleteTypeTail: 'to confirm',
  deleting: 'Deleting…',
  deleteConfirmButton: 'Delete permanently',
  deleteDone: (n: number) => `Chapter ${n} deleted.`,
  deleteDonePagesObjects: (pages: number, objects: number) =>
    `${pages} page${pages === 1 ? '' : 's'}, ${objects} object${objects === 1 ? '' : 's'} erased`,
  deleteDoneOrphaned: (n: number) =>
    `${n} fact${n === 1 ? '' : 's'} now without evidence`,
  deleteDoneStillSourced: (n: number) =>
    n === 1
      ? '1 fact still verifiable — it also cited another chapter'
      : `${n} facts still verifiable — they also cited another chapter`,

  typeLabels: {
    character: 'Characters',
    power: 'Devil fruits and powers',
    object: 'Objects and ships',
    place: 'Places and islands',
  } as Record<string, string>,
  enrichEmpty:
    'No illustratable entities yet. Import and publish a chapter, and the characters, fruits, ships and places it reveals will appear here.',
  enrichShare: (share: number) => `${share}%`,
  enrichShareAria: (share: number) => `${share}% illustrated`,
  enrichSearching: 'Searching for illustrations…',
  enrichAllIllustrated: 'Everything is illustrated',
  enrichButton: (missing: number) =>
    `Find an image for ${missing} entit${missing === 1 ? 'y' : 'ies'}`,
  enrichPacing:
    'One request per image, at a deliberately slow pace: the three catalogues are free and owe us nothing. Allow a few minutes on a large library.',
  enrichStored: (stored: number, considered: number) =>
    `${stored} image${stored === 1 ? '' : 's'} fetched across ${considered} entit${considered === 1 ? 'y' : 'ies'} examined.`,
  enrichUnmatched: (unmatched: number, catalogueSize: number) =>
    `${unmatched} without a match among the catalogue's ${catalogueSize} illustrations — the normal case for a minor character or a provisional designation, not an error.`,
  enrichFailures: (n: number) =>
    `${n} download failure${n === 1 ? '' : 's'}.`,

  chapterNotFound: 'Chapter not found.',
  previewFailed: 'Preview unavailable.',
  confirmIncorrect: (n: number) =>
    `Incorrect confirmation. Type ${n} to confirm deleting chapter ${n}.`,
  deleteFailed: 'Deletion failed.',
  rateLimited: (minutes: number) =>
    `Limit reached. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  enrichFailed: 'Enrichment failed.',
  noteCatalogueDown: (source: string, reason: string) =>
    `${source} unreachable: ${reason}`,
  noteEntityFailed: (label: string, reason: string) =>
    `“${label}”: ${reason}`,
}

export const settings = { fr, en } satisfies Record<Locale, typeof fr>
