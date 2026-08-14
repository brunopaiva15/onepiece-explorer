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
 * Every picture these entities have, signed — or the first `limit` of them.
 *
 * **`limit` is only ever legitimate when `entityIds` is in an order the caller
 * chose on purpose.** It counts entities that really have a face rather than
 * candidates, so a caller hands over its whole list and the cap falls on the
 * tail; which means the cap is only as meaningful as the sort in front of it.
 * The home page qualifies: it shuffles the cast and then asks for ten, so the
 * truncation is the draw. Story mode did not — it handed over its mentions
 * « longest label first », a tie-break belonging to the regex that cuts
 * sentences, and a busy chapter spent its whole allowance on walk-ons with long
 * descriptive names before reaching « Smoker », « Sanji » and « Nami », named
 * in the sentence and left bare. If you cannot say why your order is the right
 * one to truncate, do not pass a limit.
 *
 * The reason it used to be *unavoidable* is gone: signing was a round trip per
 * file, so thirty portraits meant sixty requests. `signedUrls` makes it one for
 * the whole page, whatever its length, and the lookup was always a single
 * query. What remains is a way to not sign what will not be shown, not a
 * ration.
 */
export async function displayImages(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
  limit?: number,
): Promise<Map<string, DisplayImage>> {
  const found = await imagesFor(userId, boundaryChapter, entityIds)
  if (found.size === 0) return new Map()

  const seen = new Set<string>()
  const images =
    limit === undefined
      ? [...found.values()]
      : entityIds
          .filter((id) => {
            if (seen.has(id) || !found.has(id)) return false
            seen.add(id)
            return true
          })
          .slice(0, limit)
          .map((id) => found.get(id)!)

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
