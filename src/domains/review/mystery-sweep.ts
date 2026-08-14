/**
 * Reading a question's answer out of the scenes that came after it.
 *
 * The chapter that answers a question is now recorded when the reader accepts
 * « résout le mystère » — but a library imported before that predicate was ever
 * proposed carries questions the story closed long ago and nothing wrote down.
 * `scripts/close-mysteries.ts` is the backfill, and this is the part of it worth
 * testing on its own: given what the model answered, does a question count as
 * closed, and by which scene?
 *
 * Deliberately not `server-only` and deliberately free of any database or model
 * import. What it decides is a rule about dates and citations, and a rule that
 * can only be exercised through a paid call and a live database is a rule nobody
 * exercises.
 *
 * The discipline is the assistant's, for the same reason: a model handed forty
 * scenes will occasionally cite a forty-first, in the right format, with a
 * plausible chapter number. So the citation is matched against the scenes that
 * were actually supplied, and the chapter is read from the *scene*, never from
 * the citation — a resolution dated by the model rather than by the graph would
 * be a spoiler with a footnote.
 */

/** A published scene, as the sweep offers it to the model. */
export interface Scene {
  /** The event's entity id, which is what the model cites back. */
  entityId: string
  /** The chapter it was shown in — the graph's number, not the model's. */
  chapter: number
  summary: string
}

/** What a model returned about one open question. */
export interface SweepAnswer {
  insufficientData: boolean
  citations: Array<{ assertionId: string; chapter: number }>
}

export interface Resolution {
  /** The scene that answers, which becomes the subject of the relation. */
  sceneId: string
  /** The chapter that answers, which is the date the question carries. */
  chapter: number
}

/**
 * The scene that closes a question, or nothing.
 *
 * Earliest wins, because the reader met the answer the first time it was given;
 * a later scene restating it is not when they learned.
 *
 * A citation from at or before the opening chapter closes nothing, whatever the
 * model says about it. A question is opened by a chapter that left it hanging,
 * so an answer inside that same chapter is a contradiction in terms — and the
 * likeliest cause is a model citing the scene that *raised* the question, which
 * is the one mistake here that would look right in the report and be wrong in
 * the graph.
 */
export function resolvingScene(
  answer: SweepAnswer,
  scenes: readonly Scene[],
  openedInChapter: number,
): Resolution | null {
  if (answer.insufficientData) return null

  const byId = new Map(scenes.map((scene) => [scene.entityId, scene]))

  const candidates = answer.citations
    .map((citation) => byId.get(citation.assertionId))
    .filter((scene): scene is Scene => scene !== undefined)
    .filter((scene) => scene.chapter > openedInChapter)

  if (candidates.length === 0) return null

  const earliest = candidates.reduce((best, scene) =>
    scene.chapter < best.chapter ? scene : best,
  )

  return { sceneId: earliest.entityId, chapter: earliest.chapter }
}

/**
 * How many scenes one question is weighed against.
 *
 * A question opened in chapter 1 of a library read to chapter 59 has some six
 * hundred scenes after it, and handing all of them over costs more per question
 * than the whole sweep is worth. Capped from the *earliest* rather than the
 * latest: the answer to a question usually arrives soon after it is asked, and
 * a sweep that read the end of the story first would date resolutions late.
 *
 * The cap is reported rather than applied silently — a question weighed against
 * a truncated corpus and found unanswered is not the same statement as one
 * weighed against everything.
 */
export const MAX_SCENES_PER_QUESTION = 400

export function scenesFor(
  scenes: readonly Scene[],
): { offered: Scene[]; dropped: number } {
  const ordered = [...scenes].sort((a, b) => a.chapter - b.chapter)
  return {
    offered: ordered.slice(0, MAX_SCENES_PER_QUESTION),
    dropped: Math.max(0, ordered.length - MAX_SCENES_PER_QUESTION),
  }
}
