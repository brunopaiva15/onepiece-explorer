/**
 * Ontology v0 — the source of truth for built-in node types and predicates.
 *
 * These definitions are seeded into the `node_types` and `predicates` tables
 * (see ADR 0004). The database is what the engine reads at runtime, so a
 * user-created predicate works exactly like a built-in one and needs no
 * migration. This file only defines the set we ship with.
 */

export const NODE_TYPES = [
  {
    key: 'character',
    labelFr: 'Personnage',
    description:
      'Un individu nommé ou identifiable. Une silhouette non identifiée est aussi un personnage, avec un libellé de repli.',
  },
  {
    key: 'group',
    labelFr: 'Groupe',
    description:
      'Équipage, organisation, faction, marine, famille, gouvernement — toute entité collective.',
  },
  {
    key: 'place',
    labelFr: 'Lieu',
    description: 'Île, mer, royaume, ville, bâtiment, zone, région.',
  },
  {
    key: 'object',
    labelFr: 'Objet',
    description:
      'Arme, navire, document, trésor, ressource, artefact. Un fruit du démon ' +
      'en est un : il se mange, se vole, se transporte et peut réapparaître ' +
      'ailleurs — c’est la capacité qu’il confère qui est un pouvoir.',
  },
  {
    key: 'power',
    labelFr: 'Pouvoir',
    description:
      'Une capacité et son exercice : le pouvoir qu’un fruit confère, une ' +
      'technique nommée, un style de combat. Pas le fruit lui-même, qui est ' +
      'un objet.',
  },
  {
    key: 'species',
    labelFr: 'Espèce',
    description: 'Peuple, race, type de créature.',
  },
  {
    key: 'event',
    labelFr: 'Événement',
    description: 'Un fait daté ou ordonné dans le temps de l’histoire.',
  },
  {
    key: 'battle',
    labelFr: 'Combat',
    description: 'Un affrontement, sous-type d’événement suivi séparément.',
  },
  {
    key: 'voyage',
    labelFr: 'Voyage',
    description: 'Un déplacement d’un lieu vers un autre.',
  },
  {
    key: 'concept',
    labelFr: 'Concept',
    description:
      'Règle du monde, phénomène, notion, institution abstraite, coutume.',
  },
  {
    key: 'mystery',
    labelFr: 'Mystère',
    description:
      'Question ouverte, énigme, promesse narrative en attente de résolution.',
  },
  // Documentary nodes: useful for provenance queries and for the graph's
  // "show me the source" affordance.
  { key: 'chapter', labelFr: 'Chapitre', description: 'Nœud documentaire.' },
  { key: 'page', labelFr: 'Page', description: 'Nœud documentaire.' },
  { key: 'panel', labelFr: 'Case', description: 'Nœud documentaire.' },
] as const

export type NodeTypeKey = (typeof NODE_TYPES)[number]['key']

const ACTORS = ['character', 'group'] as const

/**
 * The three shapes of "something that happened".
 *
 * An event, a battle and a voyage are one family: an occurrence, situated in
 * the story's time, that entities take part in. Only their flavour differs, and
 * the ontology has to treat them as interchangeable wherever an occurrence is
 * expected — otherwise classifying a scene more precisely would *narrow* what
 * can be said about it, and calling a fight a fight would cost it its
 * `located_at`.
 *
 * Spelled once and spread, rather than listed at each predicate. Listed, the
 * three drifted apart: `event` and `battle` were accepted everywhere while
 * `voyage` was missing from four signatures — a hole nobody could hit while
 * nothing produced a voyage, and a publication failure the day something did.
 */
export const OCCURRENCE_TYPES = ['event', 'battle', 'voyage'] as const

/** What an extracted occurrence may be published as. */
export type OccurrenceKind = (typeof OCCURRENCE_TYPES)[number]

