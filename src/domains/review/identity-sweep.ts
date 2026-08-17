/**
 * Lire dans les chapitres suivants qui était une figure encore sans nom.
 *
 * Le mécanisme normal est en amont, et il est complet : le chapitre qui révèle
 * propose lui-même « same_as », un humain le tranche au centre de revue, et la
 * fiche offre le geste manuel pour ce qui passe à travers. Reste ce qui a été
 * importé *avant* — une bibliothèque dont les chapitres ont été lus par un prompt
 * qui ne demandait pas encore l'identité, et qui porte donc deux nœuds pour
 * chaque révélation que l'histoire a faite. C'est le rattrapage, une fois.
 *
 * Ce fichier est la moitié qui décide, et c'est pour ça qu'il est séparé du
 * script. Ni `server-only`, ni base, ni modèle : ce qu'il tranche est une règle
 * sur des dates et des citations, et une règle qu'on ne peut exercer qu'au prix
 * d'un appel payant et d'une base vivante est une règle que personne n'exerce.
 * Le balayage des mystères a la même forme et pour la même raison.
 *
 * La discipline est celle de l'assistant, parce que le défaut est le même : un
 * modèle à qui l'on tend quarante passages en citera parfois un quarante-et-
 * unième, au bon format, avec un numéro de chapitre plausible. Donc rien n'est
 * cru sur parole :
 *
 *   L'entité nommée est l'une de celles qui ont été proposées, jamais un
 *   identifiant que le modèle a formé.
 *
 *   L'extrait doit se trouver **mot pour mot** dans l'un des passages fournis.
 *   C'est le même contrôle que l'ancrage applique à toute extraction, refait ici
 *   parce que la carte de revue portera cette citation et que la base la
 *   revérifiera au moment de publier : mieux vaut ne pas écrire la carte que
 *   l'écrire pour qu'elle échoue.
 *
 *   Le chapitre vient du **passage**, jamais de la citation. Un modèle qui date
 *   sa propre réponse écrirait une révélation à la mauvaise frontière, ce qui
 *   est un spoiler avec une note de bas de page.
 */

/** Une désignation provisoire, telle que le balayage l'interroge. */
export interface UnnamedFigure {
  entityId: string
  label: string
  /** Le chapitre où le lecteur l'a rencontrée, sans nom. */
  firstSeenChapter: number
}

/** Un nom que la suite propose, et le chapitre qui le donne. */
export interface NamedOption {
  entityId: string
  label: string
  /** Quand ce nom devient lisible. Le graphe le sait ; le modèle ne le dira pas. */
  revealedInChapter: number
}

/**
 * Un passage offert à la lecture, avec ses deux identifiants.
 *
 * Deux, parce qu'ils ne servent pas au même endroit et ne sont pas uniques au
 * même niveau. `ref` est la référence du bloc **dans son chapitre** — `b3` — et
 * c'est elle que la publication résout ; elle se répète donc d'un chapitre à
 * l'autre. `id` est ce que le modèle cite, et doit être unique sur toute la
 * fenêtre : sans quoi le `b2` du chapitre 131 et celui du 134 sont la même
 * citation, et la révélation se daterait au hasard de celui des deux qui arrive
 * en premier dans la liste.
 */
export interface SweptPassage {
  id: string
  ref: string
  chapter: number
  text: string
}

/** Ce qu'un modèle a répondu sur une figure. */
export interface SweepReply {
  insufficientData: boolean
  citations: Array<{ id: string; excerpt: string }>
}

export interface IdentityFinding {
  /** L'entité nommée : l'autre bout de l'identité. */
  namedEntityId: string
  /** La date, calculée et non citée. */
  chapter: number
  /** La preuve, telle que la carte de revue la portera. */
  ref: string
  excerpt: string
}

/**
 * L'identité qu'une réponse établit, ou rien.
 *
 * Il faut les deux moitiés et elles viennent de deux endroits : *qui* c'est,
 * cité parmi les noms proposés, et *où le chapitre le dit*, cité parmi les
 * passages. Une réponse qui nomme sans citer est un souvenir du modèle ; une
 * réponse qui cite sans nommer ne dit pas de qui il s'agit. Ni l'une ni l'autre
 * ne suffit, et c'est délibérément plus strict que de faire confiance à la
 * prose : la carte écrite d'ici affirmera une identité, ce que l'ontologie place
 * en revue humaine obligatoire.
 *
 * La date est le plus tard de trois — le passage qui l'établit, l'entrée en
 * scène de la figure, la révélation du nom. Une identité ne peut pas précéder
 * l'un de ses bouts : datée avant, elle rapprocherait pour le lecteur deux
 * choses dont il n'en connaît qu'une, et l'union-find lirait une relation vers
 * une entité que la politique de ligne cache encore.
 */
