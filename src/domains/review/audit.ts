/**
 * Relire toute l'histoire, et dire ce qui ne va pas.
 *
 * Le pipeline lit un chapitre à la fois, et c'est la bonne unité : c'est celle
 * de la frontière, celle de la revue, celle du coût. Mais certains défauts
 * n'existent qu'*entre* les chapitres, et aucune relecture d'un seul chapitre ne
 * peut les voir :
 *
 *   « Oni Giri entre en scène » au chapitre 51 alors que l'attaque est nommée au
 *   17. Le chapitre 51 a raison tout seul ; c'est le fil qui se répète.
 *
 *   « Belle femme observée par Sanji → Alvida » au 97, alors que c'est Baggy qui
 *   le dit au 98. Le chapitre 97 ne peut pas savoir qu'il révèle trop tôt.
 *
 *   La même scène racontée deux fois dans un chapitre relu deux fois, avec deux
 *   formulations, donc deux empreintes, donc deux nœuds que rien ne rapproche.
 *
 * Ce fichier est la moitié qui décide, et c'est pour ça qu'il est séparé du
 * reste : ni `server-only`, ni base, ni modèle. Ce qu'il tranche est une règle
 * sur des dates, des libellés et des phrases — et une règle qu'on ne peut
 * exercer qu'au prix d'une base vivante est une règle que personne ne teste.
 * Les deux balayages voisins ont la même forme et pour la même raison.
 *
 * **Il ne corrige rien.** Il rend des constats, chacun portant la correction
 * qu'il propose sous une forme que l'appelant applique — ou n'applique pas. Les
 * conventions que ces règles font respecter sont celles du fil :
 *
 *   « entre en scène » : la première fois que le lecteur rencontre la chose ;
 *   « on en parle » : la première fois qu'on la lui nomme sans la montrer ;
 *   « un nom : ancien → nouveau » : la flèche va du connu vers le révélé ;
 *   une entité n'entre jamais en scène deux fois ;
 *   un nom ne s'affiche pas avant le chapitre qui l'écrit ;
 *   un groupe n'est pas l'un de ses membres.
 *
 * Ce qu'aucune règle d'ici ne trouvera : une phrase fausse. « Usopp devient
 * capitaine de l'équipage » est bien formée, bien datée, bien reliée, et fausse
 * — seule une lecture du chapitre le dit. C'est ce que fait la relecture par le
 * modèle, dans `audit-run.ts`, et ses constats arrivent dans la même liste.
 */
import { sameBeat } from '@/domains/knowledge/beats.ts'
import { readsAsDescription } from '@/domains/knowledge/label-shape.ts'
import { boundedEditDistance, normalizeText } from '@/domains/knowledge/normalize.ts'
import { OCCURRENCE_TYPES } from '@/domains/knowledge/ontology.ts'

/** Un libellé, tel que la règle a besoin de le lire. */
export interface AuditLabel {
  id: string
  label: string
  normalized: string
  kind: string
  /** Null quand aucun chapitre ne donne ce nom — un SBS, un databook. */
  revealedInChapter: number | null
  precedence: number
}

export interface AuditEntity {
  id: string
  nodeType: string
  firstSeenChapter: number
  labels: AuditLabel[]
}

/** Une identité acceptée, avec ses deux bouts. */
export interface AuditIdentity {
  assertionId: string
  subjectEntityId: string
  objectEntityId: string
  knowledgeFromChapter: number
}

/** Une appartenance acceptée : ce qui fait d'un nœud le membre d'un autre. */
export interface AuditMembership {
  subjectEntityId: string
  objectEntityId: string
  predicate: string
}

export interface AuditEvent {
  entityId: string
  /** Le chapitre où le fil la raconte : `told_in` sinon `shown_in`. */
  chapter: number
  summary: string
  /** L'ordre d'écriture, qui est l'ordre du fil à l'intérieur d'un chapitre. */
  createdAt: number
}

/**
 * L'état de la bibliothèque, tel qu'une règle a besoin de le voir.
 *
 * `firstWritten` est la seule moitié qui ne vienne pas du graphe : à quel
 * chapitre les *sources* écrivent ce mot pour la première fois. C'est la même
 * question que `repair:noms` pose pour dater une révélation, et c'est ce qui
 * permet à une règle de dire « ce nom s'affiche avant d'exister » sans jamais
 * dater quoi que ce soit de mémoire. Un mot qu'aucune source n'écrit n'y figure
 * pas, et les règles se taisent plutôt que d'inventer une date.
 */
export interface AuditSnapshot {
  entities: AuditEntity[]
  identities: AuditIdentity[]
  memberships: AuditMembership[]
  events: AuditEvent[]
  firstWritten: Map<string, number>
}

export type AuditKind =
  | 'scene_dupliquee'
  | 'nom_premature'
  | 'identite_a_l_envers'
  | 'identite_avec_un_membre'
  | 'entree_tardive'
  | 'entree_en_double'
  | 'variantes_du_meme_nom'
  | 'libelle_verbeux'
  | 'relecture'

