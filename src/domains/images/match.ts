import { normalizeText } from '../knowledge/normalize.ts'
import { KIND_FOR_NODE_TYPE, type CandidateKind, type ImageCandidate } from './types.ts'

/**
 * Deciding which picture belongs to which entity.
 *
 * The same problem entity resolution already solves inside the graph, pointed
 * outward — and with the same rule: no silent match on a weak signal. A wrong
 * portrait is worse than no portrait, because a missing face reads as "not
 * found" while a wrong one reads as "found", and nobody double-checks a face
 * they have already accepted.
 *
 * Similarity is computed here in JavaScript rather than by `pg_trgm`, which the
 * database has and the resolution path uses. The reason is simply that these
 * candidates are not rows: pushing 1 200 external records into a temporary
 * table on every run to borrow one operator would be more machinery than the
 * Dice coefficient below, which is what `pg_trgm` computes anyway.
 */

export interface EntityLabel {
  label: string
  revealedInChapter: number
  precedence: number
}

export interface MatchInput {
  entityId: string
  nodeType: string
  labels: EntityLabel[]
}

export type MatchMethod = 'exact' | 'tokens' | 'subset' | 'trigram'

export interface Match {
  candidate: ImageCandidate
  method: MatchMethod
  score: number
  /** The label that found it — and therefore when the picture may be shown. */
  matchedLabel: string
  revealedInChapter: number
}

/**
 * Below this, a trigram resemblance is a coincidence.
 *
 * 0.62 was chosen against the real catalogue: "Kuina" and "Kuma" sit at 0.4 and
 * must not match; "Portgas D Ace" and "Portgas D. Ace" sit at 1.0 after
 * normalisation. The gap between a real variant and a different character is
 * wide, which is what makes a single threshold defensible here.
 */
const TRIGRAM_FLOOR = 0.62

/** A one-word label shorter than this is too generic to match on alone. */
const MIN_SOLO_TOKEN = 4

/**
 * How far the best resemblance must be ahead of the next different person.
 *
 * Under this, the two are indistinguishable to the measure being used, and
 * picking either is a coin toss dressed up as a result.
 */
const AMBIGUITY_MARGIN = 0.05

/**
 * Tie-break between sources of equal score.
 *
 * onepieceapi first because it is the only one that also knows a chapter of
 * first appearance, so its rows can be sanity-checked; AniList next because its
 * portraits are consistent studio artwork; api-onepiece last for characters,
 * where it has no images at all, but it is the only fruit source with 213
 * entries so it wins there by simply being the only candidate.
 */
const SOURCE_WEIGHT: Record<ImageCandidate['source'], number> = {
  onepieceapi: 3,
  anilist: 2,
  'api-onepiece': 1,
  /*
   * Never actually weighed against the others.
   *
   * The wiki is a fallback asked one title at a time, after this matcher has
   * already returned nothing; its candidates are not in the index and so never
   * reach a tie-break. Zero is the truthful weight for "would lose if it ever
   * competed", and the entry exists because the type says every source has one.
   */
  fandom: 0,
}

export interface CandidateIndex {
  byKind: Map<CandidateKind, ImageCandidate[]>
  byKey: Map<string, ImageCandidate[]>
  size: number
}

export function buildIndex(candidates: ImageCandidate[]): CandidateIndex {
  const byKind = new Map<CandidateKind, ImageCandidate[]>()
  const byKey = new Map<string, ImageCandidate[]>()

  for (const candidate of candidates) {
    const kindList = byKind.get(candidate.kind) ?? []
    kindList.push(candidate)
    byKind.set(candidate.kind, kindList)

    for (const name of candidate.names) {
      const key = nameKey(name)
      if (key.length === 0) continue
      const keyList = byKey.get(key) ?? []
      keyList.push(candidate)
      byKey.set(key, keyList)
    }
  }

  return { byKind, byKey, size: candidates.length }
}

/**
 * The best picture for one entity, or nothing.
 *
 * Every label is tried, not just the displayed one. A character introduced as
 * "l'homme au tablier de cuir" and later named carries both, and it is the
 * later name that will find the portrait — which is precisely why the match
 * carries the label's revelation chapter with it.
 */
