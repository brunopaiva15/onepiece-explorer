import type { Locale } from '../index.ts'

/** Strings for the review area. French defines the shape; typeof fr makes English cover every key. */
const fr = {
  // --- Page (review/[runId]/page.tsx) --------------------------------------
  metaTitle: 'Centre de revue',
  backToRun: '‹ Traitement',
  heading: (n: number) => `Revue · chapitre ${n}`,
  explicitReviewCount: (n: number) => `${n} en revue explicite`,

  quarantineTitle: 'Quarantaine',
  quarantineCount: (n: number) => `${n} écartée(s) · pourquoi ?`,
  quarantineBody1:
    "Ces propositions n'ont pas pu être rattachées à une preuve vérifiable : " +
    'référence inexistante, ou extrait absent du texte cité. Elles ne sont ',
  quarantineNot: 'pas',
  quarantineBody2:
    " proposables — c'est le garde-fou qui empêche une affirmation venue " +
    "d'ailleurs que des pages d'atteindre le graphe. Leur répartition est en " +
    'revanche un bon diagnostic.',
  quarantineReasons: {
    unknown_ref:
      'référence de case ou de bloc inexistante — souvent le signe que le découpage a mal tourné',
    excerpt_not_in_source:
      "extrait absent du bloc cité — souvent le signe d'une transcription trop dégradée pour ancrer quoi que ce soit",
    visual_without_description:
      'preuve visuelle sur une case sans description produite',
    unknown_predicate: 'prédicat hors ontologie',
    unknown_node_type: 'type de nœud hors ontologie',
    unknown_subject: 'sujet introuvable — son entité a été écartée',
    unknown_object: 'objet introuvable',
    empty_excerpt: 'preuve sans extrait',
  } as Record<string, string>,

  // --- Server action (actions.ts) ------------------------------------------
  noDecisions: 'Aucune décision à publier.',
  publishFailed: 'Publication impossible.',

  // --- Board: empty queue ---------------------------------------------------
  emptyTitle: 'File vide',
  emptyBody: 'Rien à revoir pour ce traitement.',
  alreadyPublished: (n: number) => `${n} proposition(s) déjà publiée(s).`,
  backToChapter: 'Revenir au chapitre',

  // --- Board: sticky header -------------------------------------------------
  doubleAcceptedTitle:
    'Deux copies d’une même proposition acceptées : le graphe recevra deux nœuds, que rien ne rapprochera ensuite.',
  doubleAccepted: (n: number) =>
    `${n} doublon${n > 1 ? 's' : ''} accepté${n > 1 ? 's' : ''}`,
  bulkAcceptTitle:
    'Uniquement les propositions sûres : ni identité, ni révélation, ni contradiction',
  bulkAccept: (n: number) => `Accepter ${n} sûres`,
  publishing: 'Publication…',
  publish: (n: number) => `Publier ${n || ''}`,
  stripItemDuplicate: (position: number, rank: number, total: number) =>
    `Proposition ${position}, copie ${rank} sur ${total}`,
  stripItem: (position: number) => `Proposition ${position}`,
  stripDuplicateTitle: (rank: number, total: number) =>
    `Doublon · copie ${rank}/${total}`,

  // --- Publish summary ------------------------------------------------------
  summaryCreated: (n: number) => `${n} élément(s) ajouté(s) au graphe.`,
  summaryEntities: (n: number) => `${n} entité(s)`,
  summaryAssertions: (n: number) => `${n} relation(s)`,
  summaryEvents: (n: number) => `${n} événement(s)`,
  summaryMysteries: (n: number) => `${n} mystère(s)`,
  rejectedCount: (n: number) => `${n} rejetée(s)`,
  deferredCount: (n: number) => `${n} reportée(s)`,
  failuresIntro: (n: number) => `${n} n'ont pas pu être appliquée(s) :`,

  // --- Proposal card --------------------------------------------------------
  evidenceTitle: 'La preuve',
  evidenceCount: (n: number) => `${n} élément${n > 1 ? 's' : ''}`,
  noEvidence:
    'Aucune preuve rattachée — cette proposition ne devrait pas être ici.',
  confidence: (pct: number) => `confiance ${pct} %`,
  explicitReviewTitle:
    'Identité, révélation, mort, affiliation cachée ou contradiction : jamais acceptable en lot',
  explicitReviewRequired: 'Revue explicite obligatoire',
  accept: 'Accepter',
  reject: 'Rejeter',
  defer: 'Reporter',
  nothingWritten:
    "Rien n'est écrit avant « Publier ». Une décision déplace automatiquement à la suivante.",

  // --- Duplicate notice -----------------------------------------------------
  duplicateTitle: (rank: number, total: number) =>
    `Doublon · copie ${rank} sur ${total}`,
  duplicatePublished: (n: number) =>
    `${n} copie${n > 1 ? 's' : ''} déjà acceptée${n > 1 ? 's' : ''} et publiée${
      n > 1 ? 's' : ''
    } : accepter celle-ci ajouterait un second nœud au graphe, que rien ne rapprochera ensuite.`,
  duplicateMarked: 'Une autre copie est déjà marquée « accepter ». Une seule suffit.',
  duplicateDefault:
    'Le chapitre est extrait par tranches, et la même proposition revient ' +
    'd’une tranche à l’autre. N’en acceptez qu’une — sauf si vous jugez ' +
    'qu’il s’agit de deux apparitions différentes.',
  duplicatePrevious: ' lors d’une publication précédente.',
  twinButton: (position: number, state: string) => `n°${position} · ${state}`,
  twinState: {
    accept: '✓ acceptée',
    reject: '✕ rejetée',
    defer: '⏸ reportée',
  } as Record<string, string>,
  twinUndecided: 'pas encore décidée',

  // --- Evidence panel -------------------------------------------------------
  pageRef: (ref: string, page: number) => `${ref} · page ${page}`,
  passageRef: (n: string) => `passage ${n}`,
  evidenceText: 'texte',
  evidenceVisual: 'visuel',
  panelAlt: (ref: string) => `Case source ${ref}`,
  fullPassage: 'Passage complet :',
  fullBlock: 'Bloc complet :',

  // --- Proposal body --------------------------------------------------------
  inSource: 'Dans la source',
  nameQuestion: 'Comment on l’appelle en français',
  nameInGraph: 'Nom dans le graphe',
  namingNote:
    'Le modèle ne sait pas trancher — traduire ou garder tel quel est une ' +
    'convention, pas un fait du texte. Votre réponse est enregistrée pour ' +
    'toute l’œuvre : la question ne sera plus posée.',
  resolutionQuestion: (label: string) =>
    `« ${label} » est-il la même entité que`,
  resolutionQuestionEnd: ' ?',
  resolutionScore: (pct: number) => `Score ${pct} %`,
  modelOpinion: (verdict: string) => `Avis du modèle (${verdict}) :`,
  conflictIntro: "Trois lectures possibles, et le système n'en choisit aucune :",
  flashback: 'Présenté comme un souvenir : montré ici, survenu plus tôt.',
  category: {
    entity: 'entité',
    assertion: 'relation',
    resolution: 'rapprochement',
    conflict: 'contradiction',
    event: 'événement',
    mystery: 'mystère',
  } as Record<string, string>,
  suggestion: {
    likely_same: 'probablement la même',
    worth_checking: 'à vérifier',
    likely_different: 'probablement différentes',
  } as Record<string, string>,
}

