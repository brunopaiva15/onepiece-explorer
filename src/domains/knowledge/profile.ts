import { PREDICATE_BY_KEY } from './ontology.ts'
import { predicateLabel } from './predicate-label.ts'

/**
 * A sheet, read the way its subject is read.
 *
 * The fiche used to be one list called « Ce que l'on sait » and a second called
 * « Ce que l'on dit d'elle » — every fact of every kind, in chapter order,
 * phrased by its predicate key's French label. That is the *record*, and it is
 * right that it exists; it is simply not how anyone reads a character. Nobody
 * asks « what is asserted about Luffy », they ask who his family is, what crew
 * he belongs to, who he has fought and where he has been. Those four answers
 * were in there, interleaved with thirty others, each one a line you had to
 * classify yourself.
 *
 * So this module groups the same facts — never a different set, never a
 * different epistemic status — into sections that depend on what the entity
 * *is*. A group's sheet leads with its members, a place's with what it is part
 * of and who is there, a mystery's with what opened it. Nothing is dropped: a
 * fact no section claims lands in « Autres faits », and a test pins that every
 * relation the ontology permits for a type has somewhere to go.
 *
 * Two things this deliberately does not do:
 *
 *   - It does not query. It takes the facts the sheet already loaded, so the
 *     chapter boundary is enforced exactly once, in the database, where ADR
 *     0001 put it. A section that went and fetched « the members » on its own
 *     would be a second path to the same rows and the first place a boundary
 *     leak would appear.
 *   - It does not carry evidence. A section entry is a *summary line* — the
 *     name, the chapter, what the claim is worth — and it points at the record
 *     below, which keeps every panel and every excerpt. Compressing a fact is
 *     allowed; compressing its proof away is not, which is why the collapsed
 *     list on the fiche is the same list it always was.
 */

export type FactDirection = 'outgoing' | 'incoming'

/**
 * The shape a profile needs of a fact.
 *
 * Structural on purpose: `SheetFact` satisfies it, and this module stays out of
 * `entity-sheet.ts`, which is `server-only`. The fiche is a server component
 * today; a section rendered on the client tomorrow should not have to fight an
 * import that throws.
 */
export interface ProfileFact {
  assertionId: string
  predicate: string
  direction: FactDirection
  otherId: string | null
  otherLabel: string | null
  otherType: string | null
  literalValue: string | null
  epistemicStatus: string
  knowledgeFromChapter: number
  knowledgeUntilChapter: number | null
  locked: boolean
  evidence: readonly unknown[]
}

/**
 * One thing this entity is to the sheet: « protège », « a rencontré », « chef ».
 *
 * A rôle carries its own epistemic weight, and that is the whole reason it is a
 * record rather than a string. Luffy protects Koby *and* has met him; the
 * meeting may be a deduction and the protection stated outright, and folding
 * both onto one line must not quietly lend the deduction the other's
 * certainty.
 */
export interface ProfileRole {
  predicate: string
  direction: FactDirection
  /** How this end reads from the sheet: « membre », « protégé par », « enfant ». */
  label: string
  /** The strongest status among the assertions folded into this rôle. */
  epistemicStatus: string
  /** The earliest chapter at which the reader could know it. */
  knowledgeFromChapter: number
  /** Set when the reader will later see this belief refuted. */
  knowledgeUntilChapter: number | null
  locked: boolean
  /** Every assertion behind this rôle, oldest first. */
  assertionIds: string[]
  evidenceCount: number
}

/**
 * One *person* — or island, or crew — under one heading.
 *
 * The unit of a section is who it is about, not how many things were asserted.
 * « Proches » listing « a rencontré Zoro », « protège Zoro » and « connaît
 * Zoro » on three consecutive lines counts to three and says one thing, and a
 * sheet with forty of those is a list to scroll rather than a page to read.
 */
export interface ProfileEntry {
  /** Stable within its section: the other end of the relation. */
  key: string
  otherId: string | null
  otherLabel: string | null
  otherType: string | null
  literalValue: string | null
  /** Everything this entity is to the sheet, under this heading. */
  roles: ProfileRole[]
  /** The strongest status among the rôles — what the line's colour shows. */
  epistemicStatus: string
  /** The earliest chapter at which any of it could be known. */
  knowledgeFromChapter: number
}

export interface ProfileSection {
  key: string
  title: string
  entries: ProfileEntry[]
}

