/**
 * La seconde lecture, et ce qu'elle a le droit d'en conclure.
 *
 * La passe automatique (`auto.ts`) tranche ce dont aucun nom ne dépend et garde
 * le reste. Ce reste est exactement ce qui coûte une soirée : un nom dont le
 * modèle n'était pas sûr, une carte sous le seuil de confiance, un
 * rapprochement, une contradiction. L'arbitrage est la passe qui les reprend,
 * un modèle en main et **la page du chapitre sur le Fandom** sous les yeux — en
 * anglais et en français — et qui tranche celles que la page tranche. Le reste
 * remonte au lecteur, avec l'avis et la phrase qui l'a motivé.
 *
 * Ce fichier est la moitié qui décide, et il est séparé du reste pour la raison
 * qui sépare `identity-sweep.ts` de son script : ni `server-only`, ni base, ni
 * modèle. Ce qu'il applique est une règle sur des citations, et une règle qu'on
 * ne peut exercer qu'au prix d'un appel payant et d'une base vivante est une
 * règle que personne ne vérifie.
 *
 * Rien n'est cru sur parole. Un modèle à qui l'on tend une page en citera
 * parfois une phrase qui n'y est pas, dans le bon registre, avec les bons noms —
 * c'est le même défaut que l'ancrage traque à l'extraction, et il est traqué
 * ici de la même façon :
 *
 *   Le verdict porte sur une carte qui a été soumise, jamais sur un
 *   identifiant que le modèle a formé.
 *
 *   Un « accept » ou un « reject » ne vaut que si sa citation se trouve **mot
 *   pour mot** dans la page fournie. Sans elle, la carte repart au lecteur.
 *
 *   Une question de nom se tranche sur la graphie, pas sur le sens : la forme
 *   proposée doit figurer telle quelle dans la page. « Foosha » et « Fuchsia »
 *   sont deux entités, et c'est ainsi qu'on en fabrique deux.
 *
 *   Un rapprochement et une contradiction ne sont jamais appliqués. L'avis
 *   s'affiche sur la carte, avec sa citation, et le clic reste au lecteur.
 *   C'est exactement la ligne que la passe automatique trace déjà — « personne
 *   d'autre ne décide d'une identité », et une contradiction n'a de toute façon
 *   pas de publication — et l'arbitrage ne la desserre pas : il rend la question
 *   plus rapide à trancher en posant la phrase du wiki à côté.
 *
 *   Le reste de ce que `requires_explicit_review` marque — un vrai nom, une
 *   mort, une affiliation cachée — est arbitrable, parce que c'est déjà ce que
 *   la passe automatique accepte sur un chapitre qui se relit lui-même. La
 *   différence, et elle est en faveur du lecteur : ici la carte n'est acceptée
 *   que si une phrase de la page du wiki le dit, là où la passe automatique
 *   n'exigeait qu'un score.
 *
 *   Une entité qu'une autre carte nomme n'est pas rejetée. Le rejet est une
 *   décision, pas une mise en attente : la relation qui la vise resterait
 *   publiable et échouerait sur un sujet qui n'existe pas.
 *
 *   Une entité qu'un rapprochement conteste n'est pas tranchée du tout. C'est
 *   la règle de la passe automatique, mot pour mot : accepter la carte pendant
 *   que la question « est-ce déjà quelqu'un » dort, c'est fabriquer un second
 *   Zoro.
 *
 * Ce qu'un verdict peut faire, au pire, est réversible. Il change le statut
 * d'une proposition — il ne réécrit ni sa preuve, ni ses bouts, ni son libellé —
 * et le centre de revue sait rouvrir ce qui a été rejeté ou reporté.
 */

import type { ArbitrationCard } from '@/domains/ai/provider.ts'
import type { Arbitration } from '@/domains/ai/schemas.ts'

/** Une carte encore en file, telle que la base la porte. */
export interface PendingCard {
  itemId: string
  category: string
  payload: unknown
  fingerprint: string
  confidence: number
  requiresExplicitReview: boolean
}

