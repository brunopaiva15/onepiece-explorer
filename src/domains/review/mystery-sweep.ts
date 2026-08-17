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
 * How many scenes one question is weighed against in a single call.
 *
 * A question opened in chapter 1 of a library read to chapter 59 has some six
 * hundred scenes after it, and handing all of them over costs more per question
 * than the whole sweep is worth.
 */
export const MAX_SCENES_PER_QUESTION = 400

/**
 * Combien de fenêtres au plus, donc combien d'appels au plus.
 *
 * Quatre passes couvrent seize cents scènes, ce qui tient la bibliothèque
 * actuelle en entier et laisse de la marge. La borne existe pour la
 * bibliothèque d'après : une question jamais refermée paierait sinon un appel
 * par tranche de quatre cents scènes, indéfiniment, et c'est exactement la
 * question qui ne rapporte rien.
 */
export const MAX_PASSES = 4

/**
 * Les scènes découpées en fenêtres chronologiques, au lieu d'être tronquées.
 *
 * Ce que faisait la troncature, et ce qu'elle coûtait. Elle gardait les quatre
 * cents scènes les plus **anciennes** — un choix juste, parce que la réponse
 * arrive d'ordinaire peu après la question et qu'un balayage lisant la fin en
 * premier daterait les résolutions trop tard. Mais sur une question du chapitre
 * 1 dans une bibliothèque de neuf cents scènes, elle laissait cinq cents scènes
 * non lues, dont toutes celles où la réponse se trouvait : « Où est le trésor
 * de Gold Roger ? » était pesée contre les tout premiers chapitres, déclarée
 * sans réponse, et le rapport annonçait « laissée ouverte » avec l'aplomb d'une
 * lecture complète. Quatre questions sur les quatre premières du balayage
 * étaient dans ce cas.
 *
 * Les fenêtres gardent la propriété qui comptait et perdent celle qui coûtait.
 * Elles sont parcourues dans l'ordre et l'on s'arrête à la première qui répond,
 * donc la résolution reste datée du plus tôt qu'elle pouvait l'être — c'est la
 * même garantie que « les quatre cents plus anciennes », appliquée jusqu'au
 * bout de l'histoire au lieu de s'arrêter à la quatre-centième scène.
 *
 * Ce qu'il en coûte est proportionné à ce qu'il rapporte : une question
 * refermée tôt tient toujours en un appel, et seules celles que la troncature
 * abandonnait en silence en paient plusieurs. `dropped` reste rapporté pour ce
 * qui dépasse même les quatre passes.
 */
export function scenePasses(
  scenes: readonly Scene[],
): { passes: Scene[][]; dropped: number } {
  const ordered = [...scenes].sort((a, b) => a.chapter - b.chapter)
  const reach = MAX_SCENES_PER_QUESTION * MAX_PASSES

  const passes: Scene[][] = []
  for (let start = 0; start < Math.min(ordered.length, reach); start += MAX_SCENES_PER_QUESTION) {
    passes.push(ordered.slice(start, start + MAX_SCENES_PER_QUESTION))
  }

  return { passes, dropped: Math.max(0, ordered.length - reach) }
}

/** Ce qu'une fenêtre a rendu : une réponse, ou un refus. */
export interface PassResult {
  refusal: boolean
  answer: SweepAnswer
  costCents: number
}

export interface Scan {
  resolution: Resolution | null
  /** La scène qui referme, pour que l'appelant puisse la citer. */
  scene: Scene | null
  /** Combien de scènes ont réellement été envoyées, toutes fenêtres confondues. */
  scenesRead: number
  costCents: number
  /** Vrai si au moins une fenêtre a été refusée par le modèle. */
  refused: boolean
  /** Combien de fenêtres ont été posées, ce que le journal a intérêt à dire. */
  passes: number
}

/**
 * Parcourir les fenêtres jusqu'à la première qui referme la question.
 *
 * `ask` est injecté plutôt qu'importé, et ce fichier reste ce qu'il annonce en
 * tête : une règle sur des dates et des citations, sans base de données ni
 * modèle. C'est ce qui permet d'éprouver la boucle — s'arrête-t-elle bien à la
 * première fenêtre qui répond ? paie-t-elle bien les suivantes quand la
 * première ne répond pas ? — sans un appel facturé.
 *
 * Un refus n'arrête pas le parcours. Ce n'est pas une réponse, c'est un modèle
 * qui décline une fenêtre ; les suivantes méritent d'être posées, et le refus
 * n'est rapporté que s'il ne reste rien d'autre à dire.
 */
export async function scanForResolution(
  passes: readonly Scene[][],
  openedInChapter: number,
  ask: (window: Scene[]) => Promise<PassResult>,
): Promise<Scan> {
  let scenesRead = 0
  let costCents = 0
  let refused = false
  let asked = 0

  for (const window of passes) {
    const result = await ask(window)
    asked++
    scenesRead += window.length
    costCents += result.costCents

    if (result.refusal) {
      refused = true
      continue
    }

    const resolution = resolvingScene(result.answer, window, openedInChapter)
    if (resolution === null) continue

    return {
      resolution,
      scene: window.find((scene) => scene.entityId === resolution.sceneId) ?? null,
      scenesRead,
      costCents,
      refused,
      passes: asked,
    }
  }

  return { resolution: null, scene: null, scenesRead, costCents, refused, passes: asked }
}

/**
 * What the person who pressed the button may be told about a resolution.
 *
 * The sweep reads the whole published library, on purpose — that is what dates
 * an answer correctly rather than late. But its *report* is read by someone
 * sitting at a chapter, and « refermée au chapitre 412 : Zoro rend son sabre »
 * is a spoiler however true it is. The page already refuses to show a
 * resolution beyond the reader's position; a report that named it would walk
 * around that refusal through the one door the reader opened themselves.
 *
 * So the chapter is returned only when the reader has read it. Null is not
 * "unresolved" — the caller says « refermée plus loin que votre position », which
 * is the whole truth minus the one detail that would spoil it, and the answer is
 * there waiting the day they get to it.
 */
export function tellableResolution(
  chapter: number,
  boundaryChapter: number,
): number | null {
  return chapter <= boundaryChapter ? chapter : null
}
