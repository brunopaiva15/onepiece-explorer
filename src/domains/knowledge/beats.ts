import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { tokens } from '@/domains/resolution/scoring.ts'

/**
 * When two sentences are the same beat.
 *
 * Events are the one thing in this graph with no stable identity to compare. An
 * entity has the wording it quotes, a relation has its predicate and its two
 * ends; an event is a sentence the model *composed*, and it composes it
 * differently every time it reads the scene — « Le Seigneur de la Côte dévore
 * Higuma et son bateau » in one slice, « Le Seigneur de la Côte avale Higuma »
 * in the next, and « Luffy et Koby prennent la mer ensemble, Koby lui parlant de
 * Zoro » against « Luffy et Koby prennent la mer ensemble ; Koby parle de Zoro à
 * Luffy » across two processings of the same chapter. Exact equality fires on
 * none of those.
 *
 * This lives on its own rather than inside `review/duplicates.ts` because three
 * places now need the same answer and must not each have their own: the review
 * centre grouping a run's proposals, the publication guard, and the reader's
 * thread, which is where a scene stored twice finally becomes visible. Two
 * spellings of « the same beat » is how a card says « copie 2 sur 2 » about a
 * pair the thread then tells twice.
 *
 * It compares content words and nothing else. It cannot tell « une petite
 * embarcation » from « un petit canot », and it is not supposed to: a threshold
 * loose enough to catch that would fold « Luffy frappe Alvida » onto « Luffy
 * frappe Morgan », and hiding a real beat is worse than showing a retelling.
 */

/**
 * How much two summaries have to share.
 *
 * The overlap coefficient rather than Jaccard, because one summary is often the
 * other plus a clause, and a length difference should not hide a match. Two
 * shared words minimum, so a pair of terse summaries cannot match on a single
 * name — « Zoro affronte Morgan » and « Zoro promet à Koby » share one word and
 * are two scenes.
 */
const EVENT_OVERLAP = 0.7
const EVENT_MIN_SHARED = 2

/**
 * Below this many content words, a summary is not compared at all.
 *
 * A proportion of a very small number is not a measurement. « Il arrive 0. » and
 * « Il arrive 1. » share every content word they have — the digit that tells
 * them apart is one character long and no tokeniser keeps it — so by every rule
 * above they are the same beat, and they are eight different scenes. Four is
 * what an event summary the pipeline actually writes carries several times over;
 * anything under it is a label, and a label is judged by equality elsewhere.
 */
const EVENT_MIN_WORDS = 4

/**
 * Content words of a summary, with sentence punctuation out of the way.
 *
 * `normalizeText` folds punctuation rather than dropping it, which is right for
 * an excerpt compared character by character and wrong here: these are whole
 * sentences, and « Luffy. » at the end of one is the same word as « Luffy » in
 * the middle of the other. Left in, a full stop was enough to hide a match.
 */
function beatWords(summary: string): Set<string> {
  return new Set(tokens(summary.replace(/[^\p{L}\p{N}]+/gu, ' ')))
}

/**
 * The capitalised words of a summary — its names, near enough.
 *
 * Word overlap alone is not sufficient, and the pair that shows it is the one
 * where the *only* difference is who it happened to: « Zoro tranche Kuroobi dans
 * le hall du restaurant » and « Zoro tranche Hachi dans le hall du restaurant »
 * share four content words out of five and are two fights. No threshold on a
 * word count separates those from a rephrasing, because by that measure they are
 * a rephrasing.
 *
 * A capital is a coarse test for a name and deliberately so. It over-collects —
 * the first word of a sentence is capitalised whatever it is — and over-
 * collecting is the harmless direction: an extra name on one side only makes the
 * rule *refuse* to fold, which shows the reader a retelling. Under-collecting
 * would hide a beat, and no reader can notice what a thread does not say.
 */
function names(summary: string): Set<string> {
  const out = new Set<string>()
  for (const word of summary.split(/[^\p{L}\p{N}]+/u)) {
    const first = word[0]
    if (first === undefined || first === first.toLowerCase()) continue
    const normalized = normalizeText(word)
    if (normalized.length > 1) out.add(normalized)
  }
  return out
}

/** The entries of `a` that `b` does not have. */
function only(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((entry) => !b.has(entry))
}

/** Do these two sentences recount the same thing happening? */
export function sameBeat(a: string, b: string): boolean {
  const left = beatWords(a)
  const right = beatWords(b)
  if (Math.min(left.size, right.size) < EVENT_MIN_WORDS) return false

  const shared = [...left].filter((token) => right.has(token)).length
  if (shared < EVENT_MIN_SHARED) return false
  if (shared / Math.min(left.size, right.size) < EVENT_OVERLAP) return false

  /*
   * Each naming someone the other does not: two scenes.
   *
   * Both sides, not either. One telling is often the other plus a clause —
   * « Luffy protège Koby et met Alvida hors de combat » against « Luffy protège
   * Koby » — and a name that appears only in the fuller version is the fuller
   * version being fuller, not a second scene. It takes an exclusive name on
   * *each* side for the two to be about different people.
   */
  const here = names(a)
  const there = names(b)
  return only(here, there).length === 0 || only(there, here).length === 0
}

/**
 * How close two summaries are, when the answer « pas la même scène » is not the
 * end of the question.
 *
 * `sameBeat` is a verdict and has to stay one: it folds two nodes into one for
 * free, so its threshold is set where a false fold is impossible rather than
 * where a rephrasing is likely. Everything between « obviously the same » and
 * « obviously not » is what it declines to judge — and that band is exactly
 * where a second, paid reading has something to add.
 *
 * So this measures instead of deciding. It returns the same three quantities
 * `sameBeat` weighs, computed by the same tokeniser, and leaves the threshold
 * to the caller. Sharing the tokeniser is the whole point: a candidate selected
 * by a looser count than the one that folds is a candidate the fold could have
 * taken, and two tokenisers would make that relationship a coincidence.
 */
export interface BeatOverlap {
  /** Content words both summaries carry. */
  shared: number
  /** Shared over the smaller vocabulary — the overlap coefficient. */
  ratio: number
  /** Capitalised words each side has that the other does not. */
  exclusiveNames: { left: string[]; right: string[] }
}

export function beatOverlap(a: string, b: string): BeatOverlap {
  const left = beatWords(a)
  const right = beatWords(b)
  const shared = [...left].filter((token) => right.has(token)).length
  const smaller = Math.min(left.size, right.size)

  const here = names(a)
  const there = names(b)

  return {
    shared,
    ratio: smaller === 0 ? 0 : shared / smaller,
    exclusiveNames: { left: only(here, there), right: only(there, here) },
  }
}
