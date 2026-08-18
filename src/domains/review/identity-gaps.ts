/**
 * Les identités que le texte révèle et que le graphe n'a jamais écrites.
 *
 * Le balayage d'identités voisin part des **figures sans nom** : il prend une
 * désignation provisoire et cherche, dans les quinze chapitres suivants, le nom
 * qui la démasque. C'est le bon chemin pour « Homme mystérieux debout sur
 * l'eau », et il ne voit rien de la moitié des révélations que fait une œuvre —
 * celles où les deux bouts portent déjà un nom. « Mr Prince » est un nom ;
 * « Miss All Sunday » est un nom ; aucun des deux n'est une figure sans nom, et
 * la phrase qui dit lequel des personnages connus se cache derrière passe donc
 * sans que rien ne la lise.
 *
 * Ce module lit le mouvement inverse : partir des **passages**, y chercher une
 * révélation explicite, et la comparer au graphe.
 *
 *   « X est en réalité Y » ;
 *   « son véritable nom est Y » ;
 *   « X, qui se faisait appeler Y » ;
 *   « il l'appelle par son vrai nom : Y ».
 *
 * Ce qu'il faut distinguer, et c'est toute la difficulté : une révélation d'un
 * déguisement, d'une imitation, d'un leurre. « Sanji se fait appeler Mr Prince »
 * est une révélation — c'est bien lui, sous un nom qu'il s'est donné. « Untel
 * se déguise en marine » n'en est pas une, et écrire l'identité ferait de deux
 * personnes une seule pour le reste de l'œuvre.
 *
 * **Rien n'est publié.** Une identité est le seul jugement que l'ontologie place
 * en revue humaine obligatoire, parce qu'une fusion fausse détruit la
 * chronologie des révélations que tout ce système existe pour tenir. Ce qui sort
 * d'ici est une carte de revue — la même que le balayage écrit — et un humain
 * l'accepte ou la rejette devant les deux fiches et la phrase.
 *
 * Ni `server-only`, ni base, ni fournisseur : les trois refus qui comptent sont
 * des règles sur du texte, et se testent comme telles.
 */
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { AuditFinding } from './audit.ts'
import { allowed, quotedFrom, verdictLines } from './verdicts.ts'

export const GAP_VERDICTS = [
  'revealed_identity',
  'alias',
  'disguise_or_impersonation',
  'decoy',
  'insufficient_data',
] as const

export type GapVerdictKind = (typeof GAP_VERDICTS)[number]

/** Un nœud que la révélation peut nommer. */
export interface GapCandidate {
  entityId: string
  label: string
  nodeType: string
  firstSeenChapter: number
  /** Quand son nom devient lisible. Le graphe le sait ; le modèle ne le dira pas. */
  revealedInChapter: number | null
}

/** Un passage offert à la lecture, avec la référence que la publication résout. */
export interface GapPassage {
  id: string
  ref: string
  chapter: number
  text: string
}

export interface GapRow {
  leftEntityId: string
  rightEntityId: string
  verdict: GapVerdictKind
  passageId: string
  excerpt: string
  reason: string
}

/**
 * La consigne.
 *
 * Elle nomme les quatre formes de révélation qu'on cherche, puis les trois
 * choses qui leur ressemblent et n'en sont pas. L'ordre compte : un modèle à
 * qui l'on décrit d'abord ce qu'il faut trouver trouve des déguisements ; à qui
 * l'on décrit d'abord ce qu'il faut écarter ne trouve plus rien.
 *
 * Aucun chapitre demandé, jamais. Le modèle cite un passage, le code lit la
 * date du passage : une révélation datée par le modèle serait posée à la
 * mauvaise frontière, c'est-à-dire un spoiler avec une note de bas de page.
 */