/**
 * Ce que la règle ne peut pas voir depuis une carte seule.
 *
 * Trois questions dont la réponse est ailleurs — dans les autres cartes du
 * traitement, ou dans l'ontologie — et qui décident toutes les trois si un
 * verdict est applicable. Passées plutôt que calculées ici, parce que les
 * calculer demanderait la base et que c'est précisément ce que ce fichier
 * n'a pas.
 */
export interface Guards {
  /**
   * Identifiants locaux qu'une autre proposition du traitement nomme.
   *
   * Rejeter l'entité ou la scène qui les porte laisserait une relation
   * publiable pointant vers un bout qui n'existe pas.
   */
  protectedIds?: ReadonlySet<string>
  /**
   * Empreintes d'entités qu'un rapprochement en attente conteste.
   *
   * « Zoro » proposé au chapitre 3 quand Roronoa Zoro est déjà dans le graphe :
   * accepter la carte pendant que le rapprochement dort est exactement la façon
   * de créer un second Zoro que rien ne rejoindra. La passe automatique tient
   * déjà cette règle ; l'arbitrage la tient pour la même raison.
   */
  contested?: ReadonlySet<string>
  /**
   * Cartes que la publication refuserait de toute façon, avec la raison.
   *
   * Une relation au prédicat incompatible, une relation sans objet. Le verdict
   * s'affiche, la carte reste au lecteur — qui dispose, lui, des prédicats de
   * rechange sur sa carte.
   */
  unpublishable?: ReadonlyMap<string, string>
}

/** Ce que l'arbitrage retient d'une carte, appliqué ou non. */
export interface ArbitrationRecord {
  verdict: 'accept' | 'reject' | 'undecided'
  /** La phrase de la page, vérifiée mot pour mot. Vide sans verdict. */
  quote: string
  /** Une phrase, en français, affichée sur la carte. */
  reason: string
  /** Vrai quand la décision a été écrite ; faux quand elle est un avis. */
  applied: boolean
  /**
   * Pourquoi le verdict n'a pas été appliqué.
   *
   * Null quand il l'a été, et null aussi quand il n'y avait rien à appliquer :
   * « undecided » sans raison de refus est une abstention, pas un refus.
   */
  held: string | null
}

export interface Arbitrated {
  itemId: string
  /** L'identifiant court soumis au modèle, gardé pour le journal. */
  cardId: string
  record: ArbitrationRecord
}

/** Une carte soumise, et la carte de revue qu'elle représente. */
export interface Brief {
  card: ArbitrationCard
  item: PendingCard
}

/**
 * Combien de cartes partent dans un même appel.
 *
 * La page pèse quelques milliers de tokens et se répète à chaque tranche ; les
 * cartes, elles, s'additionnent, et le verdict de chacune est du texte écrit. À
 * quatre-vingts cartes d'un coup, la réponse frôle le plafond de sortie — et une
 * réponse tronquée n'est pas une réponse partielle ici, c'est un appel perdu.
 *
 * Quarante tient largement sous le plafond et laisse la page en préfixe caché
 * pour les tranches suivantes, qui ne la repayent donc pas.
 */
export const CARDS_PER_CALL = 40

/**
 * Longueur minimale d'une citation pour qu'elle prouve quelque chose.
 *
 * « the » se trouve mot pour mot dans n'importe quelle page anglaise. Le
 * contrôle de citation n'a de valeur que si la citation est assez longue pour ne
 * pas s'y trouver par hasard ; en dessous, il valide tout et ne dit rien.
 */
const MIN_QUOTE = 24

export function briefsFor(
  cards: readonly PendingCard[],
  names: Readonly<Record<string, string>>,
  threshold: number,
): Brief[] {
  return cards.map((item, index) => ({
    item,
    card: {
      id: `c${index + 1}`,
      category: categoryLabel(item.category),
      statement: statementOf(item, names),
      question: questionOf(item, threshold),
      evidence: excerptsOf(item.payload),
    },
  }))
}

