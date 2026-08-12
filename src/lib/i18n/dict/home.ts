import type { Locale } from '../index.ts'

/**
 * The home page — the command deck: task cards, the library in four numbers,
 * the latest chapters, and the visitor's ways in. French defines the shape;
 * `typeof fr` makes English cover every key.
 */
const fr = {
  commandDeck: 'Poste de commandement',
  awaitingYou: 'Ça vous attend',

  taskReview: {
    title: 'à relire',
    action: (n: number) => `Ouvrir le ${n}`,
    detail:
      "Le traitement a produit des propositions. Rien n'entre dans le graphe avant votre décision.",
  },
  taskFailed: {
    title: 'en échec',
    action: 'Voir la raison',
    detail:
      "Le traitement s'est arrêté. Les étapes réussies sont conservées : relancer reprend où ça s'est arrêté.",
  },
  taskRunning: {
    title: 'en cours',
    action: 'Suivre',
    detail:
      'Le traitement est en cours. La progression montre chaque étape, sa durée et son coût réel.',
  },
  taskProcess: {
    title: 'à traiter',
    action: 'Lancer',
    detail: 'Importés, pas encore analysés. Le coût est estimé avant lancement, pas après.',
  },

  nothingPending: 'Rien en attente',
  emptyLibrary: 'La bibliothèque est vide. Importez le premier chapitre que vous avez lu.',
  allDone: 'Tout est traité, relu et publié. Le chapitre suivant vous attend.',
  importChapter: 'Importer un chapitre',

  libraryHeading: 'La bibliothèque',
  statChapters: 'Chapitres',
  statPublished: 'Publiés',
  statPassages: 'Passages',
  statLatest: 'Dernier',

  latestChapters: 'Derniers chapitres',
  allChapters: 'Tous →',
  passagesCount: (n: number) => `${n} passages`,
  pagesShort: (n: number) => `${n} p.`,

  visitorGraph: {
    title: 'Le graphe',
    detail: 'Tout le réseau : personnages, équipages, îles, fruits, promesses.',
  },
  visitorTimeline: {
    title: 'La chronologie',
    detail: "Dates exactes, ordres relatifs, flashbacks, et l'incertitude assumée.",
  },
  visitorMysteries: {
    title: 'Les mystères',
    detail: 'Ce qui est ouvert, ce qui a été résolu, et au bout de combien de chapitres.',
  },
}

const en: typeof fr = {
  commandDeck: 'Command deck',
  awaitingYou: 'Waiting for you',

  taskReview: {
    title: 'to review',
    action: (n: number) => `Open chapter ${n}`,
    detail:
      'Processing produced proposals. Nothing enters the graph before your decision.',
  },
  taskFailed: {
    title: 'failed',
    action: 'See why',
    detail:
      'Processing stopped. The steps that succeeded are kept: relaunching resumes where it left off.',
  },
  taskRunning: {
    title: 'processing',
    action: 'Follow',
    detail:
      'Processing is under way. The progress view shows each step, its duration and its actual cost.',
  },
  taskProcess: {
    title: 'to process',
    action: 'Start',
    detail: 'Imported, not yet analyzed. The cost is estimated before launching, not after.',
  },

  nothingPending: 'Nothing waiting',
  emptyLibrary: 'The library is empty. Import the first chapter you have read.',
  allDone: 'Everything is processed, reviewed and published. The next chapter awaits you.',
  importChapter: 'Import a chapter',

  libraryHeading: 'The library',
  statChapters: 'Chapters',
  statPublished: 'Published',
  statPassages: 'Passages',
  statLatest: 'Latest',

  latestChapters: 'Latest chapters',
  allChapters: 'All →',
  passagesCount: (n: number) => `${n} passage${n === 1 ? '' : 's'}`,
  pagesShort: (n: number) => `${n} p.`,

  visitorGraph: {
    title: 'The graph',
    detail: 'The whole network: characters, crews, islands, fruits, promises.',
  },
  visitorTimeline: {
    title: 'The timeline',
    detail: 'Exact dates, relative orders, flashbacks, and openly acknowledged uncertainty.',
  },
  visitorMysteries: {
    title: 'The mysteries',
    detail: 'What is open, what has been resolved, and after how many chapters.',
  },
}

export const home = { fr, en } satisfies Record<Locale, typeof fr>