const ANY_ENTITY = [
  'character',
  'group',
  'place',
  'object',
  'power',
  'species',
  'event',
  'battle',
  'voyage',
  'concept',
  'mystery',
] as const

/**
 * Everything except a question.
 *
 * A question does not answer a question, and nothing but this list was stopping
 * one from being written down as if it did. The three mystery predicates were
 * spelled with `ANY_ENTITY` at both ends, so « Qui a fait exploser le rhum de
 * Dorry ? — résout le mystère — Qui a fait exploser le rhum de Dorry ? » was a
 * well-typed edge: the same question on both sides, requiring explicit review,
 * saying nothing. And accepting it did more than clutter the graph — it wrote
 * `resolved_in_chapter` on the question, so /mystères showed as « refermée » a
 * question no chapter had answered, and the reader lost the thread the moment
 * the answer really arrived.
 *
 * What answers a question is what the chapter shows: the scene that gives the
 * answer, most often, or the person, the place, the thing it turns on. Every
 * node type there is, minus the questions themselves.
 */
const EVERYTHING_BUT_A_MYSTERY = ANY_ENTITY.filter((key) => key !== 'mystery')

export interface PredicateDef {
  key: string
  labelFr: string
  /** Direction carries meaning (A→B ≠ B→A). */
  directed: boolean
  /** A→B implies B→A. */
  symmetric: boolean
  /** The reciprocal predicate, when one exists. */
  inverseKey?: string
  subjectTypes: readonly NodeTypeKey[]
  objectTypes: readonly NodeTypeKey[]
  /** Drives the boundary-aware union-find over identities. */
  isIdentity?: boolean
  /**
   * Forces explicit human review regardless of model confidence.
   *
   * This is where the anti-spoiler policy meets the ontology: identity claims,
   * reveals, deaths, hidden affiliations, contradictions and mystery
   * resolutions can never be swept up by a bulk "accept all high-confidence"
   * action, because getting one of them wrong corrupts every past view.
   */
  requiresExplicitReview?: boolean
  description: string
}

