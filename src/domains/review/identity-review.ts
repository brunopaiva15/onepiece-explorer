/**
 * Relire les identités que le graphe porte déjà, et dire ce qu'elles sont
 * vraiment.
 *
 * Les règles gratuites voisines attrapent ce que les *types* rendent
 * impossible : une question donnée pour quelqu'un, un personnage donné pour un
 * groupe, une scène donnée pour une personne. Elles ne peuvent rien contre
 * l'identité dont les deux bouts sont deux personnages bien formés et qui est
 * fausse quand même — celle qui rapproche un duo de l'un de ses membres sans
 * qu'aucune appartenance ne soit écrite à côté, celle qui rapproche quelqu'un
 * de la fusion dont il est la moitié, celle qui prend un déguisement pour une
 * révélation. Il faut avoir lu le chapitre pour le savoir, et lire coûte un
 * appel.
 *
 * Ce que le modèle est chargé de faire est un **classement**, pas un jugement
 * libre. Une identité veut dire que les deux nœuds désignent réellement la même
 * chose ; toutes les autres relations que l'histoire écrit entre deux nœuds
 * proches ont un nom, et ce nom est ce qu'on lui demande de choisir :
 *
 *   `valid_identity`            — c'est bien la même chose sous deux noms ;
 *   `group_member`              — un ensemble et l'un de ses membres ;
 *   `fusion_or_composition`     — quelqu'un et ce dont il fait partie ;
 *   `disguise_or_impersonation` — quelqu'un qui se fait passer pour l'autre ;
 *   `decoy`                     — un rôle tenu un moment, un leurre ;
 *   `question_answer`           — une question et ce qui y répond ;
 *   `insufficient_data`         — les passages fournis ne tranchent pas.
 *
 * Un classement plutôt qu'une phrase, parce qu'un modèle à qui l'on demande
 * « est-ce juste ? » répond « oui » sur une identité fausse dont les deux noms
 * apparaissent côte à côte dans la même case. Le forcer à nommer la relation
 * qu'il voit change la question en une que le texte peut trancher.
 *
 * Ni `server-only`, ni base, ni fournisseur. Ce qui est décidé ici est la
 * lecture d'une réponse, et une règle qu'on ne peut exercer qu'au prix d'un
 * appel facturé est une règle que personne n'exerce.
 */
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { AuditFinding } from './audit.ts'
import { allowed, anchoredIn, verdictLines } from './verdicts.ts'

export const IDENTITY_VERDICTS = [
  'valid_identity',
  'group_member',
  'fusion_or_composition',
  'disguise_or_impersonation',
  'decoy',
  'question_answer',
  'insufficient_data',
] as const

export type IdentityVerdictKind = (typeof IDENTITY_VERDICTS)[number]

/** Un bout d'identité, tel que la lecture a besoin de le voir. */
export interface IdentitySide {
  entityId: string
  nodeType: string
  /** Le nom affiché, et les autres, avec le chapitre qui les donne. */
  names: Array<{ label: string; revealedInChapter: number | null }>
  firstSeenChapter: number
  /** Les appartenances acceptées de ce nœud, en clair : « membre de X ». */
  memberships: string[]
}

/** Une identité acceptée, avec tout ce qu'il faut pour la juger. */
export interface IdentityUnderReview {
  assertionId: string
  /** Le chapitre auquel le graphe date la révélation. */
  chapter: number
  subject: IdentitySide
  object: IdentitySide
  /** Ce que l'assertion cite, quand elle cite quelque chose. */
  excerpt: string | null
}

export interface IdentityVerdictRow {
  assertionId: string
  verdict: IdentityVerdictKind
  excerpt: string
  reason: string
}

export function bestName(side: IdentitySide): string {
  return side.names[0]?.label ?? 'nœud sans nom'
}

/**
 * La consigne, écrite pour être refusable.
 *
 * Elle dit, dans cet ordre : ce qu'une identité veut dire, ce qu'elle n'est
 * jamais, que le savoir extérieur ne compte pas, et que `insufficient_data` est
 * une réponse honnête. Le dernier point n'est pas une politesse — le défaut
 * d'un modèle à qui l'on tend une liste de catégories est d'en choisir une, et
 * une identité juste classée « leurre » se retire d'un clic.
 *
 * Aucun numéro de chapitre n'est demandé. Le graphe connaît la date de chaque
 * relation et de chaque passage ; une date recopiée par le modèle serait une
 * révélation posée à la mauvaise frontière.
 */