/**
 * La correction que porte un constat, quand elle est mécanique.
 *
 * Mécanique veut dire : une écriture dont la règle connaît déjà toutes les
 * valeurs, et qu'un humain peut lire en entier avant de cliquer. Tout ce qui
 * demande de choisir — laquelle de ces deux entités est la bonne, ce que cette
 * phrase aurait dû dire — n'a pas de correction ici, et le constat renvoie vers
 * la fiche où le geste existe déjà.
 */
export type AuditFix =
  /** La copie d'une scène : le nœud est rejeté, l'original reste. */
  | { action: 'rejeter_entite'; entityId: string; because: string }
  /** Un nom daté d'avant le chapitre qui l'écrit. */
  | { action: 'redater_nom'; labelId: string; chapter: number }
  /** Le nom révélé le plus tard reprend la première place. */
  | { action: 'promouvoir_nom'; labelId: string }
  /** Une identité qui n'aurait jamais dû être écrite. */
  | { action: 'retirer_identite'; assertionId: string }
  /** L'entrée en scène ramenée au chapitre qui en parle en premier. */
  | { action: 'avancer_entree'; entityId: string; chapter: number }
  /** Un libellé qui raconte, ramené au nom qu'il contient. */
  | { action: 'raccourcir_libelle'; labelId: string; label: string }
  /** La phrase d'une scène, réécrite. Vient de la relecture, jamais des règles. */
  | { action: 'reecrire_scene'; entityId: string; summary: string }

export interface AuditFinding {
  kind: AuditKind
  /** Le chapitre où le lecteur bute dessus. */
  chapter: number
  /** Une ligne, telle que la page l'affiche. */
  title: string
  /** Ce que le graphe dit, et ce qui cloche. */
  detail: string
  subjectEntityId: string | null
  objectEntityId: string | null
  fix: AuditFix | null
  /**
   * Ce qui fait que ce constat est *le même* d'un balayage à l'autre.
   *
   * Un balayage se relance, et un constat écarté doit le rester : c'est la même
   * discipline que `proposal_fingerprint` en revue, pour la même raison — sans
   * elle, « ignorer » ne tient que jusqu'au prochain clic.
   */
  fingerprint: string
}

/** Les prédicats qui font d'un nœud une partie d'un autre. */
const MEMBERSHIP = new Set([
  'member_of',
  'secretly_member_of',
  'part_of',
  'part_of_place',
  'captain_of',
  'leads',
])

/**
 * Sous cette longueur, un libellé n'est pas cherché dans les sources.
 *
 * « Mr 8 » fait quatre caractères et est distinctif ; « or », « la », « eau »
 * n'en font pas moins et se trouvent partout. Quatre est le seuil sous lequel
 * une correspondance en toutes lettres ne prouve plus rien — et une règle qui
 * avance une entrée en scène sur un faux positif déplace le lecteur d'un
 * chapitre qu'il n'a pas lu.
 */
const MIN_SEARCHABLE = 4

/** Tout ce que les règles trouvent, dans l'ordre des chapitres. */
export function auditStorySnapshot(snapshot: AuditSnapshot): AuditFinding[] {
  const findings = [
    ...duplicateScenes(snapshot),
    ...prematureNames(snapshot),
    ...reversedIdentities(snapshot),
    ...identitiesWithAMember(snapshot),
    ...lateEntrances(snapshot),
    ...doubledEntrances(snapshot),
    ...spellingVariants(snapshot),
    ...verboseLabels(snapshot),
  ]

  return findings.sort((a, b) => a.chapter - b.chapter || a.kind.localeCompare(b.kind))
}

/**
 * La même scène, deux fois dans le même chapitre.
 *
 * `sameBeat` est la règle, et elle est partagée avec le centre de revue et avec
 * le fil — deux orthographes de « c'est la même scène » est exactement comment
 * une carte dit « copie 2 sur 2 » à propos d'une paire que le fil raconte deux
 * fois. Le fil en replie déjà l'affichage ; ce qui reste, et que lui seul ne
 * peut pas régler, ce sont les deux nœuds en dessous : deux entités, deux jeux
 * de relations, une scène.
 *
 * À l'intérieur d'un chapitre et jamais entre deux, parce qu'une scène redite au
 * chapitre suivant est un souvenir — c'est-à-dire une vraie perle du fil.
 *
 * Celle qu'on garde est la plus complète, et non la première : deux passages du
 * pipeline sur un même chapitre produisent une phrase courte et une phrase
 * détaillée, et c'est la détaillée qui porte ce que le chapitre dit. La perle
 * garde de toute façon sa place, l'ordre du fil venant de la date d'écriture de
 * celle qui reste.
 */
