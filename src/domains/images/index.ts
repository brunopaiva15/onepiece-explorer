/**
 * External illustrations for extracted entities.
 *
 * The one thing to keep in mind when using anything from here: a picture is not
 * knowledge. It cannot support an assertion, it never appears as evidence, and
 * it comes from outside the imported material — which is why it lives in its
 * own table with its own provenance rather than as a column on `entities`.
 */
export {
  enrichEntityImages,
  imageCoverage,
  imagesFor,
  type Coverage,
  type EnrichOptions,
  type EnrichReport,
  type EntityImage,
} from './enrich.ts'
export { displayImage, displayImages, type DisplayImage } from './display.ts'
export { buildCatalogue, loadCatalogue, cataloguePath, summarize } from './catalogue.ts'
export { buildIndex, matchEntity, nameKey, trigramSimilarity } from './match.ts'
export { entityImageKey } from './store.ts'
export { KIND_FOR_NODE_TYPE, type CandidateKind, type ImageCandidate } from './types.ts'
export {
  eraAtChapter,
  eraOfFileName,
  eraOfImageUrl,
  fileNameOfUrl,
  LAST_PRE_TIMESKIP_CHAPTER,
  type Era,
  type ReaderEra,
} from './era.ts'
export {
  bestPortraits,
  illustrates,
  infoboxFiles,
  infoboxPortrait,
  lookupFandomImages,
  lookupFandomPortraits,
} from './sources/fandom.ts'
export {
  BOUNTY_HISTORY,
  bountiesUpTo,
  bountyAtChapter,
  bountyCharacter,
  formatBerries,
  type Bounty,
  type BountyHistory,
} from './bounties.ts'
export {
  bountyCharacterCount,
  enrichBountyPosters,
  postersFor,
  postersQuietly,
  wantedAtChapter,
  type KnownBounty,
  type PosterOptions,
  type PosterReport,
  type PosterView,
} from './posters.ts'
