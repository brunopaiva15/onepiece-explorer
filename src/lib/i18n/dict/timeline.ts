import type { Locale } from '../index.ts'

/**
 * Strings for the timeline (/chronologie), the narrative delta (/delta) and
 * the temporal domain's composed fallbacks. Stored story-time descriptions
 * were authored with the graph — canonical French — and are shown as stored;
 * only text composed at read time follows the reader.
 */
const fr = {
  yearsEarlier: (years: string) => `environ ${years} ans plus tôt`,
  relativeOrderKnown: 'ordre relatif connu',
  unknownMoment: 'moment inconnu',

  // /chronologie page.
  metaTitle: 'Chronologie',
  pageTitle: 'Chronologie',
  // The two-axis explainer, split around the two <strong> words.
  explainerLead: "Deux axes, jamais confondus. L'ordre de",
  explainerRevelation: 'révélation',
  explainerMid: "est celui où vous avez appris les choses ; l'ordre de",
  explainerStory: "l'histoire",
  explainerTail:
    "est celui où elles se sont produites. Un flashback est loin sur l'un et récent sur l'autre.",
  axisNavLabel: 'Axe de la chronologie',
  axisRevelation: 'Ordre de révélation',
  axisStory: "Ordre de l'histoire",
  emptyStoryAxis:
    "Aucun événement n'a de position connue dans le temps de l'histoire à ce chapitre.",
  emptyRevelationAxis: (boundary: number) =>
    `Rien de connu au chapitre ${boundary}.`,
  undatedHeading: (n: number) => `Sans position connue (${n})`,
  undatedExplainer:
    "Ces événements sont connus mais les pages ne disent pas quand ils " +
    "se produisent. Les placer sur l'axe demanderait d'inventer une précision " +
    "que l'œuvre ne donne pas.",
  knownFromChapter: (n: number) => `connu au ch. ${n}`,
  mysteryBadge: (resolved: boolean) => `mystère${resolved ? ' — résolu' : ''}`,
  flashbackBadge: 'flashback',
  flashbackTitle: "Montré ici, survenu plus tôt dans l'histoire",
  chapterShort: (n: number) => `ch. ${n}`,
  approximateNote: "Position approximative : c'est tout ce que les pages donnent.",
  resolvedAtChapter: (n: number) => `Résolu au chapitre ${n}.`,

  // /delta/[chapitre] page.
  deltaMetaTitle: 'Delta narratif',
  deltaChaptersCrumb: 'Chapitres',
  deltaTitle: (n: number) => `Ce qu'apporte le chapitre ${n}`,
  deltaEmpty:
    "Rien n'a encore été publié pour ce chapitre. Lancez le traitement, " +
    'puis revoyez les propositions.',
  deltaRefutedHeading: 'Ce que ce chapitre dément',
  deltaRefutedExplainer:
    'Ces croyances restent visibles dans les chapitres où vous les teniez ' +
    'pour vraies. Elles ne sont pas effacées — seulement fermées ici.',
  deltaHeldSince: (n: number) => `— cru depuis le chapitre ${n}`,
  deltaNamesHeading: 'Noms révélés',
  deltaPreviousName: (previous: string) => `— jusqu'ici « ${previous} »`,
  deltaNewEntitiesHeading: (n: number) => `Nouvelles entités (${n})`,
  deltaNewFactsHeading: (n: number) => `Nouveaux faits (${n})`,
  deltaViewGraph: 'Voir le graphe à ce chapitre',
  deltaPreviousChapter: 'Chapitre précédent',
}

const en: typeof fr = {
  yearsEarlier: (years: string) => `about ${years} years earlier`,
  relativeOrderKnown: 'relative order known',
  unknownMoment: 'unknown moment',

  metaTitle: 'Timeline',
  pageTitle: 'Timeline',
  explainerLead: 'Two axes, never conflated. The order of',
  explainerRevelation: 'revelation',
  explainerMid: 'is the order in which you learned things; the order of the',
  explainerStory: 'story',
  explainerTail:
    'is the order in which they happened. A flashback is far away on one and recent on the other.',
  axisNavLabel: 'Timeline axis',
  axisRevelation: 'Order of revelation',
  axisStory: 'Order of the story',
  emptyStoryAxis:
    'No event has a known position in story time at this chapter.',
  emptyRevelationAxis: (boundary: number) =>
    `Nothing known at chapter ${boundary}.`,
  undatedHeading: (n: number) => `Without a known position (${n})`,
  undatedExplainer:
    'These events are known, but the pages do not say when they happen. ' +
    'Placing them on the axis would mean inventing a precision the work ' +
    'does not give.',
  knownFromChapter: (n: number) => `known from ch. ${n}`,
  mysteryBadge: (resolved: boolean) => `mystery${resolved ? ' — resolved' : ''}`,
  flashbackBadge: 'flashback',
  flashbackTitle: 'Shown here, but happened earlier in the story',
  chapterShort: (n: number) => `ch. ${n}`,
  approximateNote: 'Approximate position: that is all the pages give.',
  resolvedAtChapter: (n: number) => `Resolved in chapter ${n}.`,

  deltaMetaTitle: 'Narrative delta',
  deltaChaptersCrumb: 'Chapters',
  deltaTitle: (n: number) => `What chapter ${n} adds`,
  deltaEmpty:
    'Nothing has been published for this chapter yet. Run processing, ' +
    'then review the proposals.',
  deltaRefutedHeading: 'What this chapter refutes',
  deltaRefutedExplainer:
    'These beliefs stay visible in the chapters where you held them to be ' +
    'true. They are not erased — only closed here.',
  deltaHeldSince: (n: number) => `— believed since chapter ${n}`,
  deltaNamesHeading: 'Names revealed',
  deltaPreviousName: (previous: string) => `— until now “${previous}”`,
  deltaNewEntitiesHeading: (n: number) => `New entities (${n})`,
  deltaNewFactsHeading: (n: number) => `New facts (${n})`,
  deltaViewGraph: 'See the graph at this chapter',
  deltaPreviousChapter: 'Previous chapter',
}

export const timeline = { fr, en } satisfies Record<Locale, typeof fr>
