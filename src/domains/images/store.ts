import 'server-only'
import sharp from 'sharp'
import { storage } from '../storage/index.ts'
import { fetchImage } from './http.ts'
import type { ImageCandidate, ImageCrop } from './types.ts'

/**
 * Bring an external picture inside, and make it ours to serve.
 *
 * Not hotlinking, deliberately. Pointing an `<img>` at a fan API would be
 * cheaper and would be wrong three times over: every graph render would tell
 * three third parties which characters this reader is looking at, the pictures
 * would break the day one of those projects moves a bucket, and the images
 * would arrive over URLs this application cannot expire.
 *
 * So the bytes are fetched once, re-encoded to WebP, stripped of metadata, and
 * written to the same private bucket as imported pages — reachable only through
 * the authenticated route, only by short-lived signed URL. The rule that
 * scanned pages never get a durable public address applies to these as well;
 * there is no reason it should not.
 */

/** A portrait, not a wallpaper. Enough to recognise a face in a graph. */
const FULL_WIDTH = 512
const THUMB_WIDTH = 96
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
const MAX_PIXELS = 40_000_000

export interface StoredImage {
  storageKey: string
  thumbKey: string
  width: number
  height: number
  bytes: number
  mime: 'image/webp'
}

/**
 * Where an entity's illustrations live.
 *
 * `${userId}/entities/${entityId}/…` — user-scoped like every other key, so the
 * ownership check on the asset route works unchanged, and prefixed by entity so
 * deleting an entity is a prefix operation. It cannot collide with a chapter
 * prefix: chapter ids are UUIDs and `entities` is not one.
 */
export function entityImageKey(parts: {
  userId: string
  entityId: string
  kind: 'full' | 'thumb'
  source: string
  ref: string
}): string {
  const stem = `${parts.source}-${parts.ref}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  return `${parts.userId}/entities/${parts.entityId}/${parts.kind}/${stem}.webp`
}

/** How far the file's shape may drift from the one the box was drawn on. */
const RATIO_TOLERANCE = 0.02

/**
 * A fractional box turned into pixels of this particular file.
 *
 * Exported so a test can state the refusal without going near the network.
 */
export function extractOf(
  crop: ImageCrop,
  width: number,
  height: number,
  what: string,
): { left: number; top: number; width: number; height: number } {
  const ratio = width / height
  if (Math.abs(ratio - crop.ratio) > crop.ratio * RATIO_TOLERANCE) {
    throw new Error(
      `Cadrage périmé : ${what} mesure ${width}×${height} (rapport ${ratio.toFixed(3)}), ` +
        `le cadre a été tracé sur un rapport de ${crop.ratio.toFixed(3)}`,
    )
  }

  const [left, top, boxWidth, boxHeight] = crop.box
  const region = {
    left: Math.round(left * width),
    top: Math.round(top * height),
    width: Math.round(boxWidth * width),
    height: Math.round(boxHeight * height),
  }

  if (
    region.width < 1 ||
    region.height < 1 ||
    region.left < 0 ||
    region.top < 0 ||
    region.left + region.width > width ||
    region.top + region.height > height
  ) {
    throw new Error(`Cadrage hors de l'image : ${what}`)
  }

  return region
}

export async function downloadAndStore(
  userId: string,
  entityId: string,
  candidate: ImageCandidate,
): Promise<StoredImage> {
  const { bytes } = await fetchImage(candidate.imageUrl, MAX_DOWNLOAD_BYTES)

  /*
   * Decode under a pixel ceiling.
   *
   * The same defence the page importer uses, for the same reason: a few
   * kilobytes of PNG can declare a canvas large enough to exhaust memory, and
   * the declaration is honoured before any check of ours would run. Here the
   * bytes come from a third party rather than from the reader, which makes the
   * ceiling more necessary rather than less.
   */
  const source = sharp(Buffer.from(bytes), { limitInputPixels: MAX_PIXELS })

  const metadata = await source.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width === 0 || height === 0) {
    throw new Error(`Image sans dimensions exploitables : ${candidate.imageUrl}`)
  }

  /*
   * The box, checked against the picture it was drawn on.
   *
   * A crop is the one operation here that can turn a correct file into a wrong
   * picture: framed on stale coordinates it returns a patch of sky, and the
   * poster pipeline would print a bounty under it. The shape of the file is the
   * cheapest evidence that it is still the file somebody looked at, so a
   * mismatch throws and lands in the run's failures where a person reads it —
   * rather than being clamped into something plausible.
   */
  const region = candidate.crop ? extractOf(candidate.crop, width, height, candidate.imageUrl) : null

  const framed = () => {
    const pipe = source.clone()
    return region ? pipe.extract(region) : pipe
  }

  const [full, thumb] = await Promise.all([
    framed()
      .rotate()
      .resize({ width: FULL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer(),
    framed()
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer(),
  ])

  const keys = {
    full: entityImageKey({
      userId,
      entityId,
      kind: 'full',
      source: candidate.source,
      ref: candidate.sourceRef,
    }),
    thumb: entityImageKey({
      userId,
      entityId,
      kind: 'thumb',
      source: candidate.source,
      ref: candidate.sourceRef,
    }),
  }

  const store = storage()
  await Promise.all([
    store.put(keys.full, full, 'image/webp'),
    store.put(keys.thumb, thumb, 'image/webp'),
  ])

  const resized = await sharp(full).metadata()

  return {
    storageKey: keys.full,
    thumbKey: keys.thumb,
    width: resized.width ?? width,
    height: resized.height ?? height,
    bytes: full.byteLength,
    mime: 'image/webp',
  }
}