/**
 * A slot: one kind of fact a section accepts.
 *
 * `otherTypes` is what lets a place separate « qui s'y trouve » from « ce qui
 * s'y passe ». Both are an incoming `located_at`; only the type at the other
 * end says whether it is a person standing there or a battle happening there.
 */
interface Slot {
  predicate: string
  direction: FactDirection
  otherTypes?: readonly string[]
  /** Overrides the predicate's own French — see the `>` form below. */
  role?: string
}

interface SectionDef {
  key: string
  title: string
  slots: Slot[]
}

/**
 * `'located_at:in:event|battle|voyage'` — predicate, direction, and optionally
 * the types accepted at the other end. A trailing `'>promis par'` replaces the
 * predicate's own French for this section only.
 *
 * That override exists for the predicates whose object plays two roles.
 * `promises` accepts a character (the one being promised to) and an object (the
 * thing promised), so « lui a promis » is right on a person's sheet and wrong
 * on a sword's. The section knows which case it is in; the predicate does not.
 *
 * Written as strings because the alternative is four hundred object literals
 * for something that is a table of correspondences, and a table you cannot read
 * at a glance is a table nobody will keep up to date.
 */
function section(key: string, title: string, pairs: readonly string[]): SectionDef {
  return {
    key,
    title,
    slots: pairs.map((pair) => {
      const [selector, role] = pair.split('>')
      const [predicate, direction, types] = selector!.split(':')
      return {
        predicate: predicate!,
        direction: direction === 'in' ? 'incoming' : 'outgoing',
        otherTypes: types ? types.split('|') : undefined,
        role,
      }
    }),
  }
}

/*
 * Sections every kind of entity can carry.
 *
 * Identity and narrative facts say the same thing about a person, an island and
 * a promise — who else this might be, what revealed it — so they are declared
 * once and listed last by each type, under the sections that are specific to it.
 */
const IDENTITE = section('identite', 'Identité', [
  'has_alias:out',
  'has_alias:in',
  'same_as:out',
  'maybe_same_as:out',
])

const RECIT = section('recit', 'Dans le récit', [
  'reveals:in',
  'reveals:out',
  'hides:in',
  'hides:out',
  'mentions:in',
  'mentions:out',
  'mentioned_by:in',
  'mentioned_by:out',
  'confirms:in',
  'confirms:out',
  'refutes:in',
  'refutes:out',
  'contradicts:out',
  'appears_in:out',
  'appears_in:in',
])

const MYSTERES = section('mysteres', 'Mystères', [
  'opens_mystery:out',
  'hints_at:out',
  'resolves_mystery:out',
  'reopens_mystery:out',
])

const OCCURRENCE_SECTIONS: readonly SectionDef[] = [
  section('participants', 'Participants', ['participates_in:in']),
  section('lieu', 'Lieu', ['located_at:out', 'travels_from:out', 'travels_to:out']),
  section('morts', 'Morts', ['dies_at:in']),
  section('causalite', 'Causes et conséquences', [
    'causes:in',
    'causes:out',
    'prevents:in',
    'prevents:out',
  ]),
  section('chronologie', 'Chronologie', [
    'follows:out',
    'precedes:out',
    'follows:in',
    'precedes:in',
    'overlaps:out',
  ]),
  MYSTERES,
  IDENTITE,
  RECIT,
]

/**
 * What each type of entity leads with.
 *
 * Order is editorial and it is the whole point: a crew's sheet opens on its
 * members, a character's on their family and their crew, an island's on the sea
 * it belongs to. The first section is the answer to « qui est-ce ? » for that
 * kind of thing.
 */