export function gapQuestion(chapter: number): string {
  return (
    `Voici des passages du chapitre ${chapter} et des chapitres voisins, puis les ` +
    `fiches que la bibliothèque connaît déjà. La question est : l'un de ces ` +
    `passages révèle-t-il que deux de ces fiches sont la même chose ?\n\n` +
    `Une révélation d'identité ressemble à ceci : « X est en réalité Y », « son ` +
    `véritable nom est Y », « X, qui se faisait appeler Y », « il l'appelle par ` +
    `son vrai nom, Y ».\n\n` +
    `Ce n'en est pas une, et il faut le dire plutôt que de se taire :\n` +
    `  · un déguisement, ou quelqu'un qui se fait passer pour un autre ` +
    `(disguise_or_impersonation) ;\n` +
    `  · un rôle tenu un moment, un leurre (decoy).\n\n` +
    `Une ligne par rapprochement, exactement dans cette forme :\n` +
    `identifiant de la première fiche | identifiant de la seconde | verdict | ` +
    `identifiant du passage | la phrase du passage qui le prouve | pourquoi\n\n` +
    `Le verdict est l'un de ces mots : ${GAP_VERDICTS.join(', ')}.\n\n` +
    `Les deux identifiants de fiches doivent être recopiés depuis la liste ` +
    `fournie, jamais formés. La phrase doit être recopiée mot pour mot depuis le ` +
    `passage cité. N'indiquez aucun numéro de chapitre : le passage porte sa ` +
    `date. Ne vous servez jamais de ce que vous savez de cette œuvre en dehors de ` +
    `ces passages. Si aucun passage ne révèle d'identité, répondez ` +
    `« insufficient_data » et rien d'autre : c'est la réponse la plus fréquente.`
  )
}

/**
 * Les rapprochements d'une réponse, ligne par ligne.
 *
 * Les deux identifiants sont cherchés dans la liste des fiches proposées, et le
 * passage dans celle des passages : trois listes, trois refus, et un modèle qui
 * forme un identifiant plausible n'écrit rien. Une même paire n'est retenue
 * qu'une fois, dans l'ordre où elle a été donnée.
 */
export function parseIdentityGaps(
  text: string,
  candidateIds: readonly string[],
  passageIds: readonly string[],
): GapRow[] {
  const entities = allowed(candidateIds, (id) => id)
  const passages = allowed(passageIds, (id) => id)
  const seen = new Set<string>()
  const rows: GapRow[] = []

  for (const [left, right, verdict, passageId, rest] of verdictLines(text, 5)) {
    if (!entities.has(left!) || !entities.has(right!)) continue
    if (left === right) continue
    if (!passages.has(passageId!)) continue

    const kind = GAP_VERDICTS.find(
      (candidate) => candidate === (verdict ?? '').toLowerCase().replace(/[^a-z_]/g, ''),
    )
    if (kind === undefined) continue

    const pair = [left!, right!].sort().join('|')
    if (seen.has(pair)) continue
    seen.add(pair)

    /*
     * La citation et la raison partagent le dernier champ.
     *
     * Le format en demande six, et un modèle en rend cinq une fois sur dix — la
     * raison collée à la citation, ou omise. Couper sur la première barre
     * restante donne la citation seule quand les deux sont là, et la citation
     * entière quand la raison manque ; dans les deux cas ce qui part à
     * l'ancrage est ce que le modèle a présenté comme la phrase du chapitre.
     */
    const [excerpt, ...reason] = (rest ?? '').split('|')

    rows.push({
      leftEntityId: left!,
      rightEntityId: right!,
      verdict: kind,
      passageId: passageId!,
      excerpt: (excerpt ?? '').trim(),
      reason: reason.join('|').trim(),
    })
  }

  return rows
}

export interface GapFinding {
  finding: AuditFinding
  /** Ce que la carte de revue portera, si l'utilisateur la demande. */
  chapter: number
}

