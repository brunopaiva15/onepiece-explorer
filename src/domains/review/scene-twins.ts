/**
 * Deux scènes vraies, dans le même chapitre, qui racontent la même chose.
 *
 * `sameBeat` en replie déjà une partie, gratuitement, et c'est le bon premier
 * filtre : il compare des mots et ne se trompe pas dans le sens qui coûte cher.
 * Son seuil est posé là où un repliement faux est impossible — 70 % du
 * vocabulaire de la plus courte, et aucun nom exclusif de part et d'autre —
 * précisément parce qu'il *écrit* : ce qu'il replie, personne ne le relit.
 *
 * Ce que ce seuil laisse passer est ce que deux passages du pipeline sur un
 * même chapitre produisent quand ils ne se contentent pas de rallonger la même
 * phrase mais la reformulent :
 *
 *   « Nami dérobe la carte de Grand Line dans le repaire de Baggy. »
 *   « La voleuse s'empare du plan de Grand Line caché chez les pirates. »
 *
 * Deux phrases vraies, une scène, et pas assez de mots communs pour qu'un
 * repliement automatique soit sûr. La bande entre « manifestement la même » et
 * « manifestement pas » est exactement ce qu'une seconde lecture, payée, a
 * quelque chose à apporter — et le seuil gratuit ne bouge pas d'un point pour
 * l'atteindre, parce qu'un seuil abaissé replie sans qu'on le lui demande.
 *
 * Quatre réponses possibles, et trois d'entre elles sont des refus :
 *
 *   `same_scene`        — la même scène, reformulée ;
 *   `distinct_steps`    — deux étapes d'une même séquence ;
 *   `recall_or_flashback` — un rappel, un souvenir, une redite volontaire ;
 *   `insufficient_data` — les passages ne tranchent pas.
 *
 * Ni `server-only`, ni base, ni fournisseur.
 */
import { beatOverlap, sameBeat } from '@/domains/knowledge/beats.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { AuditEvent, AuditFinding } from './audit.ts'
import { allowed, anchoredIn, verdictLines } from './verdicts.ts'

export const TWIN_VERDICTS = [
  'same_scene',
  'distinct_steps',
  'recall_or_flashback',
  'insufficient_data',
] as const

export type TwinVerdictKind = (typeof TWIN_VERDICTS)[number]

/**
 * Ce qu'il faut partager pour mériter d'être lu.
 *
 * Sous le seuil de `sameBeat` et loin au-dessus de zéro. Trois mots de contenu
 * communs et un tiers du vocabulaire de la plus courte : c'est ce qui distingue
 * deux formulations d'un même fait de deux scènes qui parlent du même
 * personnage. Le prix d'un seuil trop bas n'est pas une erreur — le modèle
 * répondrait `distinct_steps` — mais un appel payé pour rien, et un chapitre de
 * quarante scènes en offre huit cents paires.
 */
const CANDIDATE_MIN_SHARED = 3
const CANDIDATE_MIN_RATIO = 0.34

/** Combien de paires un chapitre soumet au plus, les plus proches d'abord. */
export const PAIRS_PER_CHAPTER = 12

export interface TwinPair {
  left: AuditEvent
  right: AuditEvent
  shared: number
  ratio: number
}

/**
 * Les paires d'un chapitre qui valent une lecture.
 *
 * Le même chapitre et jamais deux, pour la raison qui vaut chez `sameBeat` :
 * une scène redite au chapitre suivant est un souvenir, c'est-à-dire une vraie
 * perle du fil. Et jamais une paire que le filtre gratuit replie déjà — elle
 * est décidée, et la relire serait payer une seconde fois la même réponse.
 */
export function twinCandidates(
  events: readonly AuditEvent[],
  limit = PAIRS_PER_CHAPTER,
): TwinPair[] {
  const byChapter = new Map<number, AuditEvent[]>()
  for (const event of events) {
    const group = byChapter.get(event.chapter)
    if (group) group.push(event)
    else byChapter.set(event.chapter, [event])
  }

  const pairs: TwinPair[] = []

  for (const group of byChapter.values()) {
    const ordered = [...group].sort((a, b) => a.createdAt - b.createdAt)

    for (const [index, left] of ordered.entries()) {
      for (const right of ordered.slice(index + 1)) {
        if (sameBeat(left.summary, right.summary)) continue

        const overlap = beatOverlap(left.summary, right.summary)
        if (overlap.shared < CANDIDATE_MIN_SHARED) continue
        if (overlap.ratio < CANDIDATE_MIN_RATIO) continue

        pairs.push({ left, right, shared: overlap.shared, ratio: overlap.ratio })
      }
    }
  }

  return pairs.sort((a, b) => b.ratio - a.ratio || b.shared - a.shared).slice(0, limit)
}

export interface TwinRow {
  leftEntityId: string
  rightEntityId: string
  verdict: TwinVerdictKind
  excerpt: string
  reason: string
}

/**
 * La consigne.
 *
 * Elle nomme les trois façons dont deux phrases proches ne sont pas la même
 * scène avant de nommer la seule où elles le sont : un modèle à qui l'on
 * demande « est-ce la même ? » répond oui sur deux étapes d'un même combat,
 * parce qu'elles se ressemblent. La question posée est donc « laquelle de ces
 * quatre situations », ce que le texte peut trancher.
 */
