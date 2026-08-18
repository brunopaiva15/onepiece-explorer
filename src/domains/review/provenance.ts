/**
 * Ce qui vient du récit, et ce qui vient d'à côté.
 *
 * Une couverture de chapitre raconte sa propre histoire — une mini-série de
 * quelques cases, poursuivie sur des mois, à côté du récit principal. Une page
 * bonus fait de même. Les deux sont vraies et datées, et aucune ne se passe
 * dans le chapitre : rangées dans la chronologie principale, elles font
 * apparaître quelqu'un que le récit avait laissé ailleurs, et le lecteur croit
 * avoir manqué une page.
 *
 * La règle gratuite voisine tranche cela sans rien payer quand le graphe porte
 * la provenance : `pages.kind` vaut `cover` ou `bonus`, `evidence.kind` vaut
 * `cover`, et une scène dont *toutes* les preuves viennent de là est signalée.
 * Elle se tait sur ce qui n'a pas de provenance structurée — un chapitre importé
 * en résumé n'a ni pages ni blocs, et rien à lire.
 *
 * C'est cette moitié-là que ce module examine, et il le fait à voix basse. Ce
 * qu'un modèle peut voir dans un texte de résumé est une **mention explicite** :
 * « en couverture », « dans la mini-aventure de », « pendant ce temps, sur la
 * couverture ». Il ne peut pas savoir qu'une scène est une couverture parce
 * qu'il connaît l'œuvre — et la consigne le lui interdit, parce que ce savoir-là
 * n'est pas dans la bibliothèque du lecteur et n'a pas à décider de ce qu'elle
 * montre.
 *
 * Donc : jamais de correction automatique. Un soupçon dit où regarder, cite la
 * phrase qui le motive, et s'arrête là.
 */
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { AuditFinding } from './audit.ts'
import { allowed, anchoredIn, verdictLines } from './verdicts.ts'

export const PROVENANCE_VERDICTS = [
  'cover_or_bonus',
  'main_story',
  'insufficient_data',
] as const

export type ProvenanceVerdictKind = (typeof PROVENANCE_VERDICTS)[number]

export interface ProvenanceRow {
  entityId: string
  verdict: ProvenanceVerdictKind
  excerpt: string
  reason: string
}

/**
 * La consigne.
 *
 * Deux interdits explicites, et le second est celui qui compte. Le premier dit
 * de ne rien signaler sans une phrase du texte ; le second dit que la
 * connaissance de l'œuvre ne vaut pas preuve — un modèle qui sait qu'une
 * mini-aventure occupe les couvertures d'un arc entier signalerait quarante
 * scènes justes, chacune avec l'aplomb d'une lecture.
 */
export function provenanceQuestion(chapter: number): string {
  return (
    `Voici les scènes que la bibliothèque raconte du chapitre ${chapter}, puis le ` +
    `texte de ce chapitre. Ce chapitre a été importé sans pages ni cases : la ` +
    `bibliothèque ne sait pas d'où vient chaque scène.\n\n` +
    `La question est : le texte dit-il explicitement que l'une de ces scènes se ` +
    `passe **en couverture**, dans une mini-aventure, ou sur une page bonus — ` +
    `c'est-à-dire à côté du récit principal ?\n\n` +
    `Une ligne par scène concernée, exactement dans cette forme :\n` +
    `identifiant de la scène | verdict | la phrase du texte qui le dit | pourquoi\n\n` +
    `Le verdict est l'un de ces mots : ${PROVENANCE_VERDICTS.join(', ')}.\n\n` +
    `La phrase doit être recopiée mot pour mot depuis le texte fourni. Ne vous ` +
    `servez jamais de ce que vous savez de cette œuvre : que vous sachiez qu'une ` +
    `mini-aventure occupe les couvertures de cet arc ne prouve rien sur ces ` +
    `scènes-ci. Sans une phrase qui le dit, répondez « insufficient_data » — ` +
    `c'est la réponse la plus fréquente et la plus utile.`
  )
}

export function parseProvenanceVerdicts(
  text: string,
  allowedEntityIds: readonly string[],
): ProvenanceRow[] {
  const permitted = allowed(allowedEntityIds, (id) => id)
  const seen = new Set<string>()
  const rows: ProvenanceRow[] = []

  for (const [entityId, verdict, excerpt, reason] of verdictLines(text, 4)) {
    if (!permitted.has(entityId!) || seen.has(entityId!)) continue

    const kind = PROVENANCE_VERDICTS.find(
      (candidate) => candidate === (verdict ?? '').toLowerCase().replace(/[^a-z_]/g, ''),
    )
    if (kind === undefined) continue

    seen.add(entityId!)
    rows.push({
      entityId: entityId!,
      verdict: kind,
      excerpt: (excerpt ?? '').trim(),
      reason: (reason ?? '').trim(),
    })
  }

  return rows
}

/**
 * Un soupçon, et jamais plus que cela.
 *
 * `fix: null` sans condition. La règle gratuite propose déjà de ne rien faire
 * quand la provenance est structurée — parce qu'il n'existe pas encore, dans ce
 * graphe, de geste pour dire « cette scène est à côté du récit ». Ici la
 * provenance n'est même pas connue : le constat dit où regarder, cite ce qui l'a
 * fait naître, et la décision se prend devant le chapitre.
 */
export function provenanceFinding(input: {
  row: ProvenanceRow
  chapter: number
  summary: string
  passages: readonly string[]
}): AuditFinding | null {
  const { row } = input
  if (row.verdict !== 'cover_or_bonus') return null
  if (!anchoredIn(row.excerpt, input.passages)) return null

  return {
    kind: 'scene_hors_recit_soupcon',
    chapter: input.chapter,
    title: `Une scène du chapitre ${input.chapter} se passerait en couverture`,
    detail:
      `« ${input.summary} » est racontée dans la chronologie principale. Le texte ` +
      `du chapitre la présente comme se déroulant à côté du récit. ` +
      (row.reason.length > 0 ? `${row.reason} ` : '') +
      `\n\nLe chapitre dit : « ${row.excerpt} »` +
      `\n\nCe chapitre a été importé sans pages : la bibliothèque n'a pas de ` +
      `provenance à vérifier, et rien n'est proposé. C'est un endroit où regarder, ` +
      `pas une correction.`,
    subjectEntityId: row.entityId,
    objectEntityId: null,
    fix: null,
    fingerprint: `scene_hors_recit_soupcon|${row.entityId}`,
  }
}

/** L'empreinte de ce qu'un chapitre a donné à lire, pour la reprise. */
export function provenanceInputs(
  scenes: ReadonlyArray<{ entityId: string; summary: string }>,
  passages: readonly string[],
): string[] {
  return [
    ...scenes.map((scene) => `${scene.entityId}:${normalizeText(scene.summary)}`),
    ...passages.map((passage) => normalizeText(passage)),
  ]
}