const SECTIONS_BY_TYPE: Record<string, readonly SectionDef[]> = {
  character: [
    section('famille', 'Famille', [
      'child_of:out',
      'parent_of:in',
      'parent_of:out',
      'child_of:in',
      'related_to:out',
    ]),
    section('appartenances', 'Appartenances', [
      'member_of:out',
      'leads:out',
      'secretly_member_of:out',
      'leaves:out:group',
      'belongs_to_species:out',
    ]),
    section('allies', 'Alliés', ['allied_with:out', 'protects:out', 'protects:in']),
    section('adversaires', 'Adversaires', [
      'enemy_of:out',
      'fights:out',
      'captures:out',
      'captures:in',
      // `kills` outgoing here, incoming under « Mort »: on the victim's sheet
      // the killer is not one more adversary, it is the end of the story.
      'kills:out',
      'injures:out',
      'injures:in',
      'knocks_out:out',
      'knocks_out:in',
    ]),
    section('rencontres', 'Rencontres', [
      'knows:out',
      'meets:out',
      'speaks_to:out',
      'speaks_to:in',
    ]),
    section('promesses', 'Promesses', ['promises:out', 'promises:in']),
    section('lieux', 'Lieux', [
      'located_at:out',
      'travels_from:out',
      'travels_to:out',
      'leaves:out:place',
    ]),
    section('avoir', 'Possessions et pouvoirs', ['owns:out', 'uses:out']),
    section('dons', 'Dons', ['gives:out', 'receives:out']),
    section('faconne', 'Créations et destructions', ['creates:out', 'destroys:out']),
    section('objectifs', 'Ce qu’il ou elle cherche', ['seeks:out']),
    section('recherche-par', 'Recherché par', ['seeks:in']),
    section('evenements', 'Événements', [
      'participates_in:out',
      'causes:out',
      'prevents:out',
    ]),
    section('mort', 'Mort', ['dies_at:out', 'kills:in']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  group: [
    section('membres', 'Membres', [
      'leads:in',
      'member_of:in',
      'secretly_member_of:in',
      'leaves:in',
    ]),
    section('appartenance', 'Appartenance', [
      'member_of:out',
      'secretly_member_of:out',
      'leaves:out:group',
      'creates:in>fondé par',
    ]),
    section('allies', 'Alliés', ['allied_with:out', 'protects:out', 'protects:in']),
    section('adversaires', 'Adversaires', [
      'enemy_of:out',
      'fights:out',
      'captures:out',
      'captures:in',
      'destroys:in',
      // A group has no « Mort » section: wiped out, it is wiped out by an
      // adversary, and that is the heading anyone looks under.
      'kills:out',
      'kills:in',
      'injures:out',
      'injures:in',
      'knocks_out:out',
      'knocks_out:in',
    ]),
    section('rencontres', 'Rencontres', ['speaks_to:in']),
    section('promesses', 'Promesses', ['promises:in']),
    section('lieux', 'Lieux', [
      'located_at:out',
      'travels_from:out',
      'travels_to:out',
      'leaves:out:place',
    ]),
    section('avoir', 'Possessions', ['owns:out', 'uses:out']),
    section('dons', 'Dons', ['gives:out', 'receives:out']),
    section('faconne', 'Créations et destructions', ['creates:out', 'destroys:out']),
    section('objectifs', 'Ce que le groupe cherche', ['seeks:out']),
    section('evenements', 'Événements', [
      'participates_in:out',
      'causes:out',
      'prevents:out',
    ]),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  place: [
    section('situation', 'Situation', ['part_of_place:out']),
    section('contient', 'Ce qu’il contient', ['part_of_place:in']),
    section('presents', 'Qui s’y trouve', [
      'located_at:in:character|group',
      'located_at:in:object',
    ]),
    section('passages', 'Va-et-vient', [
      'travels_to:in',
      'travels_from:in',
      'leaves:in',
    ]),
    section('evenements', 'Ce qui s’y passe', [
      'located_at:in:event|battle|voyage>s’y déroule',
      'dies_at:in',
    ]),
    section('tenu-par', 'Qui le tient', ['owns:in', 'protects:in', 'creates:in']),
    section('detruit-par', 'Détruit par', ['destroys:in']),
    section('convoite', 'Convoité par', ['seeks:in']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  object: [
    section('detenteurs', 'Détenteurs', [
      'owns:in',
      'uses:in',
      'captures:in',
      // Both ends of a gift meet here and nowhere else: « donné par · Shanks »,
      // « reçu par · Luffy ».
      'gives:in',
      'receives:in',
    ]),
    section('confere', 'Ce qu’il confère', ['grants_power:out']),
    section('situation', 'Où il se trouve', [
      'located_at:out',
      'travels_from:out',
      'travels_to:out',
    ]),
    section('origine', 'Origine', ['creates:in']),
    section('detruit-par', 'Détruit par', ['destroys:in']),
    section('convoite', 'Convoité par', ['seeks:in', 'promises:in>promis par']),
    section('protege-par', 'Protégé par', ['protects:in']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  power: [
    section('porteurs', 'Qui l’utilise', ['uses:in']),
    section('origine', 'Origine', ['grants_power:in', 'creates:in']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  species: [
    section('membres', 'Qui en est', ['belongs_to_species:in']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  event: OCCURRENCE_SECTIONS,
  battle: OCCURRENCE_SECTIONS,
  voyage: OCCURRENCE_SECTIONS,

  concept: [
    section('origine', 'Origine', ['creates:in']),
    section('porte-par', 'Qui s’en réclame', ['seeks:in', 'promises:in>promis par']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],

  mystery: [
    section('ouvert-par', 'Ouvert par', ['opens_mystery:in']),
    section('indices', 'Indices', ['hints_at:in']),
    section('resolution', 'Résolution', ['resolves_mystery:in', 'reopens_mystery:in']),
    section('poursuivi', 'Poursuivi par', ['seeks:in', 'promises:in>promis par']),
    MYSTERES,
    IDENTITE,
    RECIT,
  ],
}

/** For the documentary nodes, and for a type nobody has taught us about yet. */
const FALLBACK_SECTIONS: readonly SectionDef[] = [IDENTITE, RECIT]

const AUTRES: SectionDef = { key: 'autres', title: 'Autres faits', slots: [] }

/**
 * How the other end of a fact reads, from this sheet.
 *
 * Two grammars, and the mix is deliberate rather than sloppy. Most of these are
 * verb phrases whose subject is the entity whose sheet you are on — « protégé
 * par », « se rend à ». A handful are nouns naming what the *other* entity is
 * to this one — « membre », « chef », « parent » — because under a heading that
 * already says « Membres », « compte parmi ses membres · Zoro » is a sentence
 * where a word would do.
 *
 * A symmetric predicate has one form: `fights` reaches this sheet as outgoing
 * or incoming depending on which end was written first, and « affronte » is
 * what it means either way.
 */
const ROLES: Record<string, readonly [outgoing: string, incoming: string]> = {
  appears_in: ['apparaît dans', 'y apparaît'],
  mentions: ['mentionne', 'mentionné par'],
  mentioned_by: ['mentionné par', 'mentionne'],
  participates_in: ['participe à', 'participant'],
  located_at: ['se trouve à', 'sur place'],

  travels_from: ['part de', 'départ de'],
  travels_to: ['se rend à', 'arrivée de'],

  part_of_place: ['fait partie de', 'comprend'],
  grants_power: ['confère', 'conféré par'],

  member_of: ['membre de', 'membre'],
  leads: ['dirige', 'chef'],
  leaves: ['a quitté', 'l’a quitté'],
  secretly_member_of: ['membre secret de', 'membre secret'],

  allied_with: ['allié', 'allié'],
  enemy_of: ['ennemi', 'ennemi'],
  fights: ['affronte', 'affronte'],
  protects: ['protège', 'protégé par'],
  captures: ['a capturé', 'capturé par'],
  kills: ['tue', 'tué par'],
  injures: ['blesse', 'blessé par'],
  knocks_out: ['assomme', 'assommé par'],

  knows: ['connaît', 'connaît'],
  meets: ['a rencontré', 'a rencontré'],
  speaks_to: ['parle à', 'lui parle'],

  owns: ['possède', 'propriétaire'],
  uses: ['utilise', 'utilisé par'],
  gives: ['donne', 'donné par'],
  receives: ['reçoit', 'reçu par'],
  creates: ['a créé', 'créé par'],
  destroys: ['a détruit', 'détruit par'],

  parent_of: ['enfant', 'parent'],
  child_of: ['parent', 'enfant'],
  related_to: ['de la famille', 'de la famille'],
  belongs_to_species: ['espèce', 'de cette espèce'],

  reveals: ['révèle', 'révélé par'],
  hides: ['cache', 'caché par'],
  promises: ['promet à', 'lui a promis'],
  seeks: ['recherche', 'recherché par'],
  dies_at: ['meurt à', 'y meurt'],

  causes: ['cause', 'causé par'],
  prevents: ['empêche', 'empêché par'],
  precedes: ['précède', 'précédé par'],
  follows: ['suit', 'suivi par'],
  overlaps: ['chevauche', 'chevauche'],

  has_alias: ['porte l’alias', 'alias de'],
  maybe_same_as: ['pourrait être', 'pourrait être'],
  same_as: ['identique à', 'identique à'],

  contradicts: ['contredit', 'contredit'],
  confirms: ['confirme', 'confirmé par'],
  refutes: ['réfute', 'réfuté par'],

  opens_mystery: ['ouvre', 'ouvert par'],
  hints_at: ['indice sur', 'indice'],
  resolves_mystery: ['résout', 'résolu par'],
  reopens_mystery: ['réouvre', 'rouvert par'],
}

/**
 * The French for one end of one fact.
 *
 * The fallback is the same one `predicateLabel` makes: a predicate this file has
 * never heard of — a user-defined one, which the ontology exists to allow — is
 * shown readably rather than given an invented phrase. The direction is still
 * carried on the entry, so the interface can mark which way it points.
 */
export function roleLabel(predicate: string, direction: FactDirection): string {
  const roles = ROLES[predicate]
  if (roles) return direction === 'outgoing' ? roles[0] : roles[1]
  return predicateLabel(predicate)
}

/**
 * Which way a fact points, once a symmetric predicate is taken into account.
 *
 * `enemy_of` between two crews is one relation, and which of the two rows was
 * written as subject is an accident of extraction order. Folding both onto
 * `outgoing` means a section declares `enemy_of:out` and catches the relation
 * whichever way round the graph stored it — and, more visibly, that a sheet
 * shows « ennemi · Baggy » once rather than twice.
 */
function effectiveDirection(fact: ProfileFact): FactDirection {
  const def = PREDICATE_BY_KEY.get(fact.predicate)
  return def?.symmetric ? 'outgoing' : fact.direction
}

const STATUS_RANK: Record<string, number> = {
  user_validated: 6,
  explicit: 5,
  inferred_strong: 4,
  hypothetical: 3,
  contradicted: 2,
  refuted: 1,
}

function matches(slot: Slot, fact: ProfileFact, direction: FactDirection): boolean {
  if (slot.predicate !== fact.predicate) return false
  if (slot.direction !== direction) return false
  if (!slot.otherTypes) return true
  return fact.otherType !== null && slot.otherTypes.includes(fact.otherType)
}

/**
 * Group an entity's facts into the sections its type reads by.
 *
 * Empty sections do not appear — a character with no known family has no
 * « Famille » heading rather than an empty one, and a heading over nothing is
 * the surest way to make a graph look emptier than it is. Sections keep their
 * declared order; within one, entries follow the order their slot was declared
 * in and then chapter, so « chef » comes before « membre » and the earliest
 * known member comes before the newest.
 */
export function buildEntityProfile(
  nodeType: string,
  facts: readonly ProfileFact[],
): ProfileSection[] {
  const defs = SECTIONS_BY_TYPE[nodeType] ?? FALLBACK_SECTIONS
  const all = [...defs, AUTRES]

  /*
   * One accumulator per section, holding its entries by the entity they are
   * about.
   *
   * `slotIndex` rides along on the entry and on each rôle so both can be
   * ordered by the table's own order — captain before crew member — and is
   * stripped before the sections are returned; it is bookkeeping, not something
   * the interface should be able to read.
   */
  const buckets = all.map(
    () =>
      new Map<
        string,
        Omit<ProfileEntry, 'roles'> & {
          slotIndex: number
          roles: Array<ProfileRole & { slotIndex: number }>
        }
      >(),
  )

  for (const fact of facts) {
    const direction = effectiveDirection(fact)

    let sectionIndex = all.length - 1
    let slotIndex = 0
    let slotRole: string | undefined
    outer: for (let i = 0; i < defs.length; i++) {
      const slots = defs[i]!.slots
      for (let j = 0; j < slots.length; j++) {
        if (matches(slots[j]!, fact, direction)) {
          sectionIndex = i
          slotIndex = j
          slotRole = slots[j]!.role
          break outer
        }
      }
    }

    // One line per person, per heading. `Zoro` under « Proches » is one entry
    // whatever the graph has to say about him there; the rôles accumulate on it.
    const bucket = buckets[sectionIndex]!
    const key = fact.otherId ?? `valeur:${fact.literalValue ?? ''}`
    const entry = bucket.get(key)

    if (!entry) {
      bucket.set(key, {
        key,
        slotIndex,
        otherId: fact.otherId,
        otherLabel: fact.otherLabel,
        otherType: fact.otherType,
        literalValue: fact.literalValue,
        roles: [newRole(fact, direction, slotRole, slotIndex)],
        epistemicStatus: fact.epistemicStatus,
        knowledgeFromChapter: fact.knowledgeFromChapter,
      })
      continue
    }

    const role = entry.roles.find(
      (candidate) =>
        candidate.predicate === fact.predicate && candidate.direction === direction,
    )
    if (role) {
      mergeIntoRole(role, fact)
    } else {
      entry.roles.push(newRole(fact, direction, slotRole, slotIndex))
    }

    // The line as a whole is dated by the first thing known about this person
    // here, and coloured by the best-supported of them. Each rôle keeps its own
    // of both — nothing is lent from one claim to another.
    if (fact.knowledgeFromChapter < entry.knowledgeFromChapter) {
      entry.knowledgeFromChapter = fact.knowledgeFromChapter
    }
    if (
      (STATUS_RANK[fact.epistemicStatus] ?? 0) >
      (STATUS_RANK[entry.epistemicStatus] ?? 0)
    ) {
      entry.epistemicStatus = fact.epistemicStatus
    }
    if (slotIndex < entry.slotIndex) entry.slotIndex = slotIndex
  }

  const sections: ProfileSection[] = []
  for (let i = 0; i < all.length; i++) {
    const entries = [...buckets[i]!.values()]
    if (entries.length === 0) continue

    entries.sort(
      (a, b) =>
        a.slotIndex - b.slotIndex ||
        a.knowledgeFromChapter - b.knowledgeFromChapter ||
        (a.otherLabel ?? a.literalValue ?? '').localeCompare(
          b.otherLabel ?? b.literalValue ?? '',
          'fr',
        ),
    )

    sections.push({
      key: all[i]!.key,
      title: all[i]!.title,
      entries: entries.map(({ slotIndex: _s, ...entry }) => ({
        ...entry,
        roles: entry.roles
          .sort((a, b) => a.slotIndex - b.slotIndex || a.knowledgeFromChapter - b.knowledgeFromChapter)
          .map(({ slotIndex: _r, ...role }) => role),
      })),
    })
  }

  return sections
}

function newRole(
  fact: ProfileFact,
  direction: FactDirection,
  slotRole: string | undefined,
  slotIndex: number,
): ProfileRole & { slotIndex: number } {
  return {
    slotIndex,
    predicate: fact.predicate,
    direction,
    label: slotRole ?? roleLabel(fact.predicate, direction),
    epistemicStatus: fact.epistemicStatus,
    knowledgeFromChapter: fact.knowledgeFromChapter,
    knowledgeUntilChapter: fact.knowledgeUntilChapter,
    locked: fact.locked,
    assertionIds: [fact.assertionId],
    evidenceCount: fact.evidence.length,
  }
}

/**
 * Fold a second assertion of the same relation into the rôle already there.
 *
 * The chapter shown is the earliest: it is when the reader could first know
 * this, which is the question the fiche answers everywhere else. The status
 * shown is the strongest, because « Luffy est le fils de Dragon » asserted once
 * as a hypothesis and once explicitly is known explicitly — and because the
 * reverse rule would let a stray low-confidence duplicate quietly demote an
 * established fact. Both are summaries of rows the record below still lists one
 * by one, each with its own status and its own evidence.
 */
function mergeIntoRole(role: ProfileRole, fact: ProfileFact): void {
  role.assertionIds.push(fact.assertionId)
  role.evidenceCount += fact.evidence.length
  role.locked = role.locked || fact.locked

  if (fact.knowledgeFromChapter < role.knowledgeFromChapter) {
    role.knowledgeFromChapter = fact.knowledgeFromChapter
  }

  const rank = STATUS_RANK[fact.epistemicStatus] ?? 0
  if (rank > (STATUS_RANK[role.epistemicStatus] ?? 0)) {
    role.epistemicStatus = fact.epistemicStatus
    // The refutation window belongs to the claim now being shown: keeping the
    // weaker assertion's window would announce a denial of something the sheet
    // no longer displays.
    role.knowledgeUntilChapter = fact.knowledgeUntilChapter
  }
}

/** The sections a type declares, for tests and for anything listing them. */
export function sectionsForType(nodeType: string): readonly { key: string; title: string }[] {
  return (SECTIONS_BY_TYPE[nodeType] ?? FALLBACK_SECTIONS).map((def) => ({
    key: def.key,
    title: def.title,
  }))
}