const en: typeof fr = {
  // --- Page -----------------------------------------------------------------
  metaTitle: 'Review centre',
  backToRun: '‹ Processing',
  heading: (n: number) => `Review · chapter ${n}`,
  explicitReviewCount: (n: number) => `${n} in explicit review`,

  quarantineTitle: 'Quarantine',
  quarantineCount: (n: number) => `${n} set aside · why?`,
  quarantineBody1:
    'These proposals could not be tied to verifiable evidence: a reference ' +
    'that does not exist, or an excerpt absent from the cited text. They are ',
  quarantineNot: 'not',
  quarantineBody2:
    ' proposable — this is the safeguard that keeps a claim that came from ' +
    'anywhere but the pages out of the graph. Their distribution, however, ' +
    'is a useful diagnostic.',
  quarantineReasons: {
    unknown_ref:
      'nonexistent panel or block reference — often a sign the segmentation went wrong',
    excerpt_not_in_source:
      'excerpt absent from the cited block — often a sign of a transcription too degraded to anchor anything',
    visual_without_description:
      'visual evidence on a panel with no description produced',
    unknown_predicate: 'predicate outside the ontology',
    unknown_node_type: 'node type outside the ontology',
    unknown_subject: 'subject not found — its entity was set aside',
    unknown_object: 'object not found',
    empty_excerpt: 'evidence with no excerpt',
  } as Record<string, string>,

  // --- Server action --------------------------------------------------------
  noDecisions: 'No decisions to publish.',
  publishFailed: 'Publishing failed.',

  // --- Board: empty queue ---------------------------------------------------
  emptyTitle: 'Empty queue',
  emptyBody: 'Nothing to review for this run.',
  alreadyPublished: (n: number) =>
    `${n} proposal${n === 1 ? '' : 's'} already published.`,
  backToChapter: 'Back to the chapter',

  // --- Board: sticky header -------------------------------------------------
  doubleAcceptedTitle:
    'Two copies of the same proposal accepted: the graph will receive two nodes, and nothing will reconcile them afterwards.',
  doubleAccepted: (n: number) =>
    `${n} duplicate${n === 1 ? '' : 's'} accepted`,
  bulkAcceptTitle:
    'Only the safe proposals: no identity, no revelation, no contradiction',
  bulkAccept: (n: number) => `Accept ${n} safe`,
  publishing: 'Publishing…',
  publish: (n: number) => `Publish ${n || ''}`,
  stripItemDuplicate: (position: number, rank: number, total: number) =>
    `Proposal ${position}, copy ${rank} of ${total}`,
  stripItem: (position: number) => `Proposal ${position}`,
  stripDuplicateTitle: (rank: number, total: number) =>
    `Duplicate · copy ${rank}/${total}`,

  // --- Publish summary ------------------------------------------------------
  summaryCreated: (n: number) =>
    `${n} item${n === 1 ? '' : 's'} added to the graph.`,
  summaryEntities: (n: number) => `${n} entit${n === 1 ? 'y' : 'ies'}`,
  summaryAssertions: (n: number) => `${n} relation${n === 1 ? '' : 's'}`,
  summaryEvents: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
  summaryMysteries: (n: number) => `${n} myster${n === 1 ? 'y' : 'ies'}`,
  rejectedCount: (n: number) => `${n} rejected`,
  deferredCount: (n: number) => `${n} deferred`,
  failuresIntro: (n: number) => `${n} could not be applied:`,

  // --- Proposal card --------------------------------------------------------
  evidenceTitle: 'The evidence',
  evidenceCount: (n: number) => `${n} item${n === 1 ? '' : 's'}`,
  noEvidence: 'No evidence attached — this proposal should not be here.',
  confidence: (pct: number) => `confidence ${pct}%`,
  explicitReviewTitle:
    'Identity, revelation, death, hidden affiliation or contradiction: never acceptable in bulk',
  explicitReviewRequired: 'Explicit review required',
  accept: 'Accept',
  reject: 'Reject',
  defer: 'Defer',
  nothingWritten:
    'Nothing is written until “Publish”. A decision automatically moves on to the next item.',

  // --- Duplicate notice -----------------------------------------------------
  duplicateTitle: (rank: number, total: number) =>
    `Duplicate · copy ${rank} of ${total}`,
  duplicatePublished: (n: number) =>
    `${n} cop${n === 1 ? 'y' : 'ies'} already accepted and published: accepting this one would add a second node to the graph, and nothing will reconcile them afterwards.`,
  duplicateMarked: 'Another copy is already marked “accept”. One is enough.',
  duplicateDefault:
    'The chapter is extracted in slices, and the same proposal comes back ' +
    'from one slice to the next. Accept only one — unless you judge these ' +
    'to be two different appearances.',
  duplicatePrevious: ' during a previous publication.',
  twinButton: (position: number, state: string) => `no. ${position} · ${state}`,
  twinState: {
    accept: '✓ accepted',
    reject: '✕ rejected',
    defer: '⏸ deferred',
  } as Record<string, string>,
  twinUndecided: 'not decided yet',

  // --- Evidence panel -------------------------------------------------------
  pageRef: (ref: string, page: number) => `${ref} · page ${page}`,
  passageRef: (n: string) => `passage ${n}`,
  evidenceText: 'text',
  evidenceVisual: 'visual',
  panelAlt: (ref: string) => `Source panel ${ref}`,
  fullPassage: 'Full passage:',
  fullBlock: 'Full block:',

  // --- Proposal body --------------------------------------------------------
  inSource: 'In the source',
  nameQuestion: 'What to call it in French',
  nameInGraph: 'Name in the graph',
  namingNote:
    'The model cannot settle this — translating or keeping it as-is is a ' +
    'convention, not a fact of the text. Your answer is recorded for the ' +
    'whole work: the question will not be asked again.',
  resolutionQuestion: (label: string) =>
    `Is “${label}” the same entity as`,
  resolutionQuestionEnd: '?',
  resolutionScore: (pct: number) => `Score ${pct}%`,
  modelOpinion: (verdict: string) => `Model’s view (${verdict}):`,
  conflictIntro: 'Three possible readings, and the system chooses none of them:',
  flashback: 'Presented as a memory: shown here, having happened earlier.',
  category: {
    entity: 'entity',
    assertion: 'relation',
    resolution: 'reconciliation',
    conflict: 'contradiction',
    event: 'event',
    mystery: 'mystery',
  } as Record<string, string>,
  suggestion: {
    likely_same: 'probably the same',
    worth_checking: 'worth checking',
    likely_different: 'probably different',
  } as Record<string, string>,
}

export const review = { fr, en } satisfies Record<Locale, typeof fr>