export const PREDICATES = [
  // --- Presence and mention -----------------------------------------------
  {
    key: 'appears_in',
    labelFr: 'apparaît dans',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ['chapter', 'page', 'panel'],
    description: 'L’entité est visible dans ce document.',
  },
  {
    key: 'mentions',
    labelFr: 'mentionne',
    directed: true,
    symmetric: false,
    inverseKey: 'mentioned_by',
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    description: 'Évoqué sans être montré.',
  },
  {
    key: 'mentioned_by',
    labelFr: 'est mentionné par',
    directed: true,
    symmetric: false,
    inverseKey: 'mentions',
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    description: 'Réciproque de « mentionne ».',
  },
  {
    key: 'participates_in',
    labelFr: 'participe à',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: OCCURRENCE_TYPES,
    description: 'Prend part à un événement.',
  },
  {
    key: 'located_at',
    labelFr: 'se trouve à',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', ...OCCURRENCE_TYPES],
    objectTypes: ['place'],
    description: 'Présence en un lieu, à un moment de l’histoire.',
  },

  // --- Movement ------------------------------------------------------------
  {
    key: 'travels_from',
    labelFr: 'part de',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', 'voyage'],
    objectTypes: ['place'],
    description: 'Origine d’un déplacement.',
  },
  {
    key: 'travels_to',
    labelFr: 'se rend à',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', 'voyage'],
    objectTypes: ['place'],
    description: 'Destination d’un déplacement.',
  },

  // --- Geography -----------------------------------------------------------
  {
    key: 'part_of_place',
    labelFr: 'fait partie de',
    directed: true,
    symmetric: false,
    subjectTypes: ['place'],
    objectTypes: ['place'],
    description:
      'Contenance géographique, stable : un village dans une île, une île dans ' +
      'une mer, une mer dans le monde. Pas une présence — quelqu’un qui se ' +
      'trouve quelque part relève de located_at.',
  },

  // --- Affiliation ---------------------------------------------------------
  {
    key: 'member_of',
    labelFr: 'appartient à',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group'],
    objectTypes: ['group'],
    description: 'Appartenance à un groupe.',
  },
  {
    key: 'leads',
    labelFr: 'dirige',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['group'],
    description: 'Commande un groupe.',
  },
  {
    key: 'leaves',
    labelFr: 'quitte',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group'],
    objectTypes: ['group', 'place'],
    description: 'Fin d’une appartenance ou d’une présence.',
  },
  {
    key: 'secretly_member_of',
    labelFr: 'appartient secrètement à',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group'],
    objectTypes: ['group'],
    requiresExplicitReview: true,
    description:
      'Affiliation cachée. Révélation narrative : revue humaine obligatoire.',
  },

  // --- Stance --------------------------------------------------------------
  {
    key: 'allied_with',
    labelFr: 'est allié à',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Alliance mutuelle.',
  },
  {
    key: 'enemy_of',
    labelFr: 'est ennemi de',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Hostilité mutuelle.',
  },
  {
    key: 'fights',
    labelFr: 'affronte',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Affrontement direct constaté.',
  },
  {
    key: 'protects',
    labelFr: 'protège',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group', 'place', 'object'],
    description: 'Défend ou met à l’abri.',
  },
  {
    key: 'captures',
    labelFr: 'capture',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group', 'object'],
    description: 'Prend de force et retient.',
  },

  // --- Violence, by what it leaves behind ----------------------------------
  //
  // Three verbs rather than one, because the difference between them is the
  // whole of what a reader remembers of the scene. `fights` is symmetric and
  // says nothing about who prevailed; `dies_at` places a death without naming
  // who caused it. What the wiki's chapter notes state in so many words —
  // « Arlong kills Bell-mère » — had no edge at all until now.
  {
    key: 'kills',
    labelFr: 'tue',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    requiresExplicitReview: true,
    description:
      'Donne la mort. Revue obligatoire pour la même raison que « meurt à » : ' +
      'une mort fausse ou annoncée trop tôt corrompt toutes les vues ' +
      'ultérieures. Les deux se disent et ne disent pas la même chose — ' +
      'celui-ci nomme le coupable, « meurt à » situe la mort dans une scène.',
  },
  {
    key: 'injures',
    labelFr: 'blesse',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description:
      'Blesse sans tuer. Si la victime meurt de cette blessure dans la même ' +
      'scène, c’est « tue ».',
  },
  {
    key: 'knocks_out',
    labelFr: 'assomme',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description:
      'Met hors de combat sans blesser durablement : évanouissement, K.-O., ' +
      'sommeil forcé. Le vaincu se relève au chapitre suivant.',
  },

  // --- Acquaintance --------------------------------------------------------
  //
  // Connaître va dans un sens.
  //
  // « connaît » joignait deux personnages et se disait mutuel, ce qui est juste
  // de deux amis et faux partout ailleurs : la moitié de cette histoire est
  // quelqu'un qui connaît un homme n'ayant jamais entendu parler de lui. Et dès
  // que l'autre bout peut être une chose — Robin et les Poneglyphes, qui est
  // tout ce qu'elle est —, la réciprocité n'est plus imprécise, elle n'a pas de
  // sens : une pierre ne connaît personne. Un prédicat symétrique dont les deux
  // bouts n'acceptent pas les mêmes types est une contradiction, et la fiche
  // l'aurait montrée telle quelle : le repli d'une relation symétrique aurait
  // écrit « connaît · Robin » sur la fiche de la pierre. Il est donc dirigé, et
  // l'autre bout se lit « connu de ». « rencontre » reste symétrique — une
  // rencontre arrive vraiment aux deux.
  {
    key: 'knows',
    labelFr: 'connaît',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group', 'object', 'place', 'concept'],
    description:
      'Sait qui est quelqu’un, ou sait ce qu’est quelque chose : une personne, ' +
      'un équipage, un objet, un lieu, une notion. Sans réciprocité — ' +
      'connaître n’est pas être connu. Se voir se dit avec « rencontre ».',
  },
  {
    key: 'meets',
    labelFr: 'rencontre',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description:
      'Première rencontre ou rencontre notable. Symétrique, et vraiment : ' +
      'aucun des deux ne rencontre l’autre sans que l’autre le rencontre.',
  },
  {
    key: 'speaks_to',
    labelFr: 'parle à',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group'],
    description: 'Adresse la parole, attesté par un dialogue.',
  },

  // --- Possession and action ----------------------------------------------
  {
    key: 'owns',
    labelFr: 'possède',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'place'],
    description: 'Détient ou possède.',
  },
  {
    key: 'uses',
    labelFr: 'utilise',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'power', 'character', 'group'],
    description:
      'Emploie un objet, un pouvoir — ou quelqu’un, quand une personne est le ' +
      'moyen : Arlong utilise Nami pour ses cartes. Se servir de quelqu’un ne ' +
      'dit ni l’appartenance ni le commandement, qui ont leurs prédicats, et ' +
      'la fiche le range sous « Emprise » et non parmi les possessions.',
  },
  {
    key: 'grants_power',
    labelFr: 'confère le pouvoir',
    directed: true,
    symmetric: false,
    subjectTypes: ['object'],
    objectTypes: ['power'],
    description:
      'Ce qu’un objet donne à qui s’en sert : un fruit du démon et la capacité ' +
      'qu’il confère. Le fruit est l’objet, la capacité est le pouvoir — sans ' +
      'ce lien, rien ne relie les deux.',
  },
  /*
   * A gift has three terms; a relation joins two.
   *
   * « Shanks donne son chapeau à Luffy » names the giver, the thing and the
   * receiver, and there is no third column to put the last one in. So the gift
   * is written from both sides — « Shanks donne le chapeau de paille », « Luffy
   * reçoit le chapeau de paille » — and the object is what joins them: its
   * sheet shows who gave it and who received it, which is exactly what anyone
   * asks of an object.
   *
   * Not a pair of inverses: `inverseKey` means the same fact read from the
   * other end, and here the subjects differ. The model proposes two, the review
   * accepts two, and accepting one without the other stays coherent — a chapter
   * sometimes shows the gesture without showing who catches it.
   */
  {
    key: 'gives',
    labelFr: 'donne',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object'],
    description:
      'Remet un objet à quelqu’un. Le destinataire se dit avec « reçoit », ' +
      'sur le même objet : une relation ne joint que deux choses.',
  },
  {
    key: 'receives',
    labelFr: 'reçoit',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object'],
    description:
      'Reçoit un objet de quelqu’un. L’autre moitié de « donne », côté ' +
      'destinataire.',
  },
  {
    key: 'creates',
    labelFr: 'crée',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'group', 'concept', 'place', 'power'],
    description:
      'Fabrique, fonde — ou invente : une technique nommée est un pouvoir, et ' +
      'quelqu’un l’a mise au point. La fiche d’un pouvoir demandait déjà son ' +
      'origine ; l’ontologie ne laissait personne l’écrire.',
  },
  {
    key: 'destroys',
    labelFr: 'détruit',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'place', 'group'],
    description: 'Anéantit.',
  },

  // --- Kinship -------------------------------------------------------------
  {
    key: 'parent_of',
    labelFr: 'est parent de',
    directed: true,
    symmetric: false,
    inverseKey: 'child_of',
    subjectTypes: ['character'],
    objectTypes: ['character'],
    requiresExplicitReview: true,
    description: 'Lien de filiation. Souvent une révélation majeure.',
  },
  {
    key: 'child_of',
    labelFr: 'est enfant de',
    directed: true,
    symmetric: false,
    inverseKey: 'parent_of',
    subjectTypes: ['character'],
    objectTypes: ['character'],
    requiresExplicitReview: true,
    description: 'Réciproque de « est parent de ».',
  },
  {
    key: 'related_to',
    labelFr: 'est lié à',
    directed: false,
    symmetric: true,
    subjectTypes: ['character'],
    objectTypes: ['character'],
    description: 'Lien familial non précisé.',
  },
  {
    key: 'belongs_to_species',
    labelFr: 'est de l’espèce',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['species'],
    description: 'Appartenance à un peuple ou une espèce.',
  },

  // --- Narrative -----------------------------------------------------------
  {
    key: 'reveals',
    labelFr: 'révèle',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    requiresExplicitReview: true,
    description: 'Rend publique une information jusque-là cachée.',
  },
  {
    key: 'hides',
    labelFr: 'cache',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ANY_ENTITY,
    description: 'Dissimule volontairement.',
  },
  {
    key: 'promises',
    labelFr: 'promet',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['character', 'group', 'concept', 'object', 'mystery'],
    description: 'Engagement narratif, souvent à long terme.',
  },
  {
    key: 'seeks',
    labelFr: 'recherche',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'place', 'character', 'group', 'concept', 'mystery'],
    description:
      'Poursuit un but : un trésor, une île, quelqu’un — ou un équipage tout ' +
      'entier, que la Marine recherche comme elle recherche ses capitaines.',
  },
  {
    key: 'dies_at',
    labelFr: 'meurt à',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: [...OCCURRENCE_TYPES, 'place'],
    requiresExplicitReview: true,
    description:
      'Mort constatée. Revue obligatoire : une fausse mort corrompt toutes les vues ultérieures.',
  },

  // --- Causality and order -------------------------------------------------
  {
    key: 'causes',
    labelFr: 'cause',
    directed: true,
    symmetric: false,
    subjectTypes: [...OCCURRENCE_TYPES, 'character', 'group'],
    objectTypes: OCCURRENCE_TYPES,
    description: 'Lien de causalité directe.',
  },
  {
    key: 'prevents',
    labelFr: 'empêche',
    directed: true,
    symmetric: false,
    subjectTypes: [...OCCURRENCE_TYPES, 'character', 'group'],
    objectTypes: OCCURRENCE_TYPES,
    description: 'Empêche un événement de se produire.',
  },
  {
    key: 'precedes',
    labelFr: 'précède',
    directed: true,
    symmetric: false,
    inverseKey: 'follows',
    subjectTypes: OCCURRENCE_TYPES,
    objectTypes: OCCURRENCE_TYPES,
    description: 'Ordre relatif, sans date exacte requise.',
  },
  {
    key: 'follows',
    labelFr: 'suit',
    directed: true,
    symmetric: false,
    inverseKey: 'precedes',
    subjectTypes: OCCURRENCE_TYPES,
    objectTypes: OCCURRENCE_TYPES,
    description: 'Réciproque de « précède ».',
  },
  {
    key: 'overlaps',
    labelFr: 'chevauche',
    directed: false,
    symmetric: true,
    subjectTypes: OCCURRENCE_TYPES,
    objectTypes: OCCURRENCE_TYPES,
    description: 'Simultanéité partielle.',
  },

  // --- Identity ------------------------------------------------------------
  {
    key: 'has_alias',
    labelFr: 'porte l’alias',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'place', 'object'],
    objectTypes: ANY_ENTITY,
    requiresExplicitReview: true,
    description:
      'Un libellé supplémentaire. Le chapitre de révélation détermine quand il devient affichable.',
  },
  {
    key: 'maybe_same_as',
    labelFr: 'pourrait être identique à',
    directed: false,
    symmetric: true,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    isIdentity: false,
    requiresExplicitReview: true,
    description:
      'Hypothèse d’identité. N’unifie jamais les nœuds : signalée dans l’interface, jamais appliquée.',
  },
  {
    key: 'same_as',
    labelFr: 'est confirmé identique à',
    directed: false,
    symmetric: true,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    isIdentity: true,
    requiresExplicitReview: true,
    description:
      'Identité confirmée. Unifie les nœuds à partir de son chapitre de révélation seulement — avant, ils restent distincts.',
  },

  // --- Epistemic relations between assertions ------------------------------
  {
    key: 'contradicts',
    labelFr: 'contredit',
    directed: false,
    symmetric: true,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    requiresExplicitReview: true,
    description: 'Incompatibilité constatée entre deux affirmations.',
  },
  {
    key: 'confirms',
    labelFr: 'confirme',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    description: 'Apporte un appui supplémentaire.',
  },
  {
    key: 'refutes',
    labelFr: 'réfute',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    requiresExplicitReview: true,
    description:
      'Invalide une croyance antérieure. Les deux assertions restent historisées.',
  },

  // --- Mysteries -----------------------------------------------------------
  {
    key: 'opens_mystery',
    labelFr: 'ouvre le mystère',
    directed: true,
    symmetric: false,
    subjectTypes: [...OCCURRENCE_TYPES, 'character', 'object', 'place', 'concept'],
    objectTypes: ['mystery'],
    description: 'Fait naître une question ouverte.',
  },
  {
    key: 'hints_at',
    labelFr: 'donne un indice sur',
    directed: true,
    symmetric: false,
    subjectTypes: EVERYTHING_BUT_A_MYSTERY,
    objectTypes: ['mystery'],
    description:
      'Alimente un mystère sans le résoudre. Ce qui donne l’indice est une ' +
      'scène, un personnage, une chose — jamais une autre question.',
  },
  {
    key: 'resolves_mystery',
    labelFr: 'résout le mystère',
    directed: true,
    symmetric: false,
    subjectTypes: EVERYTHING_BUT_A_MYSTERY,
    objectTypes: ['mystery'],
    requiresExplicitReview: true,
    description:
      'Apporte la réponse. Le sujet est ce qui répond — le plus souvent la ' +
      'scène qui montre la réponse. Une question n’en résout pas une autre, et ' +
      'surtout pas elle-même. Revue humaine obligatoire.',
  },
  {
    key: 'reopens_mystery',
    labelFr: 'réouvre le mystère',
    directed: true,
    symmetric: false,
    subjectTypes: EVERYTHING_BUT_A_MYSTERY,
    objectTypes: ['mystery'],
    requiresExplicitReview: true,
    description:
      'Invalide une résolution antérieure. Comme pour « résout le mystère », ' +
      'le sujet est ce qui la rouvre, pas une question.',
  },
] as const satisfies readonly PredicateDef[]

