import type { Locale } from '../index.ts'

/**
 * Search: the /recherche page and the reasons the search domain attaches to
 * every hit. A reason is display text computed at read time, so it follows the
 * reader's language — unlike the content it describes, which stays in the
 * language it was authored or transcribed in.
 */
const fr = {
  // Why a hit is in the list (lexical mode, one per source of text).
  reasonNameMatch: 'Le nom correspond aux mots cherchés.',
  reasonTextMatch: 'Le texte de la page contient ces mots.',
  reasonEventMatch: "Le résumé de l'événement correspond.",
  reasonMysteryMatch: 'La question du mystère correspond.',
  reasonPanelMatch: 'La description de la case correspond.',
  // Fuzzy mode.
  reasonFuzzyClose: 'Nom très proche de ce que vous avez tapé.',
  reasonFuzzyApprox: 'Nom approchant — orthographe ou transcription différente.',
  // Semantic mode.
  reasonSemanticClose: 'Sens proche de votre question.',
  // Graph mode.
  reasonNeighbour: (label: string) => `En relation directe avec « ${label} ».`,
  fallbackPredicate: 'lié à',
  fallbackEntity: 'une entité',
  // Fusion decoration.
  alsoFoundBy: (others: number) =>
    `(trouvé aussi par ${others} autre${others > 1 ? 's' : ''} méthode${others > 1 ? 's' : ''})`,
  // Mode notes.
  noteQueryTooShort: 'Requête trop courte pour une comparaison approchante.',
  noteNothingToExpand:
    'Aucune entité trouvée par les autres modes : rien à étendre.',
  noteNoVector: "Le fournisseur n'a pas produit de vecteur pour cette requête.",
  noteSemanticDown: (message: string) =>
    `Recherche sémantique indisponible : ${message}`,
  panelTitle: (n: number) => `case ${n}`,

  // /recherche page.
  metaTitle: 'Recherche',
  pageTitle: 'Recherche',
  queryPlaceholder: 'un nom, une phrase, un lieu…',
  queryAriaLabel: 'Rechercher',
  submit: 'Chercher',
  scopeNote:
    'Cherche dans les noms, le texte des pages, les descriptions de cases, ' +
    'les événements et les mystères — le tout limité à ce que vous avez lu. ' +
    'Les accents et les fautes de frappe sont tolérés.',
  modesAriaLabel: 'Méthodes utilisées',
  modeUnavailable: ' — indisponible',
  // Display names of the search modes (mode identifiers stay as-is).
  modeLabels: {
    lexical: 'plein texte',
    fuzzy: 'orthographe approchante',
    graph: 'voisinage dans le graphe',
    semantic: 'sens',
  } as Record<string, string>,
  // Display names of the hit kinds (SearchHit.kind values).
  kindLabels: {
    entity: 'entité',
    text_block: 'texte de page',
    event: 'événement',
    mystery: 'mystère',
    panel: 'case',
  } as Record<string, string>,
  noHits: (query: string, boundary: number) =>
    `Rien pour « ${query} » dans les chapitres 1 à ${boundary}.`,
  noHitsRewound:
    ' Le curseur est en arrière : remontez-le pour chercher dans tout ce que vous avez importé.',
  untitled: '(sans titre)',
  hitChapter: (n: number) => `ch. ${n}`,
  pathHeading: 'Chemin entre deux entités',
  pathExplainer:
    'La chaîne de relations la plus courte, telle que vous la connaissez à ' +
    "ce chapitre. C'est là qu'apparaissent les liens auxquels on " +
    "n'avait pas pensé — et reculer le curseur montre à partir de quand " +
    'le lien existait.',
  pathFromPlaceholder: 'identifiant de départ',
  pathFromAriaLabel: 'Entité de départ',
  pathToPlaceholder: "identifiant d'arrivée",
  pathToAriaLabel: "Entité d'arrivée",
  pathSubmit: 'Tracer',
  pathNone: (boundary: number) =>
    `Aucun chemin connu entre ces deux entités au chapitre ${boundary}. ` +
    "Ce n'est pas une erreur : à ce stade, rien de ce que vous avez lu ne les relie.",
  pathSameEntity: 'Ce sont la même entité — fusionnées par une identité révélée.',
  pathKnownAt: (n: number) => `su ch. ${n}`,
}

const en: typeof fr = {
  reasonNameMatch: 'The name matches the words you searched.',
  reasonTextMatch: 'The page text contains these words.',
  reasonEventMatch: 'The event summary matches.',
  reasonMysteryMatch: 'The mystery question matches.',
  reasonPanelMatch: 'The panel description matches.',
  reasonFuzzyClose: 'Name very close to what you typed.',
  reasonFuzzyApprox: 'Approximate name — different spelling or transliteration.',
  reasonSemanticClose: 'Meaning close to your question.',
  reasonNeighbour: (label: string) => `Directly related to “${label}”.`,
  fallbackPredicate: 'linked to',
  fallbackEntity: 'an entity',
  alsoFoundBy: (others: number) =>
    `(also found by ${others} other method${others > 1 ? 's' : ''})`,
  noteQueryTooShort: 'Query too short for fuzzy comparison.',
  noteNothingToExpand: 'No entity found by the other modes: nothing to expand.',
  noteNoVector: 'The provider produced no vector for this query.',
  noteSemanticDown: (message: string) =>
    `Semantic search unavailable: ${message}`,
  panelTitle: (n: number) => `panel ${n}`,

  metaTitle: 'Search',
  pageTitle: 'Search',
  queryPlaceholder: 'a name, a sentence, a place…',
  queryAriaLabel: 'Search',
  submit: 'Search',
  scopeNote:
    'Searches names, page text, panel descriptions, events and mysteries — ' +
    'all of it limited to what you have read. Accents and typos are tolerated.',
  modesAriaLabel: 'Methods used',
  modeUnavailable: ' — unavailable',
  modeLabels: {
    lexical: 'full text',
    fuzzy: 'approximate spelling',
    graph: 'graph neighbourhood',
    semantic: 'meaning',
  } as Record<string, string>,
  kindLabels: {
    entity: 'entity',
    text_block: 'page text',
    event: 'event',
    mystery: 'mystery',
    panel: 'panel',
  } as Record<string, string>,
  noHits: (query: string, boundary: number) =>
    `Nothing for “${query}” in chapters 1 to ${boundary}.`,
  noHitsRewound:
    ' The slider is rewound: move it back up to search everything you have imported.',
  untitled: '(untitled)',
  hitChapter: (n: number) => `ch. ${n}`,
  pathHeading: 'Path between two entities',
  pathExplainer:
    'The shortest chain of relations, as you know it at this chapter. ' +
    'This is where the connections you had not thought of show up — and ' +
    'moving the slider back shows from when the link existed.',
  pathFromPlaceholder: 'starting identifier',
  pathFromAriaLabel: 'Starting entity',
  pathToPlaceholder: 'destination identifier',
  pathToAriaLabel: 'Destination entity',
  pathSubmit: 'Trace',
  pathNone: (boundary: number) =>
    `No known path between these two entities at chapter ${boundary}. ` +
    'This is not an error: at this point, nothing you have read connects them.',
  pathSameEntity: 'They are the same entity — merged by a revealed identity.',
  pathKnownAt: (n: number) => `learned ch. ${n}`,
}

export const search = { fr, en } satisfies Record<Locale, typeof fr>
