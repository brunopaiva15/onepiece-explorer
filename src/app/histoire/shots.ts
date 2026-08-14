import { arcOf } from '@/domains/temporal/arcs.ts'
import type { DisplayImage } from '@/domains/images/index.ts'
import type { BeatKind, StoryBeat } from '@/domains/temporal/story.ts'

/**
 * The thread, cut into shots.
 *
 * Story mode is a page you scroll. This is the same beads, played instead of
 * read: one at a time, held for as long as its line takes to read, with the
 * faces the thread already found blown up to fill the screen. Nothing new is
 * fetched and nothing new is claimed — a shot shows exactly what its bead
 * shows, at the same chapter, under the same boundary. If a face is not on the
 * page it is not in the film either.
 *
 * The cut is here rather than in the player for the usual reason: it is the
 * part that can be wrong. How long a line is held, which faces a sentence
 * carries, what gets skipped — all of it is arithmetic on a `StoryBeat[]`, so
 * all of it is testable without a browser, and the player is left with the job
 * of showing one shot and counting down.
 *
 * Three editorial decisions live in here, and they are the whole of the
 * difference between the film and the page:
 *
 *  1. **The roll call and the open questions are cut.** « Entre en scène »
 *     introduces a cast and « question » keeps score — both are the thread
 *     telling the reader how it is doing, which a page can afford and a film
 *     cannot. See NOT_PLAYED.
 *  2. **The folded tail is cut.** A chapter of fifteen events shows five on the
 *     page and offers the rest behind a summary. The film takes the five. A
 *     reel that plays a chapter's every last beat is not a recap, it is the
 *     transcript again — and the beats it would add are precisely the ones the
 *     thread already judged to be the tail.
 *  3. **A sentence keeps its cast.** An event's line is marked up with the
 *     faces of everyone it names, which the page draws small and inline. Here
 *     they are the shot: « Shanks sauve Luffy et perd son bras gauche » plays
 *     as two portraits and that sentence, which is the closest this library can
 *     come to showing the scene.
 */

/**
 * The verb in front of a line, per kind.
 *
 * Shared with the bead rather than copied: the film and the page say the same
 * thing about the same beat, and two tables would drift the first time one of
 * them was reworded.
 */
export const MOT: Record<BeatKind, string> = {
  chapitre: '',
  citation: '',
  mention: 'on en parle',
  entree: 'entre en scène',
  evenement: 'il arrive',
  souvenir: 'souvenir',
  nom: 'un nom',
  dementi: 'on ne croit plus',
  reponse: 'réponse',
  question: 'question',
}

/** Beads whose second line is a moment, not a sentence. */
const EVENT_KINDS = new Set<BeatKind>(['evenement', 'souvenir'])

/**
 * Faces on one shot.
 *
 * Three is what a panel holds. A sentence naming six people, played as six
 * stamps the size of a thumbnail, shows nobody — and the ones past the third
 * are the ones the sentence mentions rather than the ones it is about, since
 * the thread lists them in the order they appear in the line.
 */
const MAX_FACES = 3

/**
 * How long a shot is held, in milliseconds.
 *
 * Read as: a fixed cost for taking in the picture, plus reading time for the
 * line. Forty-five milliseconds a character is about 370 words a minute, which
 * is fast for prose and right for one sentence that is already on screen with
 * nothing else competing for the eye.
 *
 * The floor matters more than the ceiling. Most beads are a name — « Zeff
 * entre en scène » — and a name measured by its own length would flash past in
 * under a second, which is not a shot, it is a flicker. The ceiling is there
 * for the one bead in a hundred whose summary runs to three hundred
 * characters; past seven seconds a reader has either read it or stopped
 * caring, and the pause button is right there.
 */
const HOLD_BASE = 900
const HOLD_PER_CHAR = 45
const HOLD_MIN = 1600
const HOLD_MAX = 7000

/**
 * A chapter card. Shorter than it looks: it carries a number and sometimes a
 * title, and its job is to mark the turn rather than to be read.
 */
const HOLD_CHAPTER = 2600

/** The speeds offered, as multipliers on every hold. */
export const RATES: ReadonlyArray<{ name: string; factor: number }> = [
  { name: 'lent', factor: 1.6 },
  { name: 'normal', factor: 1 },
  { name: 'rapide', factor: 0.55 },
]

export interface Shot {
  /** The bead's own id — stable across reloads, so it keys the transition. */
  id: string
  chapter: number
  kind: BeatKind
  /** The small label above the line: « souvenir · environ dix ans plus tôt ». */
  label: string
  /** The name held until now, on a shot where a name lands. */
  before: string | null
  /** The line itself. On a chapter card, its title — which may be empty. */
  line: string
  /** A second line, when the bead has one that is not its moment. */
  detail: string | null
  /** The faces this shot is built on, in the order the line names them. */
  images: DisplayImage[]
  /** How long it is held at normal speed, in milliseconds. */
  ms: number
}

/**
 * Beads the film does not play. Both are beats about the telling rather than
 * about the story, and a film is only the story.
 *
 * **« Entre en scène »** is a roll call. On the page it is the right beat — the
 * thread has to introduce a cast before the sentences start naming it, and a
 * line of it costs one bead. Played, it is a chapter's worth of shots that each
 * say one name and nothing else: « Zeff », « Patty », « Carne », three seconds
 * apart, before anything happens to any of them. A chapter that introduces
 * twenty people opened with a minute of index. What is lost is the
 * introduction, not the face: they still walk on in the events that name them,
 * carrying the same portraits — a sentence keeps its cast, which is the rule
 * below.
 *
 * **« Question »** is the thread keeping score. « Qui a laissé la marque sur la
 * coque ? » is a good line on a page one reads at one's own pace, where it sits
 * as an open thread to come back to; on screen it stops the reel to ask
 * something the next shots are not going to answer. The mysteries a chapter
 * opens are a page of their own, and `/mysteres` is it.
 *
 * « Réponse » stays. A question being closed is something that happens, and it
 * lands in the chapter where the reader learnt it.
 */