/** Les cartes d'un appel, en tranches de `CARDS_PER_CALL`. */
export function slices<T>(items: readonly T[], size = CARDS_PER_CALL): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size))
  }
  return out
}

/**
 * Ce qu'une réponse établit, une fois vérifiée.
 *
 * `protectedIds` porte les identifiants qu'une autre carte de ce traitement
 * nomme — sujet, objet, participant. Une entité ou une scène qui s'y trouve ne
 * peut pas être rejetée ici : la carte qui la nomme resterait publiable et
 * échouerait sur un bout absent, dans une passe que personne ne regarde.
 */
export function settle(
  reply: Arbitration,
  briefs: readonly Brief[],
  pages: readonly { text: string }[],
  guards: Guards = {},
): Arbitrated[] {
  const byCard = new Map(briefs.map((brief) => [brief.card.id, brief]))
  const haystack = normalise(pages.map((page) => page.text).join('\n\n'))
  const seen = new Set<string>()
  const settled = new Map<string, Arbitrated>()

  for (const verdict of reply.verdicts) {
    const brief = byCard.get(verdict.card.trim())
    // Un identifiant que le modèle a formé. Rien à décider : il ne désigne
    // aucune carte, et lui en attribuer une au plus proche serait inventer un
    // verdict.
    if (!brief) continue
    // Deux verdicts sur la même carte : le premier. Un modèle qui se contredit
    // n'a pas tranché, et prendre le dernier reviendrait à laisser l'ordre de
    // la réponse décider.
    if (seen.has(brief.card.id)) continue
    seen.add(brief.card.id)

    settled.set(brief.item.itemId, {
      itemId: brief.item.itemId,
      cardId: brief.card.id,
      record: check(verdict, brief, haystack, guards),
    })
  }

  return briefs.map(
    (brief) =>
      settled.get(brief.item.itemId) ?? {
        itemId: brief.item.itemId,
        cardId: brief.card.id,
        record: {
          verdict: 'undecided',
          quote: '',
          reason: "Le modèle n'a rien répondu sur cette carte.",
          applied: false,
          held: null,
        },
      },
  )
}

function check(
  verdict: Arbitration['verdicts'][number],
  brief: Brief,
  haystack: string,
  guards: Guards,
): ArbitrationRecord {
  const reason = verdict.reason.trim()
  const quote = normalise(verdict.quote)

  if (verdict.verdict === 'undecided') {
    return { verdict: 'undecided', quote: '', reason, applied: false, held: null }
  }

  const refuse = (held: string): ArbitrationRecord => ({
    // Le verdict est gardé tel que le modèle l'a donné : la carte affiche
    // « l'arbitrage aurait accepté, et voici pourquoi ce n'est pas fait ».
    verdict: verdict.verdict,
    quote: verdict.quote.trim(),
    reason,
    applied: false,
    held,
  })

  if (quote.length < MIN_QUOTE) {
    return refuse('Citation trop courte pour prouver quoi que ce soit.')
  }
  if (!haystack.includes(quote)) {
    return refuse('Citation introuvable mot pour mot dans la page du wiki.')
  }

  const refused = guards.unpublishable?.get(brief.item.itemId)
  if (refused !== undefined) {
    return refuse(refused)
  }

  if (
    brief.item.category === 'entity' &&
    guards.contested?.has(brief.item.fingerprint) === true
  ) {
    return refuse(
      'Un rapprochement en attente dit qui c’est déjà : trancher cette carte ' +
        'avant lui créerait une seconde fiche que rien ne rejoindrait.',
    )
  }

  if (brief.item.category === 'resolution') {
    return refuse('Personne d’autre ne décide d’une identité : à vous de trancher.')
  }
  if (brief.item.category === 'conflict') {
    return refuse(
      'Une contradiction ne se publie pas : elle demande de choisir laquelle des ' +
        'deux affirmations tient.',
    )
  }

  if (verdict.verdict === 'accept' && namingQuestion(brief.item)) {
    const label = labelOf(brief.item.payload)
    if (label === null || !haystack.toLowerCase().includes(normalise(label).toLowerCase())) {
      return refuse(
        'La page n’écrit pas ce nom sous cette forme : une graphie voisine ' +
          'fabrique une seconde entité.',
      )
    }
  }

  if (verdict.verdict === 'reject') {
    const local = localIdOf(brief.item.payload)
    if (local !== null && guards.protectedIds?.has(local) === true) {
      return refuse(
        'Une autre proposition de ce chapitre la nomme : la rejeter laisserait ' +
          'une carte pointant vers un bout qui n’existe pas.',
      )
    }
  }

  return {
    verdict: verdict.verdict,
    quote: verdict.quote.trim(),
    reason,
    applied: true,
    held: null,
  }
}

