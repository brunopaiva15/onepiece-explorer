/**
 * Hard limits on untrusted uploads.
 *
 * Every one of these exists because the alternative is a denial of service or
 * a filesystem escape on a machine holding someone's private library. They are
 * tunable through the environment but never optional.
 */
import { isVercelRuntime } from '@/lib/hosting.ts'

export interface IngestionLimits {
  /** Whole upload. */
  maxUploadBytes: number
  /** Pages per chapter — a chapter with 5 000 pages is not a chapter. */
  maxPages: number
  /** Decoded pixels per page. Guards against decompression bombs in images. */
  maxPixelsPerPage: number
  /** Entries in an archive. */
  maxArchiveEntries: number
  /** Uncompressed:compressed ratio above which an archive is a bomb. */
  maxDecompressionRatio: number
  /** Total uncompressed bytes an archive may expand to. */
  maxUncompressedBytes: number
  /** Single entry uncompressed. */
  maxEntryBytes: number
}

/**
 * How many bytes can actually reach the server in one request.
 *
 * Distinct from `maxUploadBytes`, and the distinction cost a broken import
 * button: that one is what the *pipeline* will accept once the bytes arrive,
 * this one is whether they can arrive at all. The form was checking the first
 * and letting a 40 MB chapter be submitted into a request that could carry one.
 *
 * A Server Action's body is capped by Next at 1 MB unless configured — raised in
 * next.config.ts — and on a serverless host by the platform, which cannot be
 * configured at all. Vercel's cap is 4.5 MB for the whole request, so the figure
 * below leaves room for the multipart boundaries, part headers and field
 * metadata that count towards it.
 *
 * The consequence is not a tuning problem, it is an architectural one: a manga
 * chapter is ten to a hundred times this. Importing on a serverless host
 * requires the bytes to go straight to storage and never through a function.
 */
export function uploadTransportLimitBytes(): number {
  if (isVercelRuntime()) return 4 * 1_024 * 1_024
  return ingestionLimits().maxUploadBytes
}

/** True when the host, not the configuration, is what caps an upload. */
export function transportLimitIsHostImposed(): boolean {
  return isVercelRuntime()
}

export function ingestionLimits(): IngestionLimits {
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 524_288_000)
  return {
    maxUploadBytes,
    maxPages: Number(process.env.MAX_PAGES_PER_CHAPTER ?? 120),
    maxPixelsPerPage: Number(process.env.MAX_PIXELS_PER_PAGE ?? 40_000_000),
    maxArchiveEntries: Number(process.env.MAX_ARCHIVE_ENTRIES ?? 500),
    maxDecompressionRatio: Number(process.env.MAX_DECOMPRESSION_RATIO ?? 120),
    // A CBZ of scans is barely compressible, so a generous multiple of the
    // upload cap still leaves no room for a bomb.
    maxUncompressedBytes: maxUploadBytes * 4,
    maxEntryBytes: 100 * 1024 * 1024,
  }
}

/**
 * A rejection the user can act on.
 *
 * `hint` is the whole point: "fichier invalide" tells someone nothing, while
 * "cette archive contient un chemin qui sort du dossier" tells them what to
 * check. Every rejection path in the ingestion code carries one.
 */
export class IngestionRejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
  ) {
    super(message)
    this.name = 'IngestionRejection'
  }
}