export function revealedIdentity(
  reply: SweepReply,
  figure: UnnamedFigure,
  options: readonly NamedOption[],
  passages: readonly SweptPassage[],
): IdentityFinding | null {
  if (reply.insufficientData) return null

  const byOption = new Map(options.map((option) => [option.entityId, option]))
  const byId = new Map(passages.map((passage) => [passage.id, passage]))

  /*
   * Le nom : cité, et jamais la figure elle-même.
   *
   * Se citer soi-même est le pendant exact de la scène qui refermait sa propre
   * question — la même erreur, qui a l'air juste dans un rapport et écrit une
   * relation d'une entité vers elle-même que la base refuse de toute façon.
   */
  const named = reply.citations
    .map((citation) => byOption.get(citation.id))
    .find(
      (option): option is NamedOption =>
        option !== undefined && option.entityId !== figure.entityId,
    )
  if (!named) return null

  /*
   * La preuve : un extrait qui est vraiment dans le passage qui le porte.
   *
   * Le plus tôt des passages cités gagne, pour la raison qui fait gagner la
   * scène la plus ancienne dans l'autre balayage : le lecteur l'a appris la
   * première fois qu'on le lui a dit, et un chapitre ultérieur qui le redit
   * n'est pas le moment où il a su.
   */
  const anchored = reply.citations
    .map((citation) => {
      const passage = byId.get(citation.id)
      if (!passage) return null
      const excerpt = citation.excerpt.trim()
      if (excerpt.length === 0 || !passage.text.includes(excerpt)) return null
      return { passage, excerpt }
    })
    .filter((found): found is { passage: SweptPassage; excerpt: string } => found !== null)
    .sort((a, b) => a.passage.chapter - b.passage.chapter)[0]

  if (!anchored) return null

  return {
    namedEntityId: named.entityId,
    chapter: Math.max(
      anchored.passage.chapter,
      figure.firstSeenChapter,
      named.revealedInChapter,
    ),
    ref: anchored.passage.ref,
    excerpt: anchored.excerpt,
  }
}

/**
 * La carte de revue, telle que la publication l'attend.
 *
 * Ici plutôt que dans le script, parce que c'est la moitié qui peut échouer
 * silencieusement : une carte dont la référence ne se résout pas ou dont
 * l'extrait n'est pas dans son bloc est refusée par un déclencheur **au moment
 * de publier**, c'est-à-dire des jours après avoir été écrite, dans un lot de
 * vingt autres. Construite ici, elle se teste ici — et un test peut la publier
 * pour de vrai sans repasser par un appel payant.
 *
 * `explicit` et non `inferred_strong` : ce n'est pas le modèle qui affirme, c'est
 * la phrase citée. Ce que le modèle a fait, c'est la trouver — et c'est pour ça
 * que la carte porte la citation plutôt qu'un raisonnement.
 */
export interface IdentityCard {
  subject: string
  predicate: 'same_as'
  object: string
  object_value: null
  epistemic_status: 'explicit'
  confidence: number
  evidence: Array<{ kind: 'text'; ref: string; excerpt: string }>
  /** Ce que la carte dit d'elle-même, pour qui la lit six mois plus tard. */
  note: string
}

export function identityCard(
  figure: UnnamedFigure,
  finding: IdentityFinding,
  namedLabel: string,
): IdentityCard {
  return {
    subject: figure.entityId,
    predicate: 'same_as',
    object: finding.namedEntityId,
    object_value: null,
    epistemic_status: 'explicit',
    confidence: 0.9,
    evidence: [{ kind: 'text', ref: finding.ref, excerpt: finding.excerpt }],
    note:
      `Rattrapage : « ${figure.label} » (ch. ${figure.firstSeenChapter}) serait ` +
      `« ${namedLabel} » à partir du chapitre ${finding.chapter}.`,
  }
}

/**
 * Combien de chapitres après elle une figure est pesée.
 *
 * Une révélation arrive d'ordinaire peu après la rencontre — le majordome est
 * démasqué trois chapitres plus tard, l'homme debout sur l'eau douze pages plus
 * loin — et une fenêtre étroite est ce qui rend le balayage payable : sans elle,
 * une figure du chapitre 1 dans une bibliothèque de mille se pèse contre mille
 * chapitres.
 *
 * Comptée depuis la figure et non depuis la fin, pour la même raison que l'autre
 * balayage plafonne depuis le plus ancien : un balayage qui lirait la fin de
 * l'histoire d'abord daterait les révélations tard.
 *
 * Ce qu'elle coûte est réel et se dit : une identité révélée deux cents
 * chapitres plus tard n'est pas trouvée ici. Elle reste au geste manuel de la
 * fiche, qui existe pour exactement ce que les règles ne rattrapent pas.
 */
export const SWEEP_WINDOW = 15

export function windowFor(
  figure: UnnamedFigure,
  passages: readonly SweptPassage[],
  window = SWEEP_WINDOW,
): SweptPassage[] {
  return passages.filter(
    (passage) =>
      passage.chapter > figure.firstSeenChapter &&
      passage.chapter <= figure.firstSeenChapter + window,
  )
}