export type PredicateKey = (typeof PREDICATES)[number]['key']

/** Predicates that unify entities in the boundary-aware union-find. */
export const IDENTITY_PREDICATES = PREDICATES.filter(
  (p) => 'isIdentity' in p && p.isIdentity === true,
).map((p) => p.key)

/** Predicates that can never be bulk-accepted, whatever the confidence. */
export const REVIEW_REQUIRED_PREDICATES = new Set<string>(
  PREDICATES.filter(
    (p) => 'requiresExplicitReview' in p && p.requiresExplicitReview === true,
  ).map((p) => p.key),
)

export const PREDICATE_BY_KEY = new Map<string, PredicateDef>(
  PREDICATES.map((p) => [p.key, p as PredicateDef]),
)

/**
 * Why a relation cannot be written, and what could be written instead.
 *
 * The database refuses an edge whose ends do not match its predicate — « le
 * prédicat member_of n'accepte pas un objet de type place » — and it is right
 * to (ADR 0004). What was wrong is *when* the reviewer found out: after
 * publishing. The extraction prompt already states each predicate's types and
 * the model still picks `member_of` for a village now and then, so the answer
 * is not a better sentence in the prompt but the same check, run early enough
 * to be useful.
 *
 * `alternatives` is what turns the notice into something you can act on. « Luffy
 * appartient à Fuchsia » is not a hallucination; it is a true fact wearing the
 * wrong predicate, and refusing it outright loses exactly the kind of link this
 * graph keeps missing. The list is every predicate that accepts these two types,
 * in ontology order — which is not alphabetical but grouped by meaning, so the
 * spatial ones come first for a character and a place.
 */
