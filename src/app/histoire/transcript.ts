import { arcOf } from '@/domains/temporal/arcs.ts'
import type { StoryBeat } from '@/domains/temporal/story.ts'
import { MOT } from './shots.ts'

/**
 * The thread, flattened into text.
 *
 * The third way to take the same beads: read on the page, played as a film,
 * and — here — written out so they can leave the site. It is the owner's tool
 * and nobody else's, which is why the button that calls it is behind
 * `isOwner`: pasting a thousand chapters of the graph into a document is
 * proofreading, not reading.
 *
 * Loosely Markdown, and loosely on purpose. A chapter is a heading, a
 * quotation is a blockquote, everything else is a bullet — enough structure
 * that a text editor, a note-taking app or a model reads the shape correctly,
 * and little enough that the raw text is still the thing a person reads. No
 * table, no front matter, nothing that only renders.
 *
 * Two rules it shares with `shots.ts`, for the same reasons:
 *
 *  1. **The same wording.** The verb in front of a line comes from `MOT`, the
 *     one table the page and the film already share. A transcript that called
 *     a beat something else would be a third vocabulary to keep in step.
 *  2. **Nothing new is claimed.** It writes the beads it is handed and adds
 *     no fact of its own, so a transcript cannot say something the thread that
 *     produced it could not — the boundary was applied when those beads were
 *     read, and this never asks the database anything.
 *
 * What it does *not* drop is the folded tail. The page shows five events and
 * offers the rest behind a summary because a thread is read; a copy is taken
 * to be searched and compared, and one that quietly held back ten events per
 * chapter would be a copy of the wrong thing.
 */

/** Beads whose second line is a moment, not a sentence. */
const EVENT_KINDS = new Set<StoryBeat['kind']>(['evenement', 'souvenir'])

/** One window of thread, as the API answers it. */
export interface StoryWindow {
  beats: StoryBeat[]
  nextCursor: number | null
}

/**
 * The whole thread, window after window.
 *
 * The same walk the scroll makes, run to the end instead of to the fold: ask
 * from `start`, follow `nextCursor`, stop where it runs out. It takes the
 * fetcher rather than calling `fetch` itself so that the two things that can
 * be wrong here are checkable without a browser:
 *
 *  1. **A bead written twice.** Two windows that overlap — a refresh, a
 *     retry — must not put the same line in the document twice, so beads are
 *     kept by id like the scroll keeps them.
 *  2. **A cursor that does not move.** Everywhere else a stuck cursor is a
 *     wrong answer; here it is a tab that reads the same six chapters until
 *     someone kills it. Forwards or finished, and nothing in between.
 */
export async function collectThread(
  start: number,
  fetchWindow: (from: number) => Promise<StoryWindow>,
  onProgress?: (chapter: number) => void,
): Promise<StoryBeat[]> {
  const beats: StoryBeat[] = []
  const seen = new Set<string>()
  let cursor: number | null = start

  while (cursor !== null) {
    onProgress?.(cursor)
    const page: StoryWindow = await fetchWindow(cursor)

    for (const beat of page.beats) {
      if (seen.has(beat.id)) continue
      seen.add(beat.id)
      beats.push(beat)
    }

    cursor =
      page.nextCursor !== null && page.nextCursor > cursor
        ? page.nextCursor
        : null
  }

  return beats
}

export interface TranscriptFrame {
  /** The chapter the thread starts at. */
  start: number
  /** Where it stops — the reader's own boundary. */
  lastChapter: number
}

/**
 * The beads, as one document.
 *
 * The header says which stretch this is, because a file on someone's desktop
 * has lost the URL it came from and « du chapitre 1 au chapitre 45 » is the
 * whole of what distinguishes two copies taken a month apart.
 */
export function storyAsText(
  beats: StoryBeat[],
  frame: TranscriptFrame,
): string {
  const lines: string[] = [
    `# Mode histoire — du chapitre ${frame.start} au chapitre ${frame.lastChapter}`,
    '',
    'Chaque ligne est écrite avec ce que l’on savait au chapitre où elle se lit :',
    'un nom qui n’est pas encore tombé n’y est pas écrit.',
  ]

  /*
   * Bullets pack, blocks breathe.
   *
   * A blank line between every bead doubles the length of a document that is
   * already a thousand chapters long, and in Markdown it also turns one list
   * into a hundred one-item lists. So consecutive beads sit together, and the
   * blank line is spent where it changes what is read: around a chapter
   * heading and around a quotation. The header counts as a block, which is
   * what separates it from the first bead.
   */
  let blockBefore = true

  for (const beat of beats) {
    const written = writeBeat(beat)
    if (written === null) continue

    const block = beat.kind === 'chapitre' || beat.kind === 'citation'
    if (block || blockBefore) lines.push('')
    lines.push(...written)
    blockBefore = block
  }

  return `${lines.join('\n')}\n`
}

/**
 * One bead, as the lines it occupies. Null when it has nothing to say.
 *
 * A bead whose line came back empty is a hole in the library rather than a
 * beat — the same judgement `shots.ts` makes about a blank shot — and a bullet
 * with nothing after the colon would make it look deliberate. A chapter
 * survives it, because the number is the point of the notch and the title is
 * the optional part.
 */
function writeBeat(beat: StoryBeat): string[] | null {
  const text = beat.text.trim()

  if (beat.kind === 'chapitre') {
    const arc = arcOf(beat.chapter)?.name
    const head = arc ? `${arc} · Chapitre ${beat.chapter}` : `Chapitre ${beat.chapter}`
    return [`## ${head}${text === '' ? '' : ` — ${text}`}`]
  }

  if (text === '') return null

  if (beat.kind === 'citation') {
    /*
     * The caption travels with the quotation, and is not decoration here
     * either: an excerpt keeps the language of its source, so a copy that
     * dropped the note would hand someone an English sentence in the middle of
     * a French document with nothing to explain it.
     */
    return [
      `> ${text}`,
      `> — cité du chapitre ${beat.chapter}, dans la langue de la source`,
    ]
  }

  // A name landing keeps what it replaced, as the page shows it: « ancien →
  // nouveau ». The arrow is the beat.
  const line =
    beat.kind === 'nom' && beat.detail ? `${beat.detail} → ${text}` : text

  const moment = EVENT_KINDS.has(beat.kind) ? beat.detail : null
  const label = moment ? `${MOT[beat.kind]} · ${moment}` : MOT[beat.kind]

  // The moment is part of the label, and a name's former label is already in
  // the line: neither is a second thing the bead says.
  const detail =
    beat.kind === 'nom' || moment !== null ? null : beat.detail?.trim() || null

  const bullet = label === '' ? `- ${line}` : `- ${label} : ${line}`
  return [detail === null ? bullet : `${bullet} (${detail})`]
}
