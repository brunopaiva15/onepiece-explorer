import type { Locale } from '../index.ts'

/**
 * The assistant: refusal messages composed by the domain (answer.ts) and the
 * /ask page around them. Refusals are part of the product — they are what the
 * reader sees instead of an unsourced guess — so they follow the reader's
 * language like any other interface text.
 */
const fr = {
  askSomething: 'Posez une question.',
  disabled:
    "L'assistant conversationnel est désactivé. Chaque question appelle un " +
    'modèle et se facture à la question, indéfiniment — ce n’est pas ce que cet ' +
    'outil est. Pour l’activer malgré tout : ASSISTANT_ENABLED=1. La recherche ' +
    'plein texte, approchante et par graphe, elle, ne coûte rien et cherche dans ' +
    'les mêmes données.',
  rateLimited: (used: number, minutes: number, explain: string) =>
    `Limite atteinte : ${used} questions dans l'heure. ` +
    `Réessayez dans ${minutes} minute(s). ${explain}`,
  nothingPublished:
    "Aucun chapitre n'est encore publié : il n'y a rien à interroger.",
  nothingRelevant: (boundary: number) =>
    `Rien dans les chapitres 1 à ${boundary} ne se rapporte à cette question. ` +
    'Élargissez la question, remontez le curseur, ou importez le chapitre concerné.',
  unsupportedAnswer:
    'Aucune des sources citées ne correspond à ce que vos chapitres contiennent. ' +
    'La réponse a été écartée plutôt que présentée : une affirmation sans source ' +
    'vérifiable ressemble exactement à une affirmation vraie.',
  droppedUnknownId:
    "Cet identifiant ne figure pas dans le contexte fourni au modèle. " +
    "C'est le signe d'une source inventée.",
  droppedBeyondBoundary: (chapter: number, boundary: number) =>
    `Assertion du chapitre ${chapter}, au-delà de la frontière ${boundary}.`,

  // /ask page.
  metaTitle: 'Question',
  pageTitle: 'Poser une question',
  intro:
    'La réponse est construite à partir des seules assertions validées de vos ' +
    'chapitres lus, et chaque affirmation est reliée à la case qui la prouve. ' +
    "Si la réponse ne s'y trouve pas, elle vous le dira.",
  // The assistant-disabled notice, split around its links and <code> blocks.
  disabledNoticeStrong: "L'assistant conversationnel est désactivé.",
  disabledNoticeBody:
    'Il se facture à la question, indéfiniment, et cet outil est un ' +
    'explorateur de graphe — pas un moteur de réponses payant.',
  disabledAltLead: 'La',
  disabledAltSearchLink: 'recherche',
  disabledAltMid:
    'cherche dans exactement les mêmes données, gratuitement, et vous ' +
    'montre les extraits sans les reformuler. Le',
  disabledAltPathLink: 'chemin entre deux entités',
  disabledAltTail: 'y répond même à des questions que celui-ci ne sait pas traiter.',
  disabledEnableLead: "Pour l'activer malgré tout :",
  disabledEnableIn: 'dans',
  noKeyStrong: 'Aucune clé Anthropic configurée.',
  noKeyBody:
    'Le mode sans modèle retrouve les assertions correspondantes et vous les ' +
    'montre telles quelles, sans les reformuler — il ne compose pas de ' +
    "phrases qu'il ne pourrait pas soutenir.",
  questionPlaceholder: 'Qui a promis quoi à qui ?',
  questionAriaLabel: 'Votre question',
  submit: 'Demander',
  insufficientData: 'Données insuffisantes',
  sourcesHeading: (n: number) => `Sources (${n})`,
  citationChapter: (n: number) => `chapitre ${n}`,
  droppedHeading: (n: number) => `${n} source(s) écartée(s)`,
  entitiesConsulted: 'Entités consultées :',
  entitySheetLink: 'fiche',
  answerCost: (amount: string) => `coût de cette réponse : ${amount} $`,
}

const en: typeof fr = {
  askSomething: 'Ask a question.',
  disabled:
    'The conversational assistant is disabled. Every question calls a model ' +
    'and is billed per question, indefinitely — that is not what this tool is. ' +
    'To enable it anyway: ASSISTANT_ENABLED=1. Full-text, fuzzy and graph ' +
    'search cost nothing and search the same data.',
  rateLimited: (used: number, minutes: number) =>
    `Limit reached: ${used} questions this hour. ` +
    `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  nothingPublished: 'No chapter is published yet: there is nothing to ask about.',
  nothingRelevant: (boundary: number) =>
    `Nothing in chapters 1 to ${boundary} relates to this question. ` +
    'Broaden the question, move the slider up, or import the relevant chapter.',
  unsupportedAnswer:
    'None of the cited sources match what your chapters contain. The answer ' +
    'was discarded rather than shown: an unverifiable claim looks exactly ' +
    'like a true one.',
  droppedUnknownId:
    'This identifier is not in the context given to the model. ' +
    'That is the signature of an invented source.',
  droppedBeyondBoundary: (chapter: number, boundary: number) =>
    `Assertion from chapter ${chapter}, beyond the boundary of ${boundary}.`,

  metaTitle: 'Question',
  pageTitle: 'Ask a question',
  intro:
    'The answer is built from the validated assertions of your read chapters ' +
    'alone, and every claim is linked to the panel that proves it. If the ' +
    'answer is not there, it will say so.',
  disabledNoticeStrong: 'The conversational assistant is disabled.',
  disabledNoticeBody:
    'It is billed per question, indefinitely, and this tool is a graph ' +
    'explorer — not a paid answer engine.',
  disabledAltLead: 'The',
  disabledAltSearchLink: 'search',
  disabledAltMid:
    'looks through exactly the same data, for free, and shows you the ' +
    'excerpts without rephrasing them. The',
  disabledAltPathLink: 'path between two entities',
  disabledAltTail: 'even answers questions this one cannot handle.',
  disabledEnableLead: 'To enable it anyway:',
  disabledEnableIn: 'in',
  noKeyStrong: 'No Anthropic key configured.',
  noKeyBody:
    'The model-less mode retrieves the matching assertions and shows them ' +
    'to you as they are, without rephrasing — it does not compose sentences ' +
    'it could not stand behind.',
  questionPlaceholder: 'Who promised what to whom?',
  questionAriaLabel: 'Your question',
  submit: 'Ask',
  insufficientData: 'Insufficient data',
  sourcesHeading: (n: number) => `Sources (${n})`,
  citationChapter: (n: number) => `chapter ${n}`,
  droppedHeading: (n: number) =>
    `${n} source${n === 1 ? '' : 's'} discarded`,
  entitiesConsulted: 'Entities consulted:',
  entitySheetLink: 'card',
  answerCost: (amount: string) => `cost of this answer: $${amount}`,
}

export const ask = { fr, en } satisfies Record<Locale, typeof fr>
