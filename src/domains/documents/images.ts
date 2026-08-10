import 'server-only'
import sharp from 'sharp'
// `sharp` is published with `export = sharp`, so the namespace is not reachable
// through the default import — its types have to be imported by name.
import type { Metadata } from 'sharp'
import { IngestionRejection, type IngestionLimits } from '../ingestion/limits.ts'

/**
 * Page image normalisation.
 *
 * Produces three artefacts per page and strips everything else:
 *
 *   original — exactly the bytes that were uploaded, kept so a reprocessing
 *              run never has to ask the user for the file again
 *   display  — WebP at a bounded width, what the reader and the review centre
 *              actually look at
 *   thumb    — small WebP for the import grid and the evidence strip
 *
 * Metadata is dropped in the derivatives. A scan can carry EXIF with GPS
 * coordinates, a device serial or a scanner operator's name; none of it is
 * needed to read a chapter, and all of it would otherwise sit in the bucket
 * and in every signed URL the interface hands out.
 */

const DISPLAY_WIDTH = 1400
const THUMB_WIDTH = 220

export interface NormalisedPage {
  width: number
  height: number
  display: Buffer
  thumb: Buffer
  /** Perceptual hash, for spotting a page imported twice. */
  phash: string
  /** A page much wider than tall is almost certainly a two-page spread. */
  isDoubleSpread: boolean
}

export async function normalisePage(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<NormalisedPage> {
  // `limitInputPixels` is the guard that matters here: a 4 KB PNG can declare
  // a 60 000 × 60 000 canvas, and decoding it would exhaust memory before any
  // of our own checks ran. sharp refuses before allocating.
  const image = sharp(Buffer.from(bytes), {
    limitInputPixels: limits.maxPixelsPerPage,
    sequentialRead: true,
  })

  let metadata: Metadata
  try {
    metadata = await image.metadata()
  } catch (error) {
    throw new IngestionRejection(
      'unreadable_image',
      `Image illisible : ${error instanceof Error ? error.message : String(error)}`,
      "Le fichier est corrompu ou n'est pas une image valide. Réexportez-le.",
    )
  }

  const width = metadata.width ?? 0
  const height = metadata.height ?? 0

  if (width === 0 || height === 0) {
    throw new IngestionRejection(
      'unreadable_image',
      "L'image n'a pas de dimensions exploitables.",
      'Vérifiez que le fichier est bien une image JPEG, PNG, WebP ou AVIF.',
    )
  }

  if (width * height > limits.maxPixelsPerPage) {
    throw new IngestionRejection(
      'page_too_large',
      `La page fait ${width}×${height} pixels, au-delà de la limite.`,
      'Réduisez la résolution des pages avant import, ou augmentez MAX_PIXELS_PER_PAGE.',
    )
  }

  // `rotate()` with no argument applies the EXIF orientation and then drops
  // it, so the pixels are upright and no orientation tag survives to be
  // applied twice by a downstream viewer.
  const upright = sharp(Buffer.from(bytes), {
    limitInputPixels: limits.maxPixelsPerPage,
  }).rotate()

  const [display, thumb, phash] = await Promise.all([
    upright
      .clone()
      .resize({ width: DISPLAY_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer(),
    upright
      .clone()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer(),
    perceptualHash(bytes, limits),
  ])

  return {
    width,
    height,
    display,
    thumb,
    phash,
    isDoubleSpread: width / height > 1.35,
  }
}

/**
 * dHash: 64 bits describing the gradient structure of the page.
 *
 * Chosen over a cryptographic hash because re-exporting a chapter at a
 * different quality changes every byte but almost none of the structure —
 * two imports of the same page should still be recognised as duplicates.
 * Chosen over pHash/DCT because it is a dozen lines and duplicate detection
 * here only needs to be good, not perfect.
 */
export async function perceptualHash(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<string> {
  /*
   * Canonicalise before hashing, then blur, then downsample.
   *
   * Manga pages carry large flat areas where adjacent cells are nearly equal,
   * so lossy re-encoding turns the dHash comparison into a coin flip on a
   * significant fraction of cells. Measured on this project's fixtures, the
   * same page re-encoded to WebP differed by up to 13 of 64 bits when hashed
   * directly, while two genuinely different pages differed by as few as 10 —
   * the two distributions overlapped, so no threshold worked at all.
   *
   * Resizing to a fixed width as lossless PNG first removes the format and
   * quality difference before any comparison happens. That brings re-encodings
   * to at most 8 bits apart and different pages to at least 13, which finally
   * separates.
   *
   * A dead zone around the comparison was the other candidate and it is worse:
   * at a tolerance of 4 grey levels every fixture page hashed identically,
   * because on flat art almost every cell falls inside the dead zone.
   */
  const canonical = await sharp(Buffer.from(bytes), {
    limitInputPixels: limits.maxPixelsPerPage,
  })
    .greyscale()
    .resize({ width: 256 })
    .png()
    .toBuffer()

  const { data } = await sharp(canonical)
    .greyscale()
    .blur(1)
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  let bits = ''
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col] ?? 0
      const right = data[row * 9 + col + 1] ?? 0
      bits += left > right ? '1' : '0'
    }
  }

  // 64 bits as 16 hex characters.
  let hex = ''
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex
}

/**
 * How many of the 64 bits differ.
 *
 * Measured separation on the fixture corpus: the same page re-encoded lands at
 * or below 8, two different pages at or above 13. DUPLICATE_DISTANCE sits in
 * that gap.
 */
export const DUPLICATE_DISTANCE = 10

/** Bit distance between two perceptual hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)
    distance += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1)
  }
  return distance
}

/**
 * Greyscale pixels for panel detection.
 *
 * Downscaled hard: gutters are large structures, and working at a few hundred
 * pixels wide makes the projection profiles both faster and less sensitive to
 * screentone texture.
 */
export async function greyscaleMatrix(
  bytes: Uint8Array,
  limits: IngestionLimits,
  targetWidth = 700,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(Buffer.from(bytes), {
    limitInputPixels: limits.maxPixelsPerPage,
  })
    .rotate()
    .greyscale()
    .resize({ width: targetWidth, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  return { data: new Uint8Array(data), width: info.width, height: info.height }
}