/**
 * Ce qu'un rapprochement a le droit de proposer.
 *
 * Cinq refus, et chacun a coûté quelque chose quelque part :
 *
 *   un verdict qui n'est pas une révélation — un déguisement écrit comme une
 *   identité fait de deux personnes une seule pour le reste de l'œuvre ;
 *
 *   une paire que le graphe relie déjà — la carte serait refusée à la
 *   publication, des jours plus tard, dans un lot de vingt autres ;
 *
 *   un passage que le modèle n'a pas reçu ;
 *
 *   une citation qui n'est pas dans ce passage, mot pour mot ;
 *
 *   une fiche citée deux fois pour elle-même.
 *
 * La date est le plus tard de trois — le passage qui l'établit, et ce que
 * chacun des deux bouts demande pour être lisible. C'est la règle du balayage
 * voisin, et pour la même raison : une identité ne peut pas précéder l'un de
 * ses bouts, sinon elle rapproche pour le lecteur deux choses dont il n'en
 * connaît qu'une.
 */
export function identityGapFinding(input: {
  row: GapRow
  candidates: readonly GapCandidate[]
  passages: readonly GapPassage[]
  /** Les paires que le graphe relie déjà, sous la forme `min|max`. */
  joined: ReadonlySet<string>
}): GapFinding | null {
  const { row } = input
  if (row.verdict !== 'revealed_identity' && row.verdict !== 'alias') return null

  const byEntity = allowed(input.candidates, (candidate) => candidate.entityId)
  const left = byEntity.get(row.leftEntityId)
  const right = byEntity.get(row.rightEntityId)
  if (!left || !right || left.entityId === right.entityId) return null

  if (input.joined.has([left.entityId, right.entityId].sort().join('|'))) return null

  const passage = input.passages.find((candidate) => candidate.id === row.passageId)
  if (!passage) return null
  if (quotedFrom(row.excerpt, [passage]) === null) return null

  const chapter = Math.max(passage.chapter, readableFrom(left), readableFrom(right))

  const note =
    `Le chapitre ${passage.chapter} donne « ${left.label} » pour « ${right.label} » : ` +
    `« ${row.excerpt.trim()} »`

  return {
    chapter,
    finding: {
      kind: 'identite_manquante',
      chapter,
      title: `« ${left.label} » serait « ${right.label} », et rien ne les relie`,
      detail:
        `Le texte du chapitre ${passage.chapter} les donne pour la même chose, et ` +
        `le graphe les raconte comme deux. ` +
        (row.reason.length > 0 ? `${row.reason} ` : '') +
        `\n\nLe chapitre dit : « ${row.excerpt.trim()} »` +
        `\n\nRien n'est publié d'ici : le geste dépose une carte dans le centre de ` +
        `revue, avec cette phrase, et l'identité ne devient un fait que si vous ` +
        `l'acceptez.`,
      subjectEntityId: left.entityId,
      objectEntityId: right.entityId,
      fix: {
        action: 'proposer_identite',
        subjectEntityId: left.entityId,
        objectEntityId: right.entityId,
        chapter,
        ref: passage.ref,
        excerpt: row.excerpt.trim(),
        note,
      },
      fingerprint: `identite_manquante|${[left.entityId, right.entityId].sort().join('|')}`,
    },
  }
}

/** À partir de quel chapitre cette fiche est lisible : entrée en scène ou nom. */
function readableFrom(candidate: GapCandidate): number {
  return Math.max(candidate.firstSeenChapter, candidate.revealedInChapter ?? 0)
}

/** L'empreinte de ce qu'un chapitre a donné à lire, pour la reprise. */
export function gapInputs(
  passages: readonly GapPassage[],
  candidates: readonly GapCandidate[],
): string[] {
  return [
    ...passages.map((passage) => `${passage.id}:${normalizeText(passage.text)}`),
    ...candidates
      .map((candidate) => `${candidate.entityId}:${normalizeText(candidate.label)}`)
      .sort(),
  ]
}