/**
 * Le compte rendu d'une passe, en une ligne.
 *
 * Même forme que `autoReviewNote`, et pour la même raison : c'est la note de
 * l'étape dans la vue d'avancement, et « ce qui a été décidé sans moi » doit s'y
 * lire sans ouvrir une page.
 */
export interface ArbitrationResult {
  /** Cartes soumises au modèle. */
  submitted: number
  accepted: number
  rejected: number
  /** Cartes laissées au lecteur, toutes raisons confondues. */
  undecided: number
  /** Verdicts écartés parce qu'ils ne tenaient pas : citation, graphie, règle. */
  refused: number
  /** Avis rendus sur une carte que seul le lecteur peut trancher. */
  advisory: number
  /** Les langues de page effectivement lues. */
  pages: string[]
}

export function arbitrationResult(
  settled: readonly Arbitrated[],
  pages: readonly { language: string }[],
): ArbitrationResult {
  const applied = settled.filter((one) => one.record.applied)

  return {
    submitted: settled.length,
    accepted: applied.filter((one) => one.record.verdict === 'accept').length,
    rejected: applied.filter((one) => one.record.verdict === 'reject').length,
    undecided: settled.length - applied.length,
    refused: settled.filter((one) => one.record.held !== null).length,
    advisory: settled.filter(
      (one) => !one.record.applied && one.record.verdict !== 'undecided',
    ).length,
    pages: pages.map((page) => page.language),
  }
}

export function arbitrationNote(result: ArbitrationResult): string {
  if (result.submitted === 0) return 'Aucune proposition à arbitrer.'

  const parts = [
    `${result.submitted} proposition(s) relues sur la page du wiki ` +
      `(${result.pages.join(' + ') || 'aucune page'})`,
  ]

  if (result.accepted > 0) parts.push(`${result.accepted} acceptée(s)`)
  if (result.rejected > 0) parts.push(`${result.rejected} rejetée(s)`)
  if (result.advisory > 0) {
    parts.push(`${result.advisory} avis laissé(s) sur la carte, à vous de trancher`)
  }
  if (result.undecided > 0) {
    parts.push(`${result.undecided} laissée(s) en file`)
  }

  return parts.join(' · ')
}

/*
 * Le rendu d'une carte, pour un lecteur qui n'a pas le centre de revue sous les
 * yeux.
 *
 * Une phrase plutôt qu'un payload, délibérément. Tendre le JSON invite le
 * modèle à répondre sur des champs, et les champs ne sont pas la question : la
 * question est « le chapitre dit-il cela ». Les identifiants sont remplacés par
 * les noms que le centre de revue affiche, faute de quoi la carte se lit
 * « 9fdd1160-… capture 5da604bb-… ».
 */

function categoryLabel(category: string): string {
  switch (category) {
    case 'entity':
      return 'ENTITÉ'
    case 'assertion':
      return 'RELATION'
    case 'event':
      return 'SCÈNE'
    case 'mystery':
      return 'QUESTION'
    case 'resolution':
      return 'RAPPROCHEMENT'
    case 'conflict':
      return 'CONTRADICTION'
    default:
      return category.toUpperCase()
  }
}

