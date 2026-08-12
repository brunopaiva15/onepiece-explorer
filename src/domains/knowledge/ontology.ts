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
    labelEn: 'Character',
    description:
      'Un individu nommé ou identifiable. Une silhouette non identifiée est aussi un personnage, avec un libellé de repli.',
  },
  {
    key: 'group',
    labelFr: 'Groupe',
    labelEn: 'Group',
    description:
      'Équipage, organisation, faction, marine, famille, gouvernement — toute entité collective.',
  },
  {
    key: 'place',
    labelFr: 'Lieu',
    labelEn: 'Place',
    description: 'Île, mer, royaume, ville, bâtiment, zone, région.',
  },
  {
    key: 'object',
    labelFr: 'Objet',
    labelEn: 'Object',
    description: 'Arme, navire, document, trésor, ressource, artefact.',
  },
  {
    key: 'power',
    labelFr: 'Pouvoir',
    labelEn: 'Power',
    description: 'Fruit du démon, technique, style de combat, capacité.',
  },
  {
    key: 'species',
    labelFr: 'Espèce',
    labelEn: 'Species',
    description: 'Peuple, race, type de créature.',
  },
  {
    key: 'event',
    labelFr: 'Événement',
    labelEn: 'Event',
    description: 'Un fait daté ou ordonné dans le temps de l’histoire.',
  },
  {
    key: 'battle',
    labelFr: 'Combat',
    labelEn: 'Battle',
    description: 'Un affrontement, sous-type d’événement suivi séparément.',
  },
  {
    key: 'voyage',
    labelFr: 'Voyage',
    labelEn: 'Voyage',
    description: 'Un déplacement d’un lieu vers un autre.',
  },
  {
    key: 'concept',
    labelFr: 'Concept',
    labelEn: 'Concept',
    description:
      'Règle du monde, phénomène, notion, institution abstraite, coutume.',
  },
  {
    key: 'mystery',
    labelFr: 'Mystère',
    labelEn: 'Mystery',
    description:
      'Question ouverte, énigme, promesse narrative en attente de résolution.',
  },
  // Documentary nodes: useful for provenance queries and for the graph's
  // "show me the source" affordance.
  { key: 'chapter', labelFr: 'Chapitre', labelEn: 'Chapter', description: 'Nœud documentaire.' },
  { key: 'page', labelFr: 'Page', labelEn: 'Page', description: 'Nœud documentaire.' },
  { key: 'panel', labelFr: 'Case', labelEn: 'Panel', description: 'Nœud documentaire.' },
] as const

export type NodeTypeKey = (typeof NODE_TYPES)[number]['key']

const ACTORS = ['character', 'group'] as const
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