export function twinQuestion(chapter: number): string {
  return (
    `Voici des paires de scènes que la bibliothèque raconte du chapitre ` +
    `${chapter}, puis les passages de ce chapitre. Pour chaque paire, la ` +
    `question est : est-ce la même scène racontée deux fois ?\n\n` +
    `Répondez pour chaque paire par l'un de ces mots :\n` +
    `  · same_scene — la même scène, reformulée autrement ;\n` +
    `  · distinct_steps — deux étapes distinctes d'une même séquence ;\n` +
    `  · recall_or_flashback — l'une rappelle ou revoit ce que l'autre montre ;\n` +
    `  · insufficient_data — les passages ne permettent pas de trancher.\n\n` +
    `Une ligne par paire, exactement dans cette forme :\n` +
    `identifiant de la première scène | identifiant de la seconde | verdict | ` +
    `la phrase du chapitre qui le prouve | pourquoi\n\n` +
    `Les deux identifiants doivent être recopiés depuis la liste fournie. La ` +
    `phrase doit être recopiée mot pour mot depuis un passage. Ne vous servez ` +
    `jamais de ce que vous savez de cette œuvre en dehors de ces passages. Si ` +
    `aucune paire n'est un doublon, répondez « insufficient_data » et rien ` +
    `d'autre.`
  )
}

/**
 * Les verdicts d'une réponse, ligne par ligne.
 *
 * La paire doit être l'une de celles qui ont été proposées, dans un sens ou
 * dans l'autre : un modèle qui rapproche deux scènes qu'on ne lui a pas données
 * ensemble a formé la paire, et une paire formée est une paire que le filtre
 * gratuit n'a pas mesurée.
 */
export function parseTwinVerdicts(text: string, pairs: readonly TwinPair[]): TwinRow[] {
  const offered = allowed(pairs, (pair) => pairKey(pair.left.entityId, pair.right.entityId))
  const seen = new Set<string>()
  const rows: TwinRow[] = []

  for (const [left, right, verdict, excerpt, reason] of verdictLines(text, 5)) {
    const key = pairKey(left!, right!)
    if (!offered.has(key) || seen.has(key)) continue

    const kind = TWIN_VERDICTS.find(
      (candidate) => candidate === (verdict ?? '').toLowerCase().replace(/[^a-z_]/g, ''),
    )
    if (kind === undefined) continue

    seen.add(key)
    rows.push({
      leftEntityId: left!,
      rightEntityId: right!,
      verdict: kind,
      excerpt: (excerpt ?? '').trim(),
      reason: (reason ?? '').trim(),
    })
  }

  return rows
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

/**
 * Ce qu'un doublon confirmé a le droit de proposer.
 *
 * Celle qu'on garde est la plus complète, et non la première : deux passages du
 * pipeline sur un même chapitre produisent une phrase courte et une phrase
 * détaillée, et c'est la détaillée qui porte ce que le chapitre dit. C'est la
 * règle du filtre gratuit, reprise telle quelle — deux façons de choisir
 * laquelle survit donneraient au lecteur deux fils différents selon que le
 * doublon a été trouvé gratuitement ou non.
 *
 * Sans phrase citée dans le chapitre, rien. Un doublon rejette un nœud du fil ;
 * le faire sur un souvenir du modèle est précisément le geste que cette page ne
 * peut pas se permettre.
 */
export function twinFinding(input: {
  row: TwinRow
  pairs: readonly TwinPair[]
  passages: readonly string[]
}): AuditFinding | null {
  const { row } = input
  if (row.verdict !== 'same_scene') return null
  if (!anchoredIn(row.excerpt, input.passages)) return null

  const pair = input.pairs.find(
    (candidate) =>
      pairKey(candidate.left.entityId, candidate.right.entityId) ===
      pairKey(row.leftEntityId, row.rightEntityId),
  )
  if (!pair) return null
  if (pair.left.chapter !== pair.right.chapter) return null

  const kept =
    pair.right.summary.length > pair.left.summary.length ? pair.right : pair.left
  const dropped = kept === pair.left ? pair.right : pair.left

  return {
    kind: 'scene_redite',
    chapter: kept.chapter,
    title: `Une scène racontée deux fois autrement au chapitre ${kept.chapter}`,
    detail:
      `« ${dropped.summary} » redit « ${kept.summary} », sans partager assez de ` +
      `mots pour que la règle gratuite ose les replier. ` +
      (row.reason.length > 0 ? `${row.reason} ` : '') +
      `\n\nLe chapitre dit : « ${row.excerpt} »` +
      `\n\nLa formulation la plus complète est gardée, l'autre cesse d'être lue.`,
    subjectEntityId: dropped.entityId,
    objectEntityId: kept.entityId,
    fix: {
      action: 'rejeter_entite',
      entityId: dropped.entityId,
      because: `Doublon sémantique de la scène « ${kept.summary} » (chapitre ${kept.chapter}).`,
    },
    fingerprint: `scene_redite|${pairKey(dropped.entityId, kept.entityId)}`,
  }
}

/** L'empreinte de ce qu'un chapitre a donné à lire, pour la reprise. */
export function twinInputs(pairs: readonly TwinPair[], passages: readonly string[]): string[] {
  return [
    ...pairs.map(
      (pair) =>
        `${pairKey(pair.left.entityId, pair.right.entityId)}:` +
        `${normalizeText(pair.left.summary)}/${normalizeText(pair.right.summary)}`,
    ),
    ...passages.map((passage) => normalizeText(passage)),
  ]
}