export function statementOf(
  item: PendingCard,
  names: Readonly<Record<string, string>>,
): string {
  const payload = record(item.payload)
  const name = (id: unknown): string => {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') return '?'
    return names[key] ?? key
  }

  switch (item.category) {
    case 'entity': {
      const label = str(payload.label)
      const type = str(payload.node_type)
      const source = str(payload.source_term)
      return (
        `« ${label} » (${type})` +
        (source && source !== label ? ` — dans le texte source : « ${source} »` : '')
      )
    }

    case 'assertion': {
      const object = str(payload.object)
      const value = str(payload.object_value)
      return (
        `${name(payload.subject)} — ${str(payload.predicate)} → ` +
        (object ? name(object) : value ? `« ${value} »` : '(rien)')
      )
    }

    case 'event': {
      const cast = Array.isArray(payload.participants)
        ? payload.participants.map((one) => name(one)).join(', ')
        : ''
      return str(payload.summary) + (cast ? ` — avec : ${cast}` : '')
    }

    case 'mystery':
      return str(payload.question)

    case 'resolution':
      return (
        `« ${str(payload.candidateLabel)} » serait ` +
        `${name(payload.existingEntityId)}, déjà dans le graphe`
      )

    case 'conflict':
      return str(payload.explanation) || 'Contradiction avec une assertion déjà acceptée.'

    default:
      return JSON.stringify(item.payload).slice(0, 400)
  }
}

/**
 * Pourquoi personne ne l'a encore tranchée.
 *
 * Dit à la carte plutôt que laissé à deviner, parce que la question change la
 * réponse : « ce chapitre dit-il cela » et « comment écrit-on ce nom en
 * français » ne se répondent pas avec les mêmes phrases de la page.
 */
export function questionOf(item: PendingCard, threshold: number): string {
  if (item.category === 'resolution') {
    return 'Est-ce la même personne ? Décision réservée au lecteur : votre avis sera affiché sur la carte.'
  }
  if (item.category === 'conflict') {
    return 'Contredit une assertion déjà acceptée. Décision réservée au lecteur : votre avis sera affiché sur la carte.'
  }
  if (item.requiresExplicitReview && !namingQuestion(item)) {
    return (
      'Vrai nom, mort ou affiliation cachée : ce que ce chapitre révèle. ' +
      'N’acceptez que si la page l’attribue à ce chapitre-ci.'
    )
  }
  if (namingQuestion(item)) {
    return (
      'Le modèle ne sait pas comment ce nom s’écrit en français. ' +
      'Acceptez seulement si la page française l’écrit exactement ainsi.'
    )
  }
  if (item.confidence < threshold) {
    return (
      `Le modèle n’était sûr qu’à ${Math.round(item.confidence * 100)} % ` +
      `(seuil : ${Math.round(threshold * 100)} %). La page le confirme-t-elle ?`
    )
  }
  return 'La page du chapitre confirme-t-elle cette proposition ?'
}

function excerptsOf(payload: unknown): string[] {
  const holder = record(payload)
  const direct = Array.isArray(holder.evidence) ? holder.evidence : null
  const nested = Array.isArray(record(holder.proposal).evidence)
    ? (record(holder.proposal).evidence as unknown[])
    : null

  return (direct ?? nested ?? [])
    .map((one) => str(record(one).excerpt))
    .filter((excerpt) => excerpt.length > 0)
    .slice(0, 3)
}

/** Une entité dont le modèle a dit ne pas connaître la forme française. */
export function namingQuestion(item: PendingCard): boolean {
  return item.category === 'entity' && record(item.payload).naming_confident === false
}

function labelOf(payload: unknown): string | null {
  const label = str(record(payload).label)
  return label.length > 0 ? label : null
}

function localIdOf(payload: unknown): string | null {
  const local = str(record(payload).local_id)
  return local.length > 0 ? local : null
}

/**
 * Un texte comparable à un autre.
 *
 * Les espaces seuls sont normalisés — retours à la ligne, espaces insécables,
 * doublons — et rien d'autre. Une citation reste une citation : plier les
 * accents ou la casse ici rendrait le contrôle plus tolérant qu'il ne doit
 * l'être, et c'est précisément sa sévérité qui en fait une preuve.
 */
function normalise(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