export interface PredicateDef {
  key: string
  labelFr: string
  /** English display label. The graph stays authored in French; see 0019. */
  labelEn: string
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
    labelEn: 'appears in',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ['chapter', 'page', 'panel'],
    description: 'L’entité est visible dans ce document.',
  },
  {
    key: 'mentions',
    labelFr: 'mentionne',
    labelEn: 'mentions',
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
    labelEn: 'is mentioned by',
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
    labelEn: 'takes part in',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Prend part à un événement.',
  },
  {
    key: 'located_at',
    labelFr: 'se trouve à',
    labelEn: 'is located at',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', 'event', 'battle'],
    objectTypes: ['place'],
    description: 'Présence en un lieu, à un moment de l’histoire.',
  },

  // --- Movement ------------------------------------------------------------
  {
    key: 'travels_from',
    labelFr: 'part de',
    labelEn: 'departs from',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', 'voyage'],
    objectTypes: ['place'],
    description: 'Origine d’un déplacement.',
  },
  {
    key: 'travels_to',
    labelFr: 'se rend à',
    labelEn: 'travels to',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group', 'object', 'voyage'],
    objectTypes: ['place'],
    description: 'Destination d’un déplacement.',
  },

  // --- Affiliation ---------------------------------------------------------
  {
    key: 'member_of',
    labelFr: 'appartient à',
    labelEn: 'belongs to',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group'],
    objectTypes: ['group'],
    description: 'Appartenance à un groupe.',
  },
  {
    key: 'leads',
    labelFr: 'dirige',
    labelEn: 'leads',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['group'],
    description: 'Commande un groupe.',
  },
  {
    key: 'leaves',
    labelFr: 'quitte',
    labelEn: 'leaves',
    directed: true,
    symmetric: false,
    subjectTypes: ['character', 'group'],
    objectTypes: ['group', 'place'],
    description: 'Fin d’une appartenance ou d’une présence.',
  },
  {
    key: 'secretly_member_of',
    labelFr: 'appartient secrètement à',
    labelEn: 'secretly belongs to',
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
    labelEn: 'is allied with',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Alliance mutuelle.',
  },
  {
    key: 'enemy_of',
    labelFr: 'est ennemi de',
    labelEn: 'is an enemy of',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Hostilité mutuelle.',
  },
  {
    key: 'fights',
    labelFr: 'affronte',
    labelEn: 'fights',
    directed: false,
    symmetric: true,
    subjectTypes: ACTORS,
    objectTypes: ACTORS,
    description: 'Affrontement direct constaté.',
  },
  {
    key: 'protects',
    labelFr: 'protège',
    labelEn: 'protects',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group', 'place', 'object'],
    description: 'Défend ou met à l’abri.',
  },
  {
    key: 'captures',
    labelFr: 'capture',
    labelEn: 'captures',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['character', 'group', 'object'],
    description: 'Prend de force et retient.',
  },

  // --- Acquaintance --------------------------------------------------------
  {
    key: 'knows',
    labelFr: 'connaît',
    labelEn: 'knows',
    directed: false,
    symmetric: true,
    subjectTypes: ['character'],
    objectTypes: ['character'],
    description: 'Connaissance mutuelle établie.',
  },
  {
    key: 'meets',
    labelFr: 'rencontre',
    labelEn: 'meets',
    directed: false,
    symmetric: true,
    subjectTypes: ['character'],
    objectTypes: ['character'],
    description: 'Première rencontre ou rencontre notable.',
  },
  {
    key: 'speaks_to',
    labelFr: 'parle à',
    labelEn: 'speaks to',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['character', 'group'],
    description: 'Adresse la parole, attesté par un dialogue.',
  },

  // --- Possession and action ----------------------------------------------
  {
    key: 'owns',
    labelFr: 'possède',
    labelEn: 'owns',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'place'],
    description: 'Détient ou possède.',
  },
  {
    key: 'uses',
    labelFr: 'utilise',
    labelEn: 'uses',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'power'],
    description: 'Emploie un objet ou un pouvoir.',
  },
  {
    key: 'creates',
    labelFr: 'crée',
    labelEn: 'creates',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'group', 'concept', 'place'],
    description: 'Fabrique ou fonde.',
  },
  {
    key: 'destroys',
    labelFr: 'détruit',
    labelEn: 'destroys',
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
    labelEn: 'is a parent of',
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
    labelEn: 'is a child of',
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
    labelEn: 'is related to',
    directed: false,
    symmetric: true,
    subjectTypes: ['character'],
    objectTypes: ['character'],
    description: 'Lien familial non précisé.',
  },
  {
    key: 'belongs_to_species',
    labelFr: 'est de l’espèce',
    labelEn: 'is of the species',
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
    labelEn: 'reveals',
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
    labelEn: 'hides',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ANY_ENTITY,
    description: 'Dissimule volontairement.',
  },
  {
    key: 'promises',
    labelFr: 'promet',
    labelEn: 'promises',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['character', 'group', 'concept', 'object', 'mystery'],
    description: 'Engagement narratif, souvent à long terme.',
  },
  {
    key: 'seeks',
    labelFr: 'recherche',
    labelEn: 'seeks',
    directed: true,
    symmetric: false,
    subjectTypes: ACTORS,
    objectTypes: ['object', 'place', 'character', 'concept', 'mystery'],
    description: 'Poursuit un but.',
  },
  {
    key: 'dies_at',
    labelFr: 'meurt à',
    labelEn: 'dies at',
    directed: true,
    symmetric: false,
    subjectTypes: ['character'],
    objectTypes: ['event', 'battle', 'place'],
    requiresExplicitReview: true,
    description:
      'Mort constatée. Revue obligatoire : une fausse mort corrompt toutes les vues ultérieures.',
  },

  // --- Causality and order -------------------------------------------------
  {
    key: 'causes',
    labelFr: 'cause',
    labelEn: 'causes',
    directed: true,
    symmetric: false,
    subjectTypes: ['event', 'battle', 'voyage', 'character', 'group'],
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Lien de causalité directe.',
  },
  {
    key: 'prevents',
    labelFr: 'empêche',
    labelEn: 'prevents',
    directed: true,
    symmetric: false,
    subjectTypes: ['event', 'battle', 'character', 'group'],
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Empêche un événement de se produire.',
  },
  {
    key: 'precedes',
    labelFr: 'précède',
    labelEn: 'precedes',
    directed: true,
    symmetric: false,
    inverseKey: 'follows',
    subjectTypes: ['event', 'battle', 'voyage'],
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Ordre relatif, sans date exacte requise.',
  },
  {
    key: 'follows',
    labelFr: 'suit',
    labelEn: 'follows',
    directed: true,
    symmetric: false,
    inverseKey: 'precedes',
    subjectTypes: ['event', 'battle', 'voyage'],
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Réciproque de « précède ».',
  },
  {
    key: 'overlaps',
    labelFr: 'chevauche',
    labelEn: 'overlaps with',
    directed: false,
    symmetric: true,
    subjectTypes: ['event', 'battle', 'voyage'],
    objectTypes: ['event', 'battle', 'voyage'],
    description: 'Simultanéité partielle.',
  },

  // --- Identity ------------------------------------------------------------
  {
    key: 'has_alias',
    labelFr: 'porte l’alias',
    labelEn: 'goes by the alias',
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
    labelEn: 'might be the same as',
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
    labelEn: 'is confirmed the same as',
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
    labelEn: 'contradicts',
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
    labelEn: 'confirms',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ANY_ENTITY,
    description: 'Apporte un appui supplémentaire.',
  },
  {
    key: 'refutes',
    labelFr: 'réfute',
    labelEn: 'refutes',
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
    labelEn: 'opens the mystery',
    directed: true,
    symmetric: false,
    subjectTypes: ['event', 'battle', 'character', 'object', 'place', 'concept'],
    objectTypes: ['mystery'],
    description: 'Fait naître une question ouverte.',
  },
  {
    key: 'hints_at',
    labelFr: 'donne un indice sur',
    labelEn: 'hints at',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ['mystery'],
    description: 'Alimente un mystère sans le résoudre.',
  },
  {
    key: 'resolves_mystery',
    labelFr: 'résout le mystère',
    labelEn: 'resolves the mystery',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ['mystery'],
    requiresExplicitReview: true,
    description: 'Apporte la réponse. Revue humaine obligatoire.',
  },
  {
    key: 'reopens_mystery',
    labelFr: 'réouvre le mystère',
    labelEn: 'reopens the mystery',
    directed: true,
    symmetric: false,
    subjectTypes: ANY_ENTITY,
    objectTypes: ['mystery'],
    requiresExplicitReview: true,
    description: 'Invalide une résolution antérieure.',
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