export function matchEntity(
  entity: MatchInput,
  index: CandidateIndex,
): Match | null {
  const kinds = KIND_FOR_NODE_TYPE[entity.nodeType]
  if (!kinds || kinds.length === 0) return null

  const allowed = new Set(kinds)
  let best: Match | null = null

  for (const label of entity.labels) {
    const found = bestForLabel(label, allowed, index)
    if (found && better(found, best)) best = found
  }

  return best
}

function bestForLabel(
  label: EntityLabel,
  allowed: Set<CandidateKind>,
  index: CandidateIndex,
): Match | null {
  const key = nameKey(label.label)
  if (key.length === 0) return null

  const make = (
    candidate: ImageCandidate,
    method: MatchMethod,
    score: number,
  ): Match => ({
    candidate,
    method,
    score,
    matchedLabel: label.label,
    revealedInChapter: label.revealedInChapter,
  })

  // 1. The same name, character for character after normalisation.
  const exact = (index.byKey.get(key) ?? []).filter((c) => allowed.has(c.kind))
  if (exact.length > 0) {
    return make(pick(exact), 'exact', 1)
  }

  const labelTokens = tokensOf(key)
  if (labelTokens.length === 0) return null

  const pool = [...allowed].flatMap((kind) => index.byKind.get(kind) ?? [])
  if (pool.length === 0) return null

  // 2. The same words in a different order. AniList writes "Luffy Monkey".
  const reordered = pool.filter((candidate) =>
    candidate.names.some((name) => sameTokens(labelTokens, tokensOf(nameKey(name)))),
  )
  if (reordered.length > 0) return make(pick(reordered), 'tokens', 0.95)

  /*
   * 3. The label's words are all present in a longer name.
   *
   * "Monkey D Luffy" contains "Luffy". Safe for a multi-word label, dangerous
   * for a single short one — "roi" would land on half the catalogue — so a solo
   * token must be long enough *and* must resolve to exactly one candidate. An
   * ambiguous single word attaches nothing, which is the intended outcome.
   */
  const wider = contained(pool, (tokens) => covers(tokens, labelTokens))
  if (wider.length > 0) {
    const solo = labelTokens.length === 1
    const token = labelTokens[0] ?? ''

    if (!solo) return make(pick(wider.map((e) => e.candidate)), 'subset', 0.85)

    /*
     * One word is only enough when it points at one person.
     *
     * "Zoro" appears in the catalogue twice — as "Roronoa Zoro" and, from
     * AniList, as "Zoro Roronoa". Comparing display names would call those two
     * different characters and refuse the match; comparing the *set* of words
     * recognises them as one, which is what they are. Two genuinely different
     * people sharing a word ("Vinsmoke Sanji", "Vinsmoke Reiju") still produce
     * two signatures and still attach nothing.
     */
    if (token.length >= MIN_SOLO_TOKEN && people(wider) === 1) {
      return make(pick(wider.map((e) => e.candidate)), 'subset', 0.75)
    }
  }

  /*
   * 3b. The other direction: the label is the fuller name.
   *
   * Catalogues favour the name a fan would search for — "Sanji", "Kuma" —
   * while a French release prints "Vinsmoke Sanji" on the page and that is what
   * the extraction produces. Forward containment alone misses every one of
   * those, which is a large and entirely avoidable hole.
   *
   * Scored below forward containment because it is the weaker direction: a
   * short catalogue name is contained by more labels than a long one, so the
   * unambiguity check does the real work here.
   */
  const narrower = contained(pool, (tokens) => tokens.length > 0 && covers(labelTokens, tokens))
  if (narrower.length > 0 && people(narrower) === 1) {
    const shortest = narrower[0]?.signature ?? ''
    if (shortest.replace(/\s/g, '').length >= MIN_SOLO_TOKEN) {
      return make(pick(narrower.map((e) => e.candidate)), 'subset', 0.7)
    }
  }

  /*
   * 4. Spelling variants and transcription drift — with a margin.
   *
   * A bare "closest string wins" is how a mononym finds the wrong face. The
   * catalogue really does contain "Fake Zoro" alongside "Roronoa Zoro", and
   * "Zoro" resembles both. Taking the winner regardless would attach a portrait
   * on a difference of a few hundredths, silently, and it would look right.
   *
   * So the best must beat the best *different person* by a clear margin.
   * Scoring is grouped by token signature rather than by row, because the same
   * character appearing in two catalogues is one person and must not be treated
   * as its own rival — otherwise every well-covered character would be
   * disqualified for being popular.
   */
  const byPerson = new Map<string, { score: number; candidate: ImageCandidate }>()
  for (const candidate of pool) {
    for (const name of candidate.names) {
      const normalised = nameKey(name)
      const score = trigramSimilarity(key, normalised)
      if (score < TRIGRAM_FLOOR) continue

      const signature = [...tokensOf(normalised)].sort().join(' ')
      const held = byPerson.get(signature)
      if (
        !held ||
        score > held.score ||
        (score === held.score &&
          SOURCE_WEIGHT[candidate.source] > SOURCE_WEIGHT[held.candidate.source])
      ) {
        byPerson.set(signature, { score, candidate })
      }
    }
  }

  const ranked = [...byPerson.values()].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return SOURCE_WEIGHT[b.candidate.source] - SOURCE_WEIGHT[a.candidate.source]
  })

  const winner = ranked[0]
  if (!winner) return null

  const runnerUp = ranked[1]
  if (runnerUp && winner.score - runnerUp.score < AMBIGUITY_MARGIN) return null

  return make(winner.candidate, 'trigram', Number(winner.score.toFixed(3)))
}

