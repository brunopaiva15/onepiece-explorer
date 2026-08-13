import type { OccurrenceKind } from './ontology.ts'

/**
 * Which sort of occurrence a scene is, when nobody said.
 *
 * The extraction states it now (`kind` on a candidate event), and what the
 * model reading the passage says always wins — a fight and a departure are both
 * « quelque chose qui arrive », and no property of a stored proposal can
 * separate them after the fact. This file is for the scenes where that answer
 * does not exist: everything published before the field did, and any proposal
 * queued before this version that is published after it.
 *
 * So it is a guess, and it is the only guess in this system that is allowed to
 * reach the graph without being asked about. That deserves its reasons stated
 * rather than assumed:
 *
 *   • It cannot cause a spoiler. It changes a node's *type*, never what is
 *     said, never when it becomes visible, never who is connected to whom. The
 *     rule the review queue protects — nothing enters the graph without a human
 *     — was satisfied when the scene itself was accepted; this only re-reads
 *     what was accepted.
 *   • It is reversible, and one statement undoes it (see migration 0022).
 *   • The alternative is not "ask the user": it is leaving a library of ten
 *     chapters with an empty « Combat » filter forever, or making them
 *     re-import and re-review work they have already reviewed. Both are worse
 *     than a scene occasionally left as an ordinary event.
 *
 * Hence the asymmetry in the vocabulary below: it is tuned to under-classify.
 * A combat missed reads as an ordinary event, which is what it was yesterday
 * and costs nothing. A quiet scene promoted to « Combat » is a wrong statement
 * about the story, in red, on the graph. Only words that leave no doubt.
 */

/**
 * Fragments that mean a fight, as POSIX alternatives.
 *
 * Written unaccented and matched against folded text, so « affronté » and
 * « affronte » are one entry rather than two to keep in step.
 *
 * Deliberately absent, and each for a reason found in real summaries:
 * « frappe » (« Luffy le frappe de colère » is an outburst, not a fight),
 * « tue » (« arrêté pour avoir tué le loup » is a revelation about a past act),
 * « terrasse » and « tranche » (both are ordinary nouns in French), « sauve »
 * (« Shanks sauve Luffy du Seigneur de la Côte » — nobody fights).
 */
export const BATTLE_WORDS: readonly string[] = [
  'affront(e|es|ent|er|ement|ements)',
  'combat(s|tre|tent|tant|tants)?',
  'duel(s)?',
  'bat(s|tent|tre|tu|tue|tus|tues|tait|taient)?',
  'vainc(u|ue|us|ues|re|ent)?',
  'vainqueur(s)?',
  'neutralis(e|es|ent|er)',
  'assomm(e|es|ent|er)',
  // `ee` before `es`, and both spelled out: folding « attaquée » to
  // « attaquee » is what makes one entry cover the accented forms, and the
  // fold is no use if the unaccented spelling it produces is not in the list.
  'attaqu(e|ee|es|ees|ent|er|ant)',
  'contre-attaqu(e|es|ent)',
  'ripost(e|es|ent|er)',
  'degain(e|es|ent|er)',
  'coups? de poing',
  'coups? de pied',
]

/**
 * The whole pattern, in the one dialect both readers speak.
 *
 * PostgreSQL's `\y` and JavaScript's `\b` are the same assertion under
 * different names, and the alternation between them is identical — which is
 * what lets migration 0022 and `classifyOccurrence` below agree by
 * construction rather than by two people remembering to edit both. A test
 * reads the pattern back out of the migration file and compares it to this.
 *
 * The boundaries are the load-bearing part. Without them « bat » matches
 * « bateau », and every scene involving a boat — in this work, most of them —
 * would be filed as a combat.
 */
export function battlePattern(): string {
  return `(${BATTLE_WORDS.join('|')})`
}

/**
 * Lower-cased and stripped of the accents the pattern does not carry.
 *
 * The same folding on both sides: `translate()` in SQL, this here. Only the
 * accented letters French actually uses — a fuller Unicode normalisation would
 * be a different function on each side, and the point is that they are not.
 */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[àâä]/g, 'a')
    .replaceAll(/[éèêë]/g, 'e')
    .replaceAll(/[îï]/g, 'i')
    .replaceAll(/[ôö]/g, 'o')
    .replaceAll(/[ùûü]/g, 'u')
    .replaceAll(/ç/g, 'c')
}

/**
 * A scene's kind, read from its own words.
 *
 * Never returns `voyage`. A departure has no vocabulary that a chapter of
 * seafaring does not use constantly — « prend la mer », « quitte », « arrive »
 * describe the setting as often as the scene — so there is no conservative
 * list to write, and a bad guess would file half the work as a voyage. New
 * chapters get voyages because the model is asked; old ones do without, which
 * is what they had.
 */
export function classifyOccurrence(summary: string): OccurrenceKind {
  const pattern = new RegExp(`\\b${battlePattern()}\\b`, 'u')
  return pattern.test(fold(summary)) ? 'battle' : 'event'
}
