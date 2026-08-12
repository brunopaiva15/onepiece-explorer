import type { Locale } from '../index.ts'

/** Strings for the importer area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  // --- Page (/import) ------------------------------------------------------
  metaTitle: 'Importer un chapitre',
  chapterCartouche: 'Chapitre',
  heroTitle: 'Importer',
  heroLead: (last: number | null) =>
    `Le numéro date tout ce que ce chapitre révèle. Modifiable ci-dessous ; ${
      last === null
        ? 'commencez par celui que vous avez lu en premier.'
        : `le dernier importé est le ${last}.`
    }`,
  alreadyImported: 'Déjà importés',
  untitled: 'sans titre',
  passagesN: (n: number) => `${n} passages`,
  pagesShort: (n: number) => `${n} p.`,
  privacyFooter:
    "Outil privé. Le texte que vous écrivez est la seule source : rien n'est récupéré sur Internet, aucune page de manga n'est stockée, rien n'est partagé. Ce que le chapitre ne dit pas n'entrera pas dans le graphe, même si le modèle le sait par ailleurs.",

  // --- Summary form (client) ----------------------------------------------
  labelChapter: 'Chapitre',
  labelTitle: 'Titre',
  labelVolume: 'Tome',
  optionalTag: '(facultatif)',
  summaryLabel: 'Le chapitre, raconté',
  summaryPlaceholder:
    'Collez ici le résumé le plus détaillé que vous ayez du chapitre.\n\n' +
    'Un paragraphe par scène. Les noms tels que le chapitre les donne — ' +
    "et seulement ceux qu'il donne.\n\n" +
    'Chaque fait du graphe devra citer une phrase de ce texte : ' +
    "ce qui n'y est pas écrit n'entrera pas.",
  unitCharacters: 'caractères',
  unitCitablePassages: 'passages citables',
  modelCalls: (n: number) => `appel${n > 1 ? 's' : ''} au modèle`,
  modelCallsTitle: "Une tranche d'extraction par groupe de passages",
  tooShort: (missing: number) =>
    `Encore ${missing} caractères. Un résumé trop court produit un graphe vide : chaque fait doit pouvoir citer une phrase.`,
  tooLong: (max: number) =>
    `Au-delà de ${max} caractères. Coupez le texte, ou importez-le en deux chapitres.`,
  languageLegend: 'Langue de la source',
  languageAuto: 'Détecter',
  // Language names stay in their own language in both locales — « Français »
  // and « English » are each recognisable to their own readers.
  languageFr: 'Français',
  languageEn: 'English',
  mustChooseLanguage: (french: number, english: number) =>
    `Je n'arrive pas à trancher — ${french} marqueurs français contre ${english} anglais, c'est trop serré pour décider à votre place. Choisissez ci-dessus.`,
  languageNote:
    'Le graphe reste en français quelle que soit la réponse. Seuls les extraits cités gardent la langue de la source : une citation est une copie, vérifiée caractère par caractère — la traduire la rendrait invérifiable.',
  parallelSummaryTitle: 'Le même chapitre dans l’autre langue',
  parallelBadgeFallback: 'autre langue',
  parallelIntro: 'Si vous avez les deux versions, collez la seconde ici. Elle',
  parallelIntroStrong: 'n’est pas une source',
  parallelIntroRest:
    ' : rien ne pourra la citer, et un fait qu’elle seule énonce n’entrera pas dans le graphe. Elle sert à lire la correspondance des noms — « Straw Hat Pirates » en regard de « Équipage du Chapeau de Paille » —, ce qu’aucun texte seul ne peut donner. Le modèle cesse alors de deviner la forme française : il la lit.',
  // The two language-specific placeholders name the language of the text to
  // paste in that language itself, so they stay as-is in both locales; only
  // the fallback is translated.
  parallelPlaceholderFr: 'La version française du même chapitre.',
  parallelPlaceholderEn: 'The same chapter, in English.',
  parallelPlaceholderOther: 'La version du chapitre dans l’autre langue.',
  parallelChars: (n: number) =>
    `${n} caractères, fournis au modèle à chaque tranche — pour les noms, jamais comme preuve.`,
  parallelTooShort: (missing: number) =>
    `Encore ${missing} caractères, ou laissez vide : trop court, ce texte ne contient aucune correspondance de noms exploitable.`,
  parallelTooLong: (max: number) => `Au-delà de ${max} caractères.`,
  parallelSameLanguage:
    'Ce texte semble être dans la même langue que le premier. C’est la mise en regard des deux langues qui donne les noms ; deux fois le même résumé ne donne rien et double le coût de chaque tranche.',
  submitPendingRun: 'Import et traitement…',
  submitPendingOnly: 'Enregistrement…',
  submitRun: 'Importer et traiter',
  submitOnly: 'Importer seulement',
  autoRunLabel: 'Lancer le traitement dans la foulée',
  successUnchanged: 'Texte identique au précédent import — rien n’a été réécrit.',
  successReplaced: 'Chapitre remplacé',
  successImported: 'Chapitre importé',
  successPassages: (n: number) => `${n} passage${n > 1 ? 's' : ''}`,
  successEnglishSource: ', source en anglais',
  runNotStarted: 'Le chapitre est enregistré, mais le traitement n’a pas démarré :',
  followRun: 'Suivre le traitement',
  viewChapter: 'Voir le chapitre',
  readyForNext: (n: number) =>
    `Le formulaire est prêt pour le chapitre ${n} — collez la suite sans recharger la page.`,

  // --- Server actions ------------------------------------------------------
  invalidChapterNumber: 'Numéro de chapitre invalide.',
  invalidChapterNumberHint: 'Indiquez un entier positif, par exemple 1.',
  noFile: 'Aucun fichier sélectionné.',
  noFileHint: 'Choisissez un PDF, une archive CBZ, ou les images du chapitre.',
  noText: 'Aucun texte fourni.',
  noTextHint: 'Collez le résumé détaillé du chapitre dans la zone de texte.',
  unknownFailure: "L'import a échoué pour une raison inconnue.",
  unexpectedHint: "Ceci n'est pas une erreur attendue. Consultez les journaux du serveur.",
  reorderFailed: 'Réorganisation impossible.',
}

const en: typeof fr = {
  // --- Page (/import) ------------------------------------------------------
  metaTitle: 'Import a chapter',
  chapterCartouche: 'Chapter',
  heroTitle: 'Import',
  heroLead: (last: number | null) =>
    `The number dates everything this chapter reveals. Editable below; ${
      last === null
        ? 'start with the one you read first.'
        : `the last one imported is ${last}.`
    }`,
  alreadyImported: 'Already imported',
  untitled: 'untitled',
  passagesN: (n: number) => `${n} passage${n === 1 ? '' : 's'}`,
  pagesShort: (n: number) => `${n} p.`,
  privacyFooter:
    'Private tool. The text you write is the only source: nothing is fetched from the Internet, no manga page is stored, nothing is shared. What the chapter does not say will not enter the graph, even if the model knows it from elsewhere.',

  // --- Summary form (client) ----------------------------------------------
  labelChapter: 'Chapter',
  labelTitle: 'Title',
  labelVolume: 'Volume',
  optionalTag: '(optional)',
  summaryLabel: 'The chapter, written out',
  summaryPlaceholder:
    'Paste here the most detailed summary of the chapter you have.\n\n' +
    'One paragraph per scene. Names as the chapter gives them — ' +
    'and only the ones it gives.\n\n' +
    'Every fact in the graph will have to quote a sentence of this text: ' +
    'what is not written here will not enter.',
  unitCharacters: 'characters',
  unitCitablePassages: 'citable passages',
  modelCalls: (n: number) => `call${n === 1 ? '' : 's'} to the model`,
  modelCallsTitle: 'One extraction slice per group of passages',
  tooShort: (missing: number) =>
    `${missing} more characters to go. A summary that is too short produces an empty graph: every fact must be able to quote a sentence.`,
  tooLong: (max: number) =>
    `Over ${max} characters. Trim the text, or import it as two chapters.`,
  languageLegend: 'Source language',
  languageAuto: 'Detect',
  // Kept in their own language in both locales — good bilingual practice.
  languageFr: 'Français',
  languageEn: 'English',
  mustChooseLanguage: (french: number, english: number) =>
    `I cannot settle it — ${french} French markers against ${english} English, too close to decide for you. Choose above.`,
  languageNote:
    'The graph stays in French whatever the answer. Only quoted excerpts keep the language of the source: a quote is a copy, verified character for character — translating it would make it unverifiable.',
  parallelSummaryTitle: 'The same chapter in the other language',
  parallelBadgeFallback: 'other language',
  parallelIntro: 'If you have both versions, paste the second one here. It',
  parallelIntroStrong: 'is not a source',
  parallelIntroRest:
    ': nothing will be able to quote it, and a fact it alone states will not enter the graph. It is there for reading name correspondences off — “Straw Hat Pirates” next to “Équipage du Chapeau de Paille” — which no single text can give. The model then stops guessing the French form of a name: it reads it.',
  // Language-matched on purpose, in both locales: each names the language of
  // the text to paste, in that language.
  parallelPlaceholderFr: 'La version française du même chapitre.',
  parallelPlaceholderEn: 'The same chapter, in English.',
  parallelPlaceholderOther: 'The chapter’s version in the other language.',
  parallelChars: (n: number) =>
    `${n} characters, given to the model with every slice — for names, never as evidence.`,
  parallelTooShort: (missing: number) =>
    `${missing} more characters, or leave it empty: too short, this text holds no usable name correspondence.`,
  parallelTooLong: (max: number) => `Over ${max} characters.`,
  parallelSameLanguage:
    'This text looks like it is in the same language as the first. Setting the two languages side by side is what gives the names; the same summary twice gives nothing and doubles the cost of every slice.',
  submitPendingRun: 'Importing and processing…',
  submitPendingOnly: 'Saving…',
  submitRun: 'Import and process',
  submitOnly: 'Import only',
  autoRunLabel: 'Start processing right away',
  successUnchanged: 'Text identical to the previous import — nothing was rewritten.',
  successReplaced: 'Chapter replaced',
  successImported: 'Chapter imported',
  successPassages: (n: number) => `${n} passage${n === 1 ? '' : 's'}`,
  successEnglishSource: ', English source',
  runNotStarted: 'The chapter is saved, but processing did not start:',
  followRun: 'Follow the run',
  viewChapter: 'View the chapter',
  readyForNext: (n: number) =>
    `The form is ready for chapter ${n} — paste the next one without reloading the page.`,

  // --- Server actions ------------------------------------------------------
  invalidChapterNumber: 'Invalid chapter number.',
  invalidChapterNumberHint: 'Enter a positive integer, for example 1.',
  noFile: 'No file selected.',
  noFileHint: 'Choose a PDF, a CBZ archive, or the chapter images.',
  noText: 'No text provided.',
  noTextHint: 'Paste the detailed chapter summary into the text area.',
  unknownFailure: 'The import failed for an unknown reason.',
  unexpectedHint: 'This is not an expected error. Check the server logs.',
  reorderFailed: 'Could not reorder.',
}

export const importer = { fr, en } satisfies Record<Locale, typeof fr>
