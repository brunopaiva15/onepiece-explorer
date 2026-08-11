/**
 * What an external catalogue offers, reduced to the only shape we care about.
 *
 * Three APIs, three unrelated schemas, one struct. The normalisation happens at
 * the edge — in `sources/` — so that matching, downloading and storing never
 * need to know which service a picture came from. Adding a fourth source is
 * then a file, not a change to the pipeline.
 *
 * What is deliberately *not* here: descriptions, ages, bounties, affiliations.
 * All three APIs offer them and none of them may enter this application. They
 * are external knowledge, and external knowledge is exactly what the product
 * refuses. Only the picture, the names needed to find it, and the provenance
 * needed to check it.
 */

/** Kinds an external catalogue can illustrate. */
export type CandidateKind = 'character' | 'fruit' | 'ship' | 'island'

export type SourceName = 'onepieceapi' | 'api-onepiece' | 'anilist'

export interface ImageCandidate {
  source: SourceName
  /** Stable identifier at the source, so a re-run recognises the same picture. */
  sourceRef: string
  kind: CandidateKind
  /**
   * Every name the source knows: English, Japanese, romaji, epithet.
   *
   * All of them, because a chapter may name a character by an epithet long
   * before it gives a real name, and the epithet is what the extraction will
   * have produced.
   */
  names: string[]
  imageUrl: string
  /** Where a human can go and check that this picture is what it claims. */
  pageUrl: string
  attribution: string
  /**
   * Chapter of first appearance when the source states one.
   *
   * Used as a sanity check, never as knowledge: a candidate whose first
   * appearance is far past the entity's own is probably a different character
   * with a similar name.
   */
  firstAppearanceChapter: number | null
}

export interface Catalogue {
  /** ISO date, so a stale cache is visible rather than silently used. */
  fetchedAt: string
  candidates: ImageCandidate[]
  /** Sources that could not be reached, so a thin catalogue explains itself. */
  failures: Array<{ source: SourceName; reason: string }>
}

/**
 * Which catalogue kinds may illustrate which node types.
 *
 * `group` is absent on purpose: api-onepiece lists 149 crews and none of them
 * carries an image, so there is nothing to attach. Saying that here beats
 * leaving the next reader to discover it by finding no crew portraits.
 * `event`, `battle`, `voyage`, `concept` and `mystery` are absent because they
 * are not things anyone draws a portrait of.
 */
export const KIND_FOR_NODE_TYPE: Readonly<Record<string, CandidateKind[]>> = {
  character: ['character'],
  power: ['fruit'],
  object: ['ship'],
  place: ['island'],
}
