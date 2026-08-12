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
}

export const search = { fr, en } satisfies Record<Locale, typeof fr>