export interface TypeMismatch {
  predicate: string
  subjectType: string
  objectType: string | null
  /** Which end is at fault. Both, when both are. */
  subjectAccepted: boolean
  objectAccepted: boolean
  expectedSubjectTypes: readonly string[]
  expectedObjectTypes: readonly string[]
  /** Predicates that accept this pair of types, in ontology order. */
  alternatives: Array<{ key: string; labelFr: string }>
  /**
   * The same fact said from the other end.
   *
   * « Les Toubibs 20 appartiennent à Wapol » is a group filed under a person,
   * and no predicate joins those two in that order — `member_of` is for crews,
   * and every predicate that does accept a group and a character says something
   * else entirely: allied, enemy, speaks to. So the direct list is a row of
   * wrong answers, and the reviewer's only remaining move is to reject a fact
   * the chapter states in as many words.
   *
   * Read backwards it is ordinary: « Wapol dirige les Toubibs 20 ». The
   * relation is the same relation, the two ends are the same two ends, and the
   * predicate that holds it is one the ontology has had all along — it was
   * simply written in the direction nothing accepts. This is every predicate
   * that would accept the ends the other way round, and choosing one swaps
   * them.
   *
   * Empty for a literal object: « se rend à "la base de la Marine" » has no
   * node on the far end to make a subject of.
   */
  reversedAlternatives: Array<{ key: string; labelFr: string }>
}