function duplicateScenes(snapshot: AuditSnapshot): AuditFinding[] {
  const byChapter = new Map<number, AuditEvent[]>()
  for (const event of snapshot.events) {
    const group = byChapter.get(event.chapter)
    if (group) group.push(event)
    else byChapter.set(event.chapter, [event])
  }

  const findings: AuditFinding[] = []

  for (const [chapter, events] of byChapter) {
    const ordered = [...events].sort((a, b) => a.createdAt - b.createdAt)
    const folded = new Set<string>()

    for (const [index, event] of ordered.entries()) {
      if (folded.has(event.entityId)) continue

      const copies = ordered
        .slice(index + 1)
        .filter((other) => !folded.has(other.entityId) && sameBeat(event.summary, other.summary))
      if (copies.length === 0) continue

      // La plus complète gagne, à égalité la plus ancienne : deux longueurs
      // égales sont deux formulations d'une même chose, et l'ordre du fil est
      // celui de l'écriture.
      const family = [event, ...copies]
      const kept = family.reduce((best, candidate) =>
        candidate.summary.length > best.summary.length ? candidate : best,
      )

      for (const copy of family) {
        if (copy.entityId === kept.entityId) continue
        folded.add(copy.entityId)
        findings.push({
          kind: 'scene_dupliquee',
          chapter,
          title: `Une scène racontée deux fois au chapitre ${chapter}`,
          detail:
            `« ${copy.summary} » redit « ${kept.summary} ». ` +
            `La formulation la plus complète est gardée, l'autre cesse d'être lue.`,
          subjectEntityId: copy.entityId,
          objectEntityId: kept.entityId,
          fix: {
            action: 'rejeter_entite',
            entityId: copy.entityId,
            because: `Doublon de la scène « ${kept.summary} » (chapitre ${chapter}).`,
          },
          fingerprint: `scene_dupliquee|${[copy.entityId, kept.entityId].sort().join('|')}`,
        })
      }
    }
  }

  return findings
}

/**
 * Un nom affiché avant le chapitre qui l'écrit.
 *
 * Le défaut que ce produit existe pour ne pas commettre, et il arrive quand même
 * : le chapitre 106 présente le maire de Whisky Peak sous une fausse identité, la
 * bibliothèque écrit « Igaram » sur son nœud, et le fil donne au lecteur du 106
 * un nom que le 110 lui apprendra.
 *
 * La date de référence ne vient pas de qui écrit la règle — ce serait le spoiler
 * avec une note de bas de page. Elle vient des sources : le premier chapitre dont
 * le texte écrit ce mot. Un nom qu'aucune source n'écrit est indatable et laissé
 * tel quel, ce qui est le bon prix du silence.
 *
 * Les libellés que rien n'affiche sont hors sujet : la publication range la
 * graphie d'origine sous tous les autres rangs précisément pour qu'elle ne
 * s'affiche jamais, et la redater ne changerait rien pour personne.
 */
function prematureNames(snapshot: AuditSnapshot): AuditFinding[] {
  const findings: AuditFinding[] = []

  for (const entity of snapshot.entities) {
    for (const label of entity.labels) {
      if (label.revealedInChapter === null) continue
      if (label.precedence <= SEARCH_ONLY) continue
      if (label.normalized.length < MIN_SEARCHABLE) continue

      const written = snapshot.firstWritten.get(label.normalized)
      if (written === undefined || written <= label.revealedInChapter) continue

      findings.push({
        kind: 'nom_premature',
        chapter: label.revealedInChapter,
        title: `« ${label.label} » s'affiche au chapitre ${label.revealedInChapter}, écrit au ${written}`,
        detail:
          `Aucune source avant le chapitre ${written} n'écrit ce nom. Tel quel, le fil ` +
          `le donne au lecteur ${written - label.revealedInChapter} chapitre(s) trop tôt.`,
        subjectEntityId: entity.id,
        objectEntityId: null,
        fix: { action: 'redater_nom', labelId: label.id, chapter: written },
        fingerprint: `nom_premature|${label.id}|${written}`,
      })
    }
  }

  return findings
}

/**
 * Rang sous lequel un libellé ne s'affiche jamais. La valeur vient de
 * `knowledge/rename.ts` ; elle est recopiée pour que ce module reste sans
 * dépendance vers la base, comme le reste du fichier.
 */
const SEARCH_ONLY = 5

/** Les natures de nom qui sont un nom, par opposition à une désignation. */
const REAL_NAME = new Set(['true_name', 'epithet'])

/**
 * La flèche qui pointe vers le passé.
 *
 * Le fil construit « ancien → nouveau » à partir du *rang* des libellés et non
 * du sens de la relation, parce que `same_as` est symétrique et que le côté où
 * un nom a été écrit est un accident. Le rang vient de la nature du nom, donc
 * une épithète révélée au 48 se fait dépasser par un vrai nom donné au 47, et le
 * fil annonce « Zeff aux Pieds Rouges → Zeff » : le lecteur voit le nom complet
 * remplacé par le nom court, ce qui est la révélation à l'envers.
 *
 * La règle ne regarde donc pas les natures mais les dates : si le nom affiché
 * est le plus *ancien* des deux et que le plus récent est un vrai nom ou une
 * épithète, la flèche remonte le temps. La correction est un rang, jamais une
 * nature : la nature dit ce qu'est un nom, et « Zeff aux Pieds Rouges » reste une
 * épithète même quand c'est sous elle que le personnage se lit.
 */