const NOT_PLAYED = new Set<BeatKind>(['entree', 'question'])

/**
 * The beads of the thread, in the order they play.
 *
 * Same array, same order, minus what a film cannot use: the roll call above,
 * the folded tail of a long chapter, and any bead whose line came back empty —
 * which is rare and is a hole in the library rather than a beat, and holding a
 * blank screen for two seconds would be the one way to make it look
 * deliberate.
 */
export function planShots(beats: StoryBeat[]): Shot[] {
  const shots: Shot[] = []
  for (const beat of beats) {
    if (beat.collapsed || NOT_PLAYED.has(beat.kind)) continue
    const shot = shotOf(beat)
    if (shot !== null) shots.push(shot)
  }
  return shots
}

function shotOf(beat: StoryBeat): Shot | null {
  const line = beat.text.trim()

  if (beat.kind === 'chapitre') {
    /*
     * The one shot that survives an empty line: a chapter with no title is
     * still a chapter, and the number is the whole point of the card.
     */
    return {
      id: beat.id,
      chapter: beat.chapter,
      kind: 'chapitre',
      label: arcOf(beat.chapter)?.name ?? '',
      before: null,
      line,
      detail: null,
      images: [],
      ms: HOLD_CHAPTER,
    }
  }

  if (line === '') return null

  /*
   * The same split the bead makes, for the same reason: an event's in-world
   * moment is what kind of beat this is — « souvenir · environ dix ans plus
   * tôt » — and not a second thing it says, so it goes on the label and the
   * second line stays empty.
   */
  const moment = EVENT_KINDS.has(beat.kind) ? beat.detail : null
  const detail =
    beat.kind === 'nom' || moment !== null
      ? null
      : beat.kind === 'citation'
        ? `Cité du chapitre ${beat.chapter}, dans la langue de la source`
        : beat.detail

  return {
    id: beat.id,
    chapter: beat.chapter,
    kind: beat.kind,
    label: labelOf(beat.kind, moment),
    before: beat.kind === 'nom' ? beat.detail : null,
    line,
    detail,
    images: facesOf(beat),
    ms: holdMs(line),
  }
}

/**
 * The label, which is the verb plus the moment when there is one.
 *
 * « il arrive » is dropped, and it is the only wording the film removes rather
 * than repeats. On the thread it separates a thing that happened from the
 * beads around it, which are names and questions; in the film those are gone
 * and an event is nearly every shot, so the label stopped distinguishing
 * anything and became a word printed above every sentence. The ones that stay
 * all do work the sentence cannot do alone: « un nom » explains an arrow,
 * « on ne croit plus » explains a strikethrough, « souvenir » says the scene is
 * not the present, and « réponse » says a question just closed.
 *
 * « citation » is named here and nowhere else: on the page a quotation is
 * drawn as one — an oversized quotation mark on the thread, prose set larger —
 * and none of that survives being blown up to fill a screen. Unlabelled, a
 * quoted English line in the middle of a French reel reads as a bug. It is the
 * same honesty the caption under it carries, moved to where it is visible.
 */
function labelOf(kind: BeatKind, moment: string | null): string {
  const mot =
    kind === 'citation' ? 'citation' : kind === 'evenement' ? '' : MOT[kind]

  if (moment === null) return mot
  // An event that the chapter dates keeps its moment and has lost its verb, so
  // the separator has nothing on its left to separate it from.
  return mot === '' ? moment : `${mot} · ${moment}`
}

/**
 * Every face the bead carries, its own first.
 *
 * A bead about a person has a portrait; a bead about something that happened
 * has a sentence with faces marked up inside it, and those are the only
 * pictures it will ever have. Taking both is what keeps the reel from being a
 * slideshow of names interrupted by walls of text.
 *
 * Deduplicated on the source page rather than on the signed URL: the same
 * picture reached twice in one sentence — the subject of the event, named
 * again inside its own summary — is signed twice and comes back as two
 * different addresses for one file.
 */
function facesOf(beat: StoryBeat): DisplayImage[] {
  const out: DisplayImage[] = []
  const seen = new Set<string>()

  const add = (image: DisplayImage | null | undefined): void => {
    if (!image || out.length >= MAX_FACES) return
    if (seen.has(image.sourceUrl)) return
    seen.add(image.sourceUrl)
    out.push(image)
  }

  add(beat.portrait)
  for (const part of beat.textParts ?? []) add(part.portrait)
  for (const part of beat.detailParts ?? []) add(part.portrait)

  return out
}

/** Reading time for one line, floored and capped. */
function holdMs(line: string): number {
  const wanted = HOLD_BASE + line.length * HOLD_PER_CHAR
  return Math.min(HOLD_MAX, Math.max(HOLD_MIN, wanted))
}

/**
 * How far through the thread a shot is, as a fraction.
 *
 * Measured in chapters and not in shots, because the number of shots is not
 * known until the last window has been fetched — a gauge fed by
 * `index / shots.length` would sit at 90% for the whole film and lurch
 * backwards every time more of the thread arrived. Chapters are known from the
 * first render: the reel runs from where the thread starts to the reader's own
 * boundary, and both are on screen already.
 */
export function progressOf(
  chapter: number,
  start: number,
  lastChapter: number,
): number {
  const span = lastChapter - start
  if (span <= 0) return 1
  return Math.min(1, Math.max(0, (chapter - start) / span))
}
