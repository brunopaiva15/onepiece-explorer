import { normalizeText } from '../knowledge/normalize.ts'

/**
 * Deciding whether two appearances are the same person.
 *
 * The default answer is *no*, and that is the whole design. A wiki merges on
 * similarity because merging is usually right and cheap to undo. Here it is the
 * opposite: two deliberately-similar characters wrongly merged destroys the
 * revelation history the product exists to preserve, and the reader has no way
 * to notice — the graph looks correct, it is simply telling them something the
 * chapter did not.
 *
 * So this scores and explains, and never decides. Every signal carries its own
 * weight and its own sentence, the sentences are shown verbatim in the review
 * centre, and identity predicates are flagged `requiresExplicitReview` so no
 * confidence threshold can route one past a human.
 *
 * The signals, and why each is weighted the way it is:
 *
 *   name similarity — strong when it is an exact match on a distinctive name,
 *     nearly worthless on a placeholder. "l'homme au foulard rayé" matching
 *     "l'homme au foulard" is one description of a stripe, not evidence of
 *     identity, so placeholder-to-placeholder matches are damped hard.
 *   visual signature — the descriptors the vision step produced. Real evidence,
 *     and the only signal available for an unnamed figure.
 *   co-occurrence — appearing with the same people. Weak alone (a crew shares
 *     its members) but corroborating.
 *   chapter proximity — an appearance two chapters later is likelier to be the
 *     same person than one three hundred chapters later. Genuinely weak, and
 *     included mostly to break ties.
 *
 * No single signal can reach the threshold on its own. That is enforced by the
 * weights, not by a comment.
 */

export interface ResolutionSignals {
  /** Both labels, and whether each is a placeholder built from the art. */
  candidate: { label: string; isPlaceholder: boolean; nodeType: string }
  existing: {
    id: string
    label: string
    isPlaceholder: boolean
    nodeType: string
    firstSeenChapter: number
  }
  candidateChapter: number
  /** Visual descriptors from the vision step, for each side. */
  candidateDescriptors: string[]
  existingDescriptors: string[]
  /** Entity ids each appears alongside. */
  candidateNeighbours: string[]
  existingNeighbours: string[]
}

export interface ScoredSignal {
  key: 'name' | 'visual' | 'cooccurrence' | 'chapter'
  score: number
  weight: number
  /** Shown to the user, verbatim. Written to be read, not logged. */
  reason: string
}

export interface ResolutionScore {
  entityId: string
  /** Weighted sum, in [0,1]. */
  total: number
  signals: ScoredSignal[]
  /** What the system proposes. Never what it does. */
  suggestion: 'likely_same' | 'worth_checking' | 'likely_different'
}

const WEIGHTS = {
  name: 0.4,
  visual: 0.3,
  cooccurrence: 0.2,
  chapter: 0.1,
} as const

/**
 * Above this, the system says "likely the same" — and still asks.
 *
 * Deliberately high. The cost matrix is asymmetric: a missed merge leaves two
 * nodes the user can join in one click, while a wrong merge silently rewrites
 * what the reader knew at every chapter in between.
 */
export const LIKELY_SAME = 0.72
export const WORTH_CHECKING = 0.45

export function scoreResolution(signals: ResolutionSignals): ResolutionScore {
  const scored: ScoredSignal[] = [
    scoreName(signals),
    scoreVisual(signals),
    scoreCooccurrence(signals),
    scoreChapter(signals),
  ]

  const total = scored.reduce((sum, signal) => sum + signal.score * signal.weight, 0)

  return {
    entityId: signals.existing.id,
    total: Math.round(total * 1000) / 1000,
    signals: scored,
    suggestion:
      total >= LIKELY_SAME
        ? 'likely_same'
        : total >= WORTH_CHECKING
          ? 'worth_checking'
          : 'likely_different',
  }
}

