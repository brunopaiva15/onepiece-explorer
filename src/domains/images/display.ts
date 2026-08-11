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

export async function displayImages(
  userId: string,
  boundaryChapter: number,
  entityIds: string[],
): Promise<Map<string, DisplayImage>> {
  const found = await imagesFor(userId, boundaryChapter, entityIds)
  if (found.size === 0) return new Map()

  const store = storage()
  const out = new Map<string, DisplayImage>()

  await Promise.all(
    [...found.values()].map(async (image) => {
      try {
        const [url, thumbUrl] = await Promise.all([
          store.signedUrl(image.storageKey),
          image.thumbKey ? store.signedUrl(image.thumbKey) : null,
        ])

        out.set(image.entityId, {
          url,
          thumbUrl: thumbUrl ?? url,
          attribution: image.attribution,
          sourceUrl: image.sourceUrl,
          matchedLabel: image.matchedLabel,
          matchMethod: image.matchMethod,
          matchScore: image.matchScore,
          width: image.width,
          height: image.height,
        })
      } catch {
        /*
         * A key that will not sign is a picture that is gone — a bucket
         * emptied, a storage driver swapped. Skipping it leaves the entity
         * looking exactly as it did before it had a portrait, which is a
         * perfectly good page. Failing the whole render over decoration would
         * be the wrong trade.
         */
      }
    }),
  )

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