function reversedIdentities(snapshot: AuditSnapshot): AuditFinding[] {
  const byId = new Map(snapshot.entities.map((entity) => [entity.id, entity]))
  const findings: AuditFinding[] = []

  for (const identity of snapshot.identities) {
    const subject = byId.get(identity.subjectEntityId)
    const object = byId.get(identity.objectEntityId)
    if (!subject || !object) continue

    const pair = [...subject.labels, ...object.labels].filter(
      (label) => label.precedence > SEARCH_ONLY,
    )
    if (pair.length < 2) continue

    const shown = [...pair].sort(byRank)[0]!
    const hidden = [...pair].sort(byRank).at(-1)!
    if (shown.id === hidden.id) continue
    if (shown.revealedInChapter === null || hidden.revealedInChapter === null) continue
    // Le défaut est que le nom *affiché* soit le plus ancien des deux : la
    // flèche annonce alors comme révélation un nom que le lecteur avait déjà.
    if (shown.revealedInChapter >= hidden.revealedInChapter) continue
    if (!REAL_NAME.has(hidden.kind)) continue

    findings.push({
      kind: 'identite_a_l_envers',
      chapter: identity.knowledgeFromChapter,
      title: `« ${shown.label} → ${hidden.label} » remonte le temps`,
      detail:
        `Le fil affiche « ${shown.label} » (chapitre ${shown.revealedInChapter}) comme ` +
        `le nom révélé, alors que « ${hidden.label} » l'est au chapitre ` +
        `${hidden.revealedInChapter}. La flèche va du connu vers le révélé, jamais ` +
        `l'inverse.`,
      subjectEntityId: identity.subjectEntityId,
      objectEntityId: identity.objectEntityId,
      fix: { action: 'promouvoir_nom', labelId: hidden.id },
      fingerprint: `identite_a_l_envers|${identity.assertionId}|${hidden.id}`,
    })
  }

  return findings
}

/** L'ordre du fil : le mieux classé d'abord, la révélation la plus tardive ensuite. */
function byRank(a: AuditLabel, b: AuditLabel): number {
  return b.precedence - a.precedence || (b.revealedInChapter ?? 0) - (a.revealedInChapter ?? 0)
}

/**
 * Un groupe soudé à l'un de ses membres.
 *
 * « Nyaban Brothers → Buchi » : les Nyaban Brothers sont Buchi *et* Sham, et
 * l'identité fait disparaître le duo derrière la moitié de lui-même. Rien dans
 * le graphe ne l'interdit — les deux bouts sont du bon type, ce sont deux nœuds
 * distincts —, et pourtant la relation d'appartenance qui vit à côté dit
 * exactement pourquoi c'est faux : on n'appartient pas à soi-même.
 *
 * L'appartenance est donc la preuve, et c'est ce qui rend cette règle sûre :
 * elle ne devine pas qu'un libellé a l'air d'un groupe, elle lit un fait que le
 * chapitre a écrit.
 */