function scoreName(signals: ResolutionSignals): ScoredSignal {
  const a = normalizeText(signals.candidate.label)
  const b = normalizeText(signals.existing.label)
  const bothPlaceholders =
    signals.candidate.isPlaceholder && signals.existing.isPlaceholder

  if (a === b) {
    if (bothPlaceholders) {
      /*
       * Two identical placeholders are the single most dangerous match in this
       * whole system. "l'homme au foulard rayé" appearing twice is two
       * descriptions of a stripe — and a scarf is exactly the kind of thing a
       * story gives to two people on purpose, then reveals three hundred
       * chapters later. Scored low enough that it cannot reach the threshold
       * without corroboration from the art.
       */
      return {
        key: 'name',
        score: 0.45,
        weight: WEIGHTS.name,
        reason:
          `Les deux désignations sont identiques (« ${signals.candidate.label} »), mais ce sont ` +
          `des descriptions visuelles, pas des noms. Deux personnages peuvent partager un ` +
          `détail vestimentaire — parfois délibérément.`,
      }
    }
    return {
      key: 'name',
      score: 1,
      weight: WEIGHTS.name,
      reason: `Même nom donné par les pages : « ${signals.existing.label} ».`,
    }
  }

  const overlap = tokenOverlap(a, b)

  if (overlap === 0) {
    return {
      key: 'name',
      score: 0,
      weight: WEIGHTS.name,
      reason: `Désignations sans rapport : « ${signals.candidate.label} » vs « ${signals.existing.label} ».`,
    }
  }

  // Partial overlap on placeholders is close to meaningless — both are
  // descriptions drawn from the same small vocabulary of clothing and build.
  const score = bothPlaceholders ? overlap * 0.3 : overlap * 0.7

  return {
    key: 'name',
    score,
    weight: WEIGHTS.name,
    reason: bothPlaceholders
      ? `Descriptions partiellement communes (${Math.round(overlap * 100)} %), ce qui est faible : ` +
        `deux descriptions visuelles se recoupent facilement.`
      : `Noms partiellement communs (${Math.round(overlap * 100)} %) : ` +
        `« ${signals.candidate.label} » / « ${signals.existing.label} ».`,
  }
}

function scoreVisual(signals: ResolutionSignals): ScoredSignal {
  if (
    signals.candidateDescriptors.length === 0 ||
    signals.existingDescriptors.length === 0
  ) {
    return {
      key: 'visual',
      score: 0,
      weight: WEIGHTS.visual,
      reason:
        'Aucune signature visuelle comparable : au moins une des deux apparitions ' +
        "n'a pas de description de case exploitable.",
    }
  }

  const a = new Set(signals.candidateDescriptors.flatMap(tokens))
  const b = new Set(signals.existingDescriptors.flatMap(tokens))
  const shared = [...a].filter((token) => b.has(token))
  const score = shared.length === 0 ? 0 : shared.length / Math.min(a.size, b.size)

  return {
    key: 'visual',
    score: Math.min(1, score),
    weight: WEIGHTS.visual,
    reason:
      shared.length === 0
        ? 'Descriptions visuelles sans élément commun.'
        : `Éléments visuels communs : ${shared.slice(0, 6).join(', ')}.`,
  }
}

function scoreCooccurrence(signals: ResolutionSignals): ScoredSignal {
  const a = new Set(signals.candidateNeighbours)
  const b = new Set(signals.existingNeighbours)

  if (a.size === 0 || b.size === 0) {
    return {
      key: 'cooccurrence',
      score: 0,
      weight: WEIGHTS.cooccurrence,
      reason: 'Aucun entourage commun observable pour le moment.',
    }
  }

  const shared = [...a].filter((id) => b.has(id))
  return {
    key: 'cooccurrence',
    score: shared.length / Math.min(a.size, b.size),
    weight: WEIGHTS.cooccurrence,
    reason:
      shared.length === 0
        ? "Les deux apparitions n'ont personne en commun autour d'elles."
        : `${shared.length} entité(s) en commun dans l'entourage.`,
  }
}

function scoreChapter(signals: ResolutionSignals): ScoredSignal {
  const gap = Math.abs(signals.candidateChapter - signals.existing.firstSeenChapter)
  // Halves roughly every 20 chapters. Weak by design; it breaks ties and
  // nothing more.
  const score = 1 / (1 + gap / 20)

  return {
    key: 'chapter',
    score,
    weight: WEIGHTS.chapter,
    reason:
      gap === 0
        ? 'Apparitions dans le même chapitre.'
        : `${gap} chapitre(s) d'écart avec la première apparition connue.`,
  }
}

/**
 * Jaccard overlap on word tokens.
 *
 * Words rather than trigrams: trigram similarity is what the database uses to
 * *find* candidates cheaply, and reusing it here would double-count the same
 * evidence — a candidate is only in this list because its trigrams matched.
 */
function tokenOverlap(a: string, b: string): number {
  const setA = new Set(tokens(a))
  const setB = new Set(tokens(b))
  if (setA.size === 0 || setB.size === 0) return 0

  const shared = [...setA].filter((token) => setB.has(token)).length
  const union = new Set([...setA, ...setB]).size
  return shared / union
}

/**
 * Content words only.
 *
 * French function words dominate any visual description — "l'homme au foulard"
 * and "la femme au manteau" share two of four tokens and describe nobody in
 * common. A short stoplist is enough here and is honest about being a heuristic;
 * anything more would be a model in disguise.
 */
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'a',
  'et', 'ou', 'en', 'dans', 'sur', 'avec', 'sans', 'son', 'sa', 'ses',
  'ce', 'cet', 'cette', 'qui', 'que', 'est', 'sont',
])

export function tokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
}