export function identityQuestion(identity: IdentityUnderReview): string {
  const left = bestName(identity.subject)
  const right = bestName(identity.object)

  return (
    `La bibliothèque affirme que « ${left} » et « ${right} » sont la même chose, ` +
    `à partir du chapitre ${identity.chapter}. Les passages ci-dessous viennent ` +
    `des chapitres autour de cette date.\n\n` +
    `Une identité veut dire que les deux nœuds désignent **réellement la même ` +
    `chose**. Ce n'est jamais :\n` +
    `  · un groupe et l'un de ses membres ;\n` +
    `  · un personnage et une fusion ou une composition dont il fait partie ;\n` +
    `  · quelqu'un qui se déguise en un autre, ou se fait passer pour lui ;\n` +
    `  · quelqu'un qui tient un rôle un moment, ou sert de leurre ;\n` +
    `  · une question et la personne ou la chose qui y répond.\n\n` +
    `Répondez sur une seule ligne, exactement dans cette forme :\n` +
    `${identity.assertionId} | verdict | la phrase d'un passage qui le prouve | pourquoi\n\n` +
    `Le verdict est l'un de ces mots, et rien d'autre : ` +
    `${IDENTITY_VERDICTS.join(', ')}.\n\n` +
    `La phrase doit être recopiée mot pour mot depuis l'un des passages fournis. ` +
    `Ne vous servez jamais de ce que vous savez de cette œuvre en dehors de ces ` +
    `passages. Si les passages ne tranchent pas, répondez « insufficient_data » : ` +
    `c'est une réponse honnête, et la plus utile quand elle est vraie.`
  )
}

/**
 * Les verdicts d'une réponse, ligne par ligne.
 *
 * Ce qui est refusé ici l'est une fois pour tout le monde : une ligne sans ses
 * champs, un identifiant que le modèle a formé plutôt que recopié, un mot qui
 * n'est pas l'un des verdicts, une identité jugée deux fois. Ce qui reste est
 * ancré ailleurs, par `identityVerdictFinding`, qui exige que la citation se
 * trouve vraiment dans les passages.
 */
export function parseIdentityVerdicts(
  text: string,
  allowedAssertionIds: readonly string[],
): IdentityVerdictRow[] {
  const permitted = allowed(allowedAssertionIds, (id) => id)
  const seen = new Set<string>()
  const rows: IdentityVerdictRow[] = []

  for (const [assertionId, verdict, excerpt, reason] of verdictLines(text, 4)) {
    if (!permitted.has(assertionId!) || seen.has(assertionId!)) continue

    const kind = IDENTITY_VERDICTS.find(
      (candidate) => candidate === (verdict ?? '').toLowerCase().replace(/[^a-z_]/g, ''),
    )
    if (kind === undefined) continue

    seen.add(assertionId!)
    rows.push({
      assertionId: assertionId!,
      verdict: kind,
      excerpt: (excerpt ?? '').trim(),
      reason: (reason ?? '').trim(),
    })
  }

  return rows
}

/** Ce que chaque verdict dit, en français, à qui lit le constat. */
const VERDICT_SAYS: Record<Exclude<IdentityVerdictKind, 'valid_identity' | 'insufficient_data'>, string> =
  {
    group_member:
      'un ensemble et l’un de ses membres. Le groupe disparaît derrière celui-ci, ' +
      'et les autres membres cessent d’exister pour le lecteur. Ce que le chapitre ' +
      'écrit ici est une appartenance.',
    fusion_or_composition:
      'quelqu’un et ce dont il n’est qu’une partie. Une fusion, un assemblage, un ' +
      'composé ne sont aucun de leurs composants : l’identité efface l’autre moitié.',
    disguise_or_impersonation:
      'quelqu’un qui se fait passer pour l’autre. Un déguisement est une chose que ' +
      'le récit montre, pas une révélation d’identité — et le confondre avec elle ' +
      'donne au lecteur la fin d’une intrigue au moment où elle commence.',
    decoy:
      'un rôle tenu un moment, ou un leurre. Celui qui porte le nom ne devient pas ' +
      'la personne : l’identité rendrait définitif ce que le chapitre suivant défait.',
    question_answer:
      'une question et ce qui y répond. La relation qui date cela est « résout le ' +
      'mystère », de la scène vers la question : elle date la réponse sans effacer ' +
      'ce qui a été demandé.',
  }

/**
 * Ce qu'un verdict a le droit d'écrire, en constat.
 *
 * Trois refus, et ils sont la raison d'être de cette fonction plutôt que d'un
 * `switch` chez l'appelant :
 *
 *   `insufficient_data` ne produit rien. C'est la réponse attendue, et en tirer
 *   un constat « à vérifier » remplirait la page de lignes que personne ne peut
 *   trancher.
 *
 *   `valid_identity` ne produit rien non plus : le graphe avait raison, et le
 *   dire coûterait un constat par identité juste.
 *
 *   Un verdict sans phrase citée dans les passages fournis ne produit rien.
 *   C'est un souvenir du modèle, et une identité retirée sur un souvenir est
 *   exactement ce que cette page existe pour ne pas faire.
 *
 * Ce qui passe porte le retrait, parce que les cinq verdicts restants disent la
 * même chose : ces deux nœuds ne sont pas la même chose. Retirer n'efface rien
 * — la ligne reste, datée, rejetée, et se rouvre en une requête —, et la
 * relation juste que le chapitre écrivait vraiment se pose sur la fiche.
 */
