import 'server-only'
import { storage } from '../storage/index.ts'
import { imagesFor } from './enrich.ts'

/**
 * Illustrations, ready to put in a page.
 *
 * The signing happens here rather than in the components so that no template
 * ever holds a storage key, and so the one place that turns a key into a URL is
 * the one place that already checked the boundary. A component receives an
 * expiring URL or nothing at all — there is no third state where it could
 * assemble an address itself.
 */

export interface DisplayImage {
  /** Full-size portrait, ~512px wide. Signed and short-lived. */
  url: string
  /** Small square-ish version for lists. Falls back to the full one. */
  thumbUrl: string
  /** "onepieceapi.com", shown next to the picture. */
  attribution: string
  /** Where a human can verify the picture is what it claims. */
  sourceUrl: string
  /** The name that found it — how the reader can tell a wrong match. */
  matchedLabel: string
  matchMethod: string
  matchScore: number
  width: number | null
  height: number | null
}

/**
 * Every picture these entities have, signed.
 *
 * There is no cap, and there used to be one — a caller could ask for « the
 * first sixteen of these that have a face ». It existed because signing was a
 * round trip *per file*, so a page of thirty portraits was sixty requests; and
 * it was the wrong shape of answer, because the caller had to hand over its
 * candidates in some order and the cap then fell on whatever sorted last. In
 * story mode that order was « longest label first », which is a tie-break for
 * the regex that cuts sentences and says nothing about what the page draws: a
 * busy chapter spent its whole allowance on walk-ons with long descriptive
 * names and left « Smoker », « Sanji » and « Nami » bare in the middle of a
 * sentence that named them.
 *
 * `signedUrls` removes the reason rather than the symptom: one request for the
 * whole page, whatever its length. The remaining cost is the query above,
 * which was always a single one.
 */
export async function displayImages(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<Map<string, DisplayImage>> {
  const found = await imagesFor(userId, boundaryChapter, entityIds)
  if (found.size === 0) return new Map()

  const images = [...found.values()]

  /*
   * A key that will not sign is a picture that is gone — a bucket emptied, a
   * storage driver swapped. It is simply absent from the map, which leaves its
   * entity looking exactly as it did before it had a portrait: a perfectly
   * good page. Failing the whole render over decoration would be the wrong
   * trade, so the whole call is guarded too.
   */
  let signed: Map<string, string>
  try {
    signed = await storage().signedUrls(
      images.flatMap((image) =>
        image.thumbKey ? [image.storageKey, image.thumbKey] : [image.storageKey],
      ),
    )
  } catch {
    return new Map()
  }

  const out = new Map<string, DisplayImage>()
  for (const image of images) {
    const url = signed.get(image.storageKey)
    if (!url) continue

    out.set(image.entityId, {
      url,
      /* A thumbnail that did not sign falls back to the full picture, which is
         what an entity with no thumbnail at all already does. */
      thumbUrl: (image.thumbKey ? signed.get(image.thumbKey) : null) ?? url,
      attribution: image.attribution,
      sourceUrl: image.sourceUrl,
      matchedLabel: image.matchedLabel,
      matchMethod: image.matchMethod,
      matchScore: image.matchScore,
      width: image.width,
      height: image.height,
    })
  }

  return out
}

/** Convenience for a page that shows exactly one entity. */
export async function displayImage(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<DisplayImage | null> {
  const images = await displayImages(userId, boundaryChapter, entityIds)
  for (const id of entityIds) {
    const found = images.get(id)
    if (found) return found
  }
  return null
}