/**
 * Check a relation against the ontology, before it is offered or written.
 *
 * Null means "nothing to say": either the predicate agrees with the types, or
 * the predicate is unknown here — the ontology is stored as data so a user may
 * add one, and this module must not declare a predicate it has never heard of
 * to be wrong. An unresolved end is the same situation and answered the same
 * way; the database is the one that fails closed.
 */
export function checkTypes(
  predicate: string,
  subjectType: string | null,
  objectType: string | null,
): TypeMismatch | null {
  const def = PREDICATE_BY_KEY.get(predicate)
  if (!def || subjectType === null) return null

  const subjectAccepted = (def.subjectTypes as readonly string[]).includes(subjectType)
  // A literal object — « travels_to "la base de la Marine" » — has no node type
  // and the database checks nothing for it either.
  const objectAccepted =
    objectType === null || (def.objectTypes as readonly string[]).includes(objectType)

  if (subjectAccepted && objectAccepted) return null

  return {
    predicate,
    subjectType,
    objectType,
    subjectAccepted,
    objectAccepted,
    expectedSubjectTypes: def.subjectTypes,
    expectedObjectTypes: def.objectTypes,
    alternatives: alternativesFor(subjectType, objectType),
    // The predicate stays out of it: what is offered backwards is offered on
    // the strength of the two types, exactly as forwards. A predicate that
    // reads the same in both directions — `meets`, `allied_with` — turning up
    // in both lists is not a duplicate but the truth about it.
    reversedAlternatives:
      objectType === null ? [] : alternativesFor(objectType, subjectType),
  }
}

/** Every predicate that would accept these two ends. */
export function alternativesFor(
  subjectType: string,
  objectType: string | null,
): Array<{ key: string; labelFr: string }> {
  return PREDICATES.filter(
    (p) =>
      (p.subjectTypes as readonly string[]).includes(subjectType) &&
      (objectType === null || (p.objectTypes as readonly string[]).includes(objectType)),
  ).map((p) => ({ key: p.key as string, labelFr: p.labelFr }))
}