export function identityVerdictFinding(input: {
  row: IdentityVerdictRow
  identity: IdentityUnderReview
  passages: readonly string[]
}): AuditFinding | null {
  const { row, identity } = input
  if (row.verdict === 'insufficient_data' || row.verdict === 'valid_identity') return null
  if (!anchoredIn(row.excerpt, input.passages)) return null

  const left = bestName(identity.subject)
  const right = bestName(identity.object)

  return {
    kind: 'identite_douteuse',
    chapter: identity.chapter,
    title: `« ${left} » et « ${right} » : ${VERDICT_LABELS[row.verdict]}`,
    detail:
      `La bibliothèque les donne pour la même chose. La lecture y voit ` +
      `${VERDICT_SAYS[row.verdict]}` +
      (row.reason.length > 0 ? `\n\n${row.reason}` : '') +
      `\n\nLe chapitre dit : « ${row.excerpt} »`,
    subjectEntityId: identity.subject.entityId,
    objectEntityId: identity.object.entityId,
    fix: { action: 'retirer_identite', assertionId: identity.assertionId },
    fingerprint: `identite_douteuse|${identity.assertionId}|${row.verdict}`,
  }
}

/** Le mot du verdict, tel que le titre d'un constat l'annonce. */
export const VERDICT_LABELS: Record<IdentityVerdictKind, string> = {
  valid_identity: 'la même chose',
  group_member: 'un groupe et un membre',
  fusion_or_composition: 'une partie et son tout',
  disguise_or_impersonation: 'un déguisement',
  decoy: 'un leurre',
  question_answer: 'une question et sa réponse',
  insufficient_data: 'indécidable',
}

/**
 * Les identités qu'il vaut la peine de faire lire.
 *
 * Toutes, sauf celles dont une règle gratuite a déjà tranché : payer un appel
 * pour faire confirmer ce qu'un type de nœud établit serait payer deux fois la
 * même réponse. La liste est rendue dans l'ordre des chapitres pour que la
 * lecture d'une bibliothèque interrompue reprenne au début de l'histoire, ce
 * qui est aussi l'ordre dans lequel un lecteur voudra corriger.
 */
export function identitiesWorthReading(
  identities: readonly IdentityUnderReview[],
  settledAssertionIds: ReadonlySet<string>,
): IdentityUnderReview[] {
  return identities
    .filter((identity) => !settledAssertionIds.has(identity.assertionId))
    .sort((a, b) => a.chapter - b.chapter || a.assertionId.localeCompare(b.assertionId))
}

/**
 * Les passages qu'une identité mérite, sans en payer mille.
 *
 * Autour du chapitre qui la date, parce que c'est là que le texte l'établit ou
 * la contredit : une révélation se lit dans le chapitre qui la fait, et la
 * fenêtre étroite est ce qui rend cette lecture payable sur une bibliothèque de
 * mille chapitres.
 */
export const IDENTITY_WINDOW = 2

export function passagesAround<T extends { chapter: number }>(
  passages: readonly T[],
  chapter: number,
  window = IDENTITY_WINDOW,
): T[] {
  return passages.filter(
    (passage) => passage.chapter >= chapter - window && passage.chapter <= chapter + window,
  )
}

/**
 * Ce que le modèle a reçu, sous une forme comparable d'une passe à l'autre.
 *
 * L'empreinte d'une identité est faite de ce qui peut changer son verdict : les
 * deux noms, les deux types, la date, les appartenances connues, et le texte
 * des passages. Renommer une fiche ou publier le chapitre voisin redonne donc
 * l'identité à lire ; relancer la page ne change rien et ne coûte rien.
 */
export function identityInputs(
  identity: IdentityUnderReview,
  passages: readonly string[],
): string[] {
  return [
    identity.assertionId,
    String(identity.chapter),
    sideInputs(identity.subject),
    sideInputs(identity.object),
    ...passages.map((passage) => normalizeText(passage)),
  ]
}

function sideInputs(side: IdentitySide): string {
  return [
    side.nodeType,
    String(side.firstSeenChapter),
    ...side.names.map((name) => `${normalizeText(name.label)}@${name.revealedInChapter ?? '-'}`),
    ...[...side.memberships].sort(),
  ].join('/')
}
