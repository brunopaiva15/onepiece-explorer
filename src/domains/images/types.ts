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

import type { Era } from './era.ts'

/**
 * Kinds an external catalogue can illustrate.
 *
 * `page` is the odd one and is deliberately vague: it means "an article on a
 * wiki", whatever that article is about. The three catalogues answer with typed
 * rows — this is a character, this is a ship — and the wiki fallback does not;
 * it answers with a page that has a lead image. Forcing it into one of the four
 * typed kinds would state something nobody checked, and the matcher would then
 * act on it.
 */
export type CandidateKind = 'character' | 'fruit' | 'ship' | 'island' | 'page'

export type SourceName = 'onepieceapi' | 'api-onepiece' | 'anilist' | 'fandom'

export interface ImageCandidate {
  source: SourceName
  /**
   * Which side of the two-year ellipse this picture depicts.
   *
   * `unknown` for all three catalogues, and truthfully so: they hand over one
   * portrait per character and say nothing about when it depicts them. Only the
   * wiki names its files well enough to be read — see era.ts, and
   * drizzle/0022_a_face_from_before_the_ellipsis.sql for what the database then
   * does with it.
   */
  era: Era
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
  /**
   * Why this catalogue was not kept on disk, when it was not.
   *
   * A deployment whose filesystem is read-only refetches on every cold start.
   * That works, and it must be visible rather than merely slow.
   */
  cacheNote?: string
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

/**
 * Node types the wiki fallback may look up.
 *
 * Wider than the catalogues, which is the point: the four typed kinds above
 * cover famous characters, the known Devil Fruits, sixteen ships and thirty-one
 * islands, and nothing else. A bar, a village, a crew, a race and a title are
 * all things the wiki has an article and a picture for, and all things the
 * graph is full of.
 *
 * Events, battles, voyages and mysteries stay out. Some of them do have wiki
 * articles, but the picture on such a page is a scene or a poster rather than a
 * portrait of the thing named, and the thread never shows a face for them
 * anyway.
 */
export const FANDOM_NODE_TYPES: readonly string[] = [
  'character',
  'group',
  'place',
  'object',
  'power',
  'species',
  'concept',
]
