import type { Locale } from '../index.ts'

/**
 * The frame: navigation rail, global search, boundary slider, footer, and the
 * root layout's metadata. French defines the shape; `typeof fr` makes English
 * cover every key or fail to compile.
 */
const fr = {
  metadataDescription:
    'Bibliothèque personnelle : importez vos chapitres, explorez le graphe de connaissances sans spoiler.',
  skipToContent: 'Aller au contenu principal',
  navLabel: 'Navigation principale',
  explorer: 'Explorer',
  atelier: 'Atelier',
  navGraph: 'Graphe',
  navTimeline: 'Chronologie',
  navMysteries: 'Mystères',
  navSearch: 'Recherche',
  navChapters: 'Chapitres',
  navImport: 'Importer',
  navAsk: 'Demander',
  navSettings: 'Réglages',
  signIn: 'Se connecter',
  footerNote:
    'Bibliothèque privée · pages derrière authentification · direction artistique originale, aucun asset officiel · ',
  footerStatusLink: 'état du déploiement',
  searchLabel: 'Chercher une entité, un lieu, une phrase',
  searchPlaceholder: 'Chercher un personnage, un lieu, une phrase…    /',
  searchSubmit: 'Chercher',
  languageLabel: 'Langue',
  boundaryLabel: 'Jusqu’au chapitre',
  boundaryInputLabel: 'Numéro de chapitre',
  boundaryValue: (chapter: number, max: number) =>
    `chapitre ${chapter} sur ${max}`,
  boundaryRecomputing: 'recalcul…',
  boundaryFullView: (max: number) =>
    `Vue complète : tout ce que vous avez importé jusqu’au chapitre ${max}. ` +
    'Reculez le curseur pour retrouver un état antérieur de vos connaissances.',
  boundaryRewoundLead: 'Vous consultez l’état de vos connaissances',
  boundaryRewoundStrong: (chapter: number) => `à la fin du chapitre ${chapter}`,
  boundaryRewoundTail:
    '. Tout ce qui est révélé après est masqué — y compris rétroactivement.',
}

const en: typeof fr = {
  metadataDescription:
    'A personal library: import your chapters, explore the knowledge graph spoiler-free.',
  skipToContent: 'Skip to main content',
  navLabel: 'Main navigation',
  explorer: 'Explore',
  atelier: 'Workshop',
  navGraph: 'Graph',
  navTimeline: 'Timeline',
  navMysteries: 'Mysteries',
  navSearch: 'Search',
  navChapters: 'Chapters',
  navImport: 'Import',
  navAsk: 'Ask',
  navSettings: 'Settings',
  signIn: 'Sign in',
  footerNote:
    'Private library · pages behind authentication · original art direction, no official assets · ',
  footerStatusLink: 'deployment status',
  searchLabel: 'Search an entity, a place, a sentence',
  searchPlaceholder: 'Search a character, a place, a sentence…    /',
  searchSubmit: 'Search',
  languageLabel: 'Language',
  boundaryLabel: 'Up to chapter',
  boundaryInputLabel: 'Chapter number',
  boundaryValue: (chapter: number, max: number) =>
    `chapter ${chapter} of ${max}`,
  boundaryRecomputing: 'recomputing…',
  boundaryFullView: (max: number) =>
    `Full view: everything you have imported up to chapter ${max}. ` +
    'Move the slider back to return to an earlier state of your knowledge.',
  boundaryRewoundLead: 'You are viewing your knowledge as it stood',
  boundaryRewoundStrong: (chapter: number) => `at the end of chapter ${chapter}`,
  boundaryRewoundTail:
    '. Everything revealed after that is hidden — including retroactively.',
}

export const shell = { fr, en } satisfies Record<Locale, typeof fr>