/** Higher score wins; equal scores go to the better-provenanced source. */
function better(candidate: Match, incumbent: Match | null): boolean {
  if (!incumbent) return true
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score

  const weight =
    SOURCE_WEIGHT[candidate.candidate.source] - SOURCE_WEIGHT[incumbent.candidate.source]
  if (weight !== 0) return weight > 0

  /*
   * Then the earliest revealing label.
   *
   * Two labels finding the same picture is common — an epithet and a true name.
   * Taking the earlier one shows the portrait as soon as the reader has any
   * name that identifies this character, rather than making them wait for the
   * formal one.
   */
  return candidate.revealedInChapter < incumbent.revealedInChapter
}

interface Contained {
  candidate: ImageCandidate
  /** The matching name's words, sorted — one person's fingerprint. */
  signature: string
}

/** Candidates with a name whose token set satisfies `test`, one entry each. */
function contained(
  pool: ImageCandidate[],
  test: (tokens: string[]) => boolean,
): Contained[] {
  const found: Contained[] = []
  for (const candidate of pool) {
    for (const name of candidate.names) {
      const tokens = tokensOf(nameKey(name))
      if (test(tokens)) {
        found.push({ candidate, signature: [...tokens].sort().join(' ') })
        break
      }
    }
  }
  return found
}

/** How many distinct people the matches point at. More than one means stop. */
function people(matches: Contained[]): number {
  return new Set(matches.map((match) => match.signature)).size
}

function pick(candidates: ImageCandidate[]): ImageCandidate {
  return [...candidates].sort(
    (a, b) => SOURCE_WEIGHT[b.source] - SOURCE_WEIGHT[a.source],
  )[0]!
}

/**
 * A name reduced to letters, digits and single spaces.
 *
 * `normalizeText` already folds accents, ligatures and typographic punctuation
 * — it is the same function anchoring uses. What it keeps and this drops is
 * ordinary punctuation, because "Monkey D. Luffy" and "Monkey D Luffy" are the
 * same person and the full stop is the only thing between them.
 */
export function nameKey(value: string): string {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokensOf(key: string): string[] {
  return key.split(' ').filter((token) => token.length > 0)
}

function sameTokens(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((token, index) => token === right[index])
}

/** Does `haystack` contain every token of `needle`? */
function covers(haystack: string[], needle: string[]): boolean {
  const set = new Set(haystack)
  return needle.every((token) => set.has(token))
}

/**
 * Dice coefficient over 3-grams — the measure `pg_trgm` implements.
 *
 * Padding the ends makes the first and last letters count as much as the
 * middle ones, which is what stops "Kuina" and "Kuma" from looking alike.
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1

  const left = trigrams(a)
  const right = trigrams(b)
  if (left.size === 0 || right.size === 0) return 0

  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1

  return (2 * shared) / (left.size + right.size)
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    grams.add(padded.slice(i, i + 3))
  }
  return grams
}