function identitiesWithAMember(snapshot: AuditSnapshot): AuditFinding[] {
  const byId = new Map(snapshot.entities.map((entity) => [entity.id, entity]))
  const links = new Map<string, string>()
  for (const membership of snapshot.memberships) {
    if (!MEMBERSHIP.has(membership.predicate)) continue
    links.set(pairKey(membership.subjectEntityId, membership.objectEntityId), membership.predicate)
  }

  const findings: AuditFinding[] = []

  for (const identity of snapshot.identities) {
    const predicate = links.get(pairKey(identity.subjectEntityId, identity.objectEntityId))
    if (predicate === undefined) continue

    const subject = byId.get(identity.subjectEntityId)
    const object = byId.get(identity.objectEntityId)

    findings.push({
      kind: 'identite_avec_un_membre',
      chapter: identity.knowledgeFromChapter,
      title:
        `« ${bestLabel(subject)} » et « ${bestLabel(object)} » sont donnés pour la ` +
        `même chose, et pour un ensemble et sa partie`,
      detail:
        `Le graphe porte déjà « ${predicate} » entre ces deux nœuds : l'un appartient ` +
        `à l'autre, donc ils ne peuvent pas être le même. L'identité efface le groupe ` +
        `derrière l'un de ses membres.`,
      subjectEntityId: identity.subjectEntityId,
      objectEntityId: identity.objectEntityId,
      fix: { action: 'retirer_identite', assertionId: identity.assertionId },
      fingerprint: `identite_avec_un_membre|${identity.assertionId}`,
    })
  }

  return findings
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

function bestLabel(entity: AuditEntity | undefined): string {
  if (!entity) return 'nœud inconnu'
  return [...entity.labels].sort(byRank)[0]?.label ?? 'sans nom'
}

/**
 * Entrer en scène après avoir été nommé.
 *
 * « entre en scène : Oni Giri » au chapitre 51, alors que Zoro l'annonce au 17.
 * Le nœud n'est pas en trop — c'est le chapitre où il commence qui est faux, et
 * le fil rejoue une nouveauté que le lecteur connaît depuis trente-quatre
 * chapitres.
 *
 * La date vient encore des sources, et le libellé cherché est celui qui
 * s'affiche : c'est ce mot-là que le lecteur a lu. Les désignations provisoires
 * sont exclues, parce qu'elles sont écrites *par* la bibliothèque — « Homme
 * mystérieux debout sur l'eau » ne se trouve dans aucun chapitre, et si par
 * accident une phrase la contenait, ce ne serait pas une mention.
 *
 * Reculer une entrée en scène ne montre rien de nouveau : le mot est dans le
 * texte du chapitre visé, le lecteur l'a déjà lu là.
 */
function lateEntrances(snapshot: AuditSnapshot): AuditFinding[] {
  const findings: AuditFinding[] = []

  for (const entity of snapshot.entities) {
    const label = [...entity.labels].sort(byRank)[0]
    if (!label) continue
    if (label.kind === 'placeholder' || label.precedence <= SEARCH_ONLY) continue
    if (label.normalized.length < MIN_SEARCHABLE) continue

    const written = snapshot.firstWritten.get(label.normalized)
    if (written === undefined || written >= entity.firstSeenChapter) continue

    findings.push({
      kind: 'entree_tardive',
      chapter: entity.firstSeenChapter,
      title: `« ${label.label} » entre en scène au ${entity.firstSeenChapter}, nommé dès le ${written}`,
      detail:
        `Le texte du chapitre ${written} écrit déjà ce nom. Le fil annonce donc comme ` +
        `nouveau, au chapitre ${entity.firstSeenChapter}, quelque chose dont le lecteur ` +
        `a entendu parler ${entity.firstSeenChapter - written} chapitre(s) plus tôt.`,
      subjectEntityId: entity.id,
      objectEntityId: null,
      fix: { action: 'avancer_entree', entityId: entity.id, chapter: written },
      fingerprint: `entree_tardive|${entity.id}|${written}`,
    })
  }

  return findings
}

/**
 * Deux nœuds, un nom, une chose.
 *
 * La publication rattache une proposition à une entité acceptée du même type
 * portant exactement le même nom normalisé, donc ceci ne devrait pas arriver —
 * et arrive quand même, parce qu'un nom se corrige après coup : deux fiches
 * renommées à la main vers la même graphie ne repassent par aucune publication.
 *
 * Aucune correction automatique. Fusionner deux nœuds réécrit ce que le lecteur
 * savait à chaque chapitre entre les deux, et c'est le seul jugement que
 * l'ontologie place en revue humaine obligatoire : le constat nomme les deux
 * fiches, et le geste d'identité qui existe déjà sur la fiche tranche.
 */
function doubledEntrances(snapshot: AuditSnapshot): AuditFinding[] {
  const joined = new Set(
    snapshot.identities.map((identity) =>
      pairKey(identity.subjectEntityId, identity.objectEntityId),
    ),
  )

  const byName = new Map<string, AuditEntity[]>()
  for (const entity of snapshot.entities) {
    const label = [...entity.labels].sort(byRank)[0]
    if (!label || label.normalized.length === 0) continue
    const key = `${entity.nodeType}|${label.normalized}`
    const group = byName.get(key)
    if (group) group.push(entity)
    else byName.set(key, [entity])
  }

  const findings: AuditFinding[] = []

  for (const group of byName.values()) {
    if (group.length < 2) continue
    const ordered = [...group].sort((a, b) => a.firstSeenChapter - b.firstSeenChapter)
    const first = ordered[0]!

    for (const other of ordered.slice(1)) {
      if (joined.has(pairKey(first.id, other.id))) continue
      findings.push({
        kind: 'entree_en_double',
        chapter: other.firstSeenChapter,
        title: `« ${bestLabel(other)} » entre en scène deux fois`,
        detail:
          `Deux fiches du même type portent ce nom : l'une au chapitre ` +
          `${first.firstSeenChapter}, l'autre au ${other.firstSeenChapter}, et rien ne ` +
          `les relie. Le rapprochement se décide sur la fiche, qui montre ce que ` +
          `chacune porte.`,
        subjectEntityId: other.id,
        objectEntityId: first.id,
        fix: null,
        fingerprint: `entree_en_double|${pairKey(first.id, other.id)}`,
      })
    }
  }

  return findings
}

/**
 * Deux graphies pour une chose.
 *
 * « Baggy » et « Buggy », « Vogue Merry » et « Going Merry », « Hobbit » pour
 * « Orbit ». Ce n'est pas une erreur d'histoire : c'est une convention qui n'a
 * pas tenu d'un chapitre à l'autre, et le prix est le même qu'un doublon — deux
 * nœuds, deux moitiés de relations, et un lecteur qui cherche l'un des deux.
 *
 * Une lettre de différence, pas deux. Le seuil est bas exprès : « Kuina » et
 * « Kuma » sont à deux lettres l'une de l'autre et sont deux personnes, et
 * proposer de les confondre serait la faute que ce produit ne peut pas se
 * permettre. Ce qui passe sous ce seuil est signalé, jamais corrigé.
 */
function spellingVariants(snapshot: AuditSnapshot): AuditFinding[] {
  const joined = new Set(
    snapshot.identities.map((identity) =>
      pairKey(identity.subjectEntityId, identity.objectEntityId),
    ),
  )

  const named = snapshot.entities
    .map((entity) => ({ entity, label: [...entity.labels].sort(byRank)[0] }))
    .filter(
      (row): row is { entity: AuditEntity; label: AuditLabel } =>
        row.label !== undefined &&
        row.label.kind !== 'placeholder' &&
        row.label.normalized.length >= MIN_SEARCHABLE,
    )

  const findings: AuditFinding[] = []

  for (const [index, left] of named.entries()) {
    for (const right of named.slice(index + 1)) {
      if (left.entity.nodeType !== right.entity.nodeType) continue
      if (left.label.normalized === right.label.normalized) continue
      if (joined.has(pairKey(left.entity.id, right.entity.id))) continue

      const distance = boundedEditDistance(left.label.normalized, right.label.normalized, 1)
      if (distance === null || distance === 0) continue

      const [early, late] =
        left.entity.firstSeenChapter <= right.entity.firstSeenChapter
          ? [left, right]
          : [right, left]

      findings.push({
        kind: 'variantes_du_meme_nom',
        chapter: late.entity.firstSeenChapter,
        title: `« ${early.label.label} » et « ${late.label.label} » : une lettre d'écart`,
        detail:
          `Deux fiches du même type, à une lettre l'une de l'autre — deux graphies ` +
          `d'un même nom, ou deux noms voisins. Le fil les raconte comme deux choses ` +
          `tant que rien ne les relie ; la fiche montre ce que chacune porte.`,
        subjectEntityId: late.entity.id,
        objectEntityId: early.entity.id,
        fix: null,
        fingerprint: `variantes_du_meme_nom|${pairKey(left.entity.id, right.entity.id)}`,
      })
    }
  }

  return findings
}

/**
 * Les types dont le nom EST une phrase, par construction.
 *
 * Une scène s'appelle par son résumé et un mystère par sa question : la
 * publication écrit le libellé depuis l'un ou l'autre, exprès. Les passer à la
 * règle ci-dessous reprocherait à la bibliothèque entière d'être ce qu'elle est
 * — quelques milliers de constats, tous faux, et la page devient illisible pour
 * les défauts réels.
 */
const TOLD_NOT_NAMED = new Set<string>([...OCCURRENCE_TYPES, 'mystery'])

/**
 * Un libellé qui raconte la scène au lieu de nommer la chose.
 *
 * « Escargophone utilisé par Crocodile pour contacter les Billions » est le nom
 * d'un objet dans cette bibliothèque. L'extraction le refuse depuis qu'elle sait
 * lire la grammaire d'un nom, et les cent soixante-douze chapitres importés
 * avant en portent : ce défaut-là n'existe qu'*au passé*, et c'est exactement ce
 * que cette page est pour.
 *
 * Ce que ça coûte de le laisser n'est pas la verbosité. Les circonstances sont
 * dans le nom, donc le nom n'est vrai que dans une case : le même escargophone
 * revu six chapitres plus loin dans une autre main reçoit une autre description,
 * et le graphe garde deux objets là où l'œuvre en a un. Aucune règle voisine ne
 * les rapprochera — `variantes_du_meme_nom` cherche une lettre d'écart, et il y
 * a ici trente mots.
 *
 * La règle est celle de l'extraction, la même fonction : un nom est un groupe
 * nominal, une description y accroche une proposition, et c'est la proposition
 * qui appartient à une relation. Deux copies de ce test voudraient dire qu'un
 * chapitre importé aujourd'hui et un chapitre relu aujourd'hui ne sont pas jugés
 * pareil.
 *
 * Seuls les libellés qui s'affichent. Une graphie rangée sous le rang
 * d'affichage n'est là que pour être trouvée par une recherche ou par un
 * catalogue, et la raccourcir ne changerait rien pour personne — c'est aussi ce
 * qui fait qu'un constat corrigé ne revient pas : le raccourci démet l'ancienne
 * formulation à ce rang-là.
 *
 * La correction n'est proposée que si la coupe laisse un nom. « Tempêtes de
 * sable de Yuba provoquées par Crocodile » se raccourcit tout seul ; un libellé
 * long sans proposition à couper n'a pas de forme courte mécanique, et le
 * constat reste utile sans correction : il dit où regarder, et le geste est sur
 * la fiche.
 */
function verboseLabels(snapshot: AuditSnapshot): AuditFinding[] {
  /*
   * Qui porte déjà chaque nom affiché, pour ne pas en donner un qui est pris.
   *
   * « Base de la Marine, 153e branche » se raccourcit mécaniquement en « Base de
   * la Marine », et il y a des chances que ce nom soit déjà celui d'une autre
   * fiche. Écrire quand même donnerait deux fiches du même nom, ce qui est soit
   * un rapprochement à faire soit deux lieux à distinguer — dans les deux cas un
   * jugement, et la page offre « corriger les quarante » d'un clic.
   *
   * Donc le constat reste et la correction disparaît : c'est la convention de ce
   * fichier pour tout ce qui demande de choisir.
   */
  const claimed = new Map<string, Set<string>>()
  for (const entity of snapshot.entities) {
    for (const label of entity.labels) {
      if (label.precedence <= SEARCH_ONLY) continue
      const holders = claimed.get(label.normalized)
      if (holders) holders.add(entity.id)
      else claimed.set(label.normalized, new Set([entity.id]))
    }
  }

  const takenByAnother = (suggestion: string, entityId: string): boolean => {
    const holders = claimed.get(normalizeText(suggestion))
    if (holders === undefined) return false
    return [...holders].some((holder) => holder !== entityId)
  }

  const findings: AuditFinding[] = []

  for (const entity of snapshot.entities) {
    if (TOLD_NOT_NAMED.has(entity.nodeType)) continue

    for (const label of entity.labels) {
      if (label.precedence <= SEARCH_ONLY) continue

      const found = readsAsDescription(label.label)
      if (found === null) continue

      const shape =
        found.suggestion !== null && takenByAnother(found.suggestion, entity.id)
          ? { reason: found.reason, suggestion: null, taken: found.suggestion }
          : { ...found, taken: null }

      findings.push({
        kind: 'libelle_verbeux',
        // Le chapitre où ce nom s'affiche, et l'entrée en scène à défaut : un
        // libellé hors de l'axe des chapitres se lit quand même sur la fiche.
        chapter: label.revealedInChapter ?? entity.firstSeenChapter,
        title: `« ${label.label} » raconte au lieu de nommer`,
        detail:
          shape.taken !== null
            ? `Un nom est un groupe nominal court, et celui-ci est une phrase. ` +
              `« ${shape.taken} » serait la forme courte, mais une autre fiche porte ` +
              `déjà ce nom : ou c'est la même chose et il faut les rapprocher, ou ce ` +
              `sont deux choses et il faut les distinguer. Cela se tranche sur la fiche.`
            : shape.suggestion === null
            ? `Un nom est un groupe nominal court, et celui-ci est une phrase. ` +
              `Aucune coupe mécanique n'y laisse un nom : le raccourci se choisit ` +
              `sur la fiche.`
            : `Un nom est un groupe nominal court : « ${shape.suggestion} ». ` +
              `Ce que le libellé perd — qui s'en sert, ce que ça provoque — s'écrit ` +
              `en relations, où ça se retrouve depuis les deux bouts ; gardé dans le ` +
              `nom, ça ne vaut que dans cette case et donne une seconde fiche à la ` +
              `prochaine apparition.`,
        subjectEntityId: entity.id,
        objectEntityId: null,
        fix:
          shape.suggestion === null
            ? null
            : { action: 'raccourcir_libelle', labelId: label.id, label: shape.suggestion },
        fingerprint: `libelle_verbeux|${label.id}`,
      })
    }
  }

  return findings
}

/**
 * À quel chapitre les sources écrivent chacun de ces noms pour la première fois.
 *
 * La question que `repair:noms` pose pour dater une révélation, posée ici pour
 * mille noms à la fois — et c'est la mise à l'échelle qui décide de la forme.
 * Une expression rationnelle par nom contre chaque bloc de chaque chapitre est
 * un produit cartésien, et un balayage qu'on lance en cliquant n'a pas le droit
 * de coûter une minute.
 *
 * Donc l'inverse : chaque chapitre donne une fois pour toutes l'ensemble de ses
 * mots, un nom dont un seul mot manque est éliminé sans rien lire, et le texte
 * n'est parcouru que pour les rares candidats qui survivent. Ce dernier passage
 * reste nécessaire — les mots de « Vogue Merry » peuvent être présents tous les
 * deux sans que la phrase ne les mette côte à côte.
 *
 * Un mot entier, jamais un morceau : « Vivi » dans « Vivienne » n'est pas une
 * occurrence du nom, et une date fausse est le seul défaut que ces règles
 * puissent introduire dans une bibliothèque.
 */
export function firstWrittenChapters(
  sources: ReadonlyArray<{ chapter: number; normalizedText: string }>,
  normalizedLabels: readonly string[],
): Map<string, number> {
  const ordered = [...sources].sort((a, b) => a.chapter - b.chapter)
  const indexed = ordered.map((source) => ({
    chapter: source.chapter,
    text: source.normalizedText,
    words: new Set(source.normalizedText.split(/[^\p{L}\p{N}]+/u).filter(Boolean)),
  }))

  const found = new Map<string, number>()

  for (const label of new Set(normalizedLabels)) {
    const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    if (words.length === 0) continue

    for (const source of indexed) {
      if (!words.every((word) => source.words.has(word))) continue
      if (!writesWholeWord(source.text, label)) continue
      found.set(label, source.chapter)
      break
    }
  }

  return found
}

/** Le nom, entier, entouré de ce qui n'est pas une lettre. */
function writesWholeWord(text: string, needle: string): boolean {
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return false
    const before = at === 0 ? '' : text[at - 1]!
    const after = text[at + needle.length] ?? ''
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
}

function isWordChar(char: string): boolean {
  return char.length > 0 && /[\p{L}\p{N}]/u.test(char)
}

/**
 * Les scènes d'un chapitre que ces fragments désignent.
 *
 * La règle d'une correction écrite d'avance : elle sait ce qu'elle veut dire et
 * ne sait pas contre quelles phrases elle va tomber. `repair:chronologie` en a
 * fait les frais en production — « usopp » et « capitaine » désignaient quatre
 * scènes du chapitre 41, dont « Usopp suppose qu'il deviendra le capitaine, mais
 * Luffy lui rappelle qu'il occupe déjà ce rôle », qui est exactement ce que le
 * chapitre dit. Les quatre ont reçu la même phrase : trois scènes justes
 * perdues, trois doublons gagnés.
 *
 * D'où cette fonction, ici plutôt que dans le script : ce qu'elle rend est une
 * *liste*, et c'est l'appelant qui refuse d'écrire quand elle n'en contient pas
 * exactement une. Séparée ainsi, la règle se teste contre les vraies phrases de
 * la bibliothèque sans base et sans écrire une ligne.
 *
 * Comparaison sur le texte normalisé — accents, apostrophes et ponctuation
 * repliés —, donc « Bell-mère » attrape « Bell-mere » et « l'équipage »
 * attrape « l equipage ».
 */
export function scenesMatching<T extends { summary: string }>(
  scenes: readonly T[],
  fragments: readonly string[],
): T[] {
  const needles = fragments.map((fragment) => normalizeText(fragment)).filter((n) => n.length > 0)
  if (needles.length === 0) return []

  return scenes.filter((scene) => {
    const summary = normalizeText(scene.summary)
    return needles.every((needle) => summary.includes(needle))
  })
}

/**
 * Ce que la relecture d'un chapitre a répondu, ligne par ligne.
 *
 * Le modèle répond en texte, dans un format d'une ligne par reproche :
 *
 *   <identifiant de la scène> | ce qui cloche | la phrase corrigée | la citation
 *
 * Le format est plat exprès. Il n'y a pas de méthode « relire » sur le
 * fournisseur, et lui en ajouter une voudrait dire l'écrire cinq fois — pour
 * l'API, pour l'abonnement, pour un modèle local, pour le rejeu, pour le mode
 * synthétique — afin de gagner des accolades. Le balayage des identités a fait
 * le même choix avec le même appel, et pour la même raison.
 *
 * Ce qui est refusé ici est refusé une fois pour tout le monde : une ligne sans
 * ses champs, un identifiant que le modèle a formé plutôt que recopié, une scène
 * reprochée deux fois. Ce qui reste est ancré ailleurs, par `relectureFinding`,
 * qui exige que la citation se trouve vraiment dans le chapitre.
 */
export interface RelectureRow {
  entityId: string
  objection: string
  correction: string | null
  /** Vide quand la ligne n'en portait pas : l'appelant a une seconde source. */
  excerpt: string
}

export function parseRelecture(
  text: string,
  allowedEntityIds: readonly string[],
): RelectureRow[] {
  const allowed = new Set(allowedEntityIds)
  const seen = new Set<string>()
  const rows: RelectureRow[] = []

  for (const line of text.split('\n')) {
    const fields = line.split('|').map((field) => field.trim())
    if (fields.length < 3) continue

    const entityId = (fields[0] ?? '').replace(/^[-•*\s]+/, '')
    if (!allowed.has(entityId) || seen.has(entityId)) continue

    const objection = fields[1] ?? ''
    if (objection.length === 0) continue

    const correction = fields[2] ?? ''
    // Tout ce qui suit le troisième séparateur : une phrase citée a le droit de
    // contenir une barre verticale, et en perdre la fin ferait échouer
    // l'ancrage sur une citation par ailleurs honnête.
    const excerpt = fields.slice(3).join(' | ').trim()

    seen.add(entityId)
    rows.push({
      entityId,
      objection,
      correction: correction === '-' || correction.length === 0 ? null : correction,
      excerpt,
    })
  }

  return rows
}

/**
 * Ce qu'une relecture par le modèle a trouvé sur un chapitre, en constat.
 *
 * Écrit ici plutôt que dans l'appelant pour la raison qui vaut pour la carte de
 * revue du balayage d'identités : c'est la moitié qui peut échouer en silence.
 * Une correction proposée sans phrase citée est un souvenir du modèle, et une
 * phrase qui n'est pas dans le chapitre est une invention bien formée — les deux
 * se refusent ici, une fois, plutôt que dans chaque appelant.
 *
 * La réécriture n'est proposée que si le modèle en donne une *et* qu'elle diffère
 * de la phrase existante. Un constat sans correction reste utile : il dit où
 * regarder, et le geste est sur la fiche.
 */
export function relectureFinding(input: {
  chapter: number
  entityId: string
  summary: string
  objection: string
  excerpt: string
  passages: readonly string[]
  correction?: string | null
}): AuditFinding | null {
  const objection = input.objection.trim()
  const excerpt = input.excerpt.trim()
  if (objection.length === 0 || excerpt.length === 0) return null

  const anchored = input.passages.some((passage) =>
    normalizeText(passage).includes(normalizeText(excerpt)),
  )
  if (!anchored) return null

  const correction = input.correction?.trim() ?? ''
  const rewrite =
    correction.length > 0 && normalizeText(correction) !== normalizeText(input.summary)

  return {
    kind: 'relecture',
    chapter: input.chapter,
    title: `Chapitre ${input.chapter} : « ${input.summary} »`,
    detail: `${objection}\n\nLe chapitre dit : « ${excerpt} »`,
    subjectEntityId: input.entityId,
    objectEntityId: null,
    fix: rewrite
      ? { action: 'reecrire_scene', entityId: input.entityId, summary: correction }
      : null,
    fingerprint: `relecture|${input.entityId}|${normalizeText(objection).slice(0, 80)}`,
  }
}

/** Ce que la page annonce sous chaque famille de constats. */
export const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  scene_dupliquee: 'Scènes racontées deux fois',
  nom_premature: 'Noms affichés trop tôt',
  identite_a_l_envers: 'Révélations à l’envers',
  identite_avec_un_membre: 'Un groupe confondu avec un membre',
  entree_tardive: 'Entrées en scène trop tardives',
  entree_en_double: 'Entrées en scène en double',
  variantes_du_meme_nom: 'Deux graphies d’un même nom',
  libelle_verbeux: 'Libellés qui racontent au lieu de nommer',
  relecture: 'Ce que la relecture a trouvé',
}
