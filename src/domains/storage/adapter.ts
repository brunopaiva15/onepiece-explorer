import 'server-only'

/**
 * Private asset storage.
 *
 * Two rules hold for every implementation:
 *
 *  1. A storage key is never a URL. Nothing in the database, in a page's props
 *     or in a template is a directly fetchable address for an imported page.
 *  2. Reading requires a signed URL with a short lifetime, minted server-side
 *     after the caller's ownership has been checked.
 *
 * That is what keeps "les assets privés ne sont jamais publiquement
 * accessibles" true rather than aspirational: there is no code path that
 * produces a durable public address for a page.
 */
export interface StorageAdapter {
  readonly name: string

  put(
    key: string,
    body: Uint8Array | Buffer,
    contentType: string,
  ): Promise<void>

  get(key: string): Promise<Uint8Array>

  /** Short-lived, single-asset URL. Never cached in a shared cache. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>

  remove(keys: string[]): Promise<void>

  exists(key: string): Promise<boolean>
}

/**
 * Build a storage key.
 *
 * Scoped by user so a bucket listing cannot mix two libraries, and structured
 * so deleting a chapter is a prefix operation.
 */
export function storageKey(parts: {
  userId: string
  chapterId: string
  kind: 'original' | 'display' | 'thumb' | 'source'
  filename: string
}): string {
  return `${parts.userId}/${parts.chapterId}/${parts.kind}/${sanitizeFilename(parts.filename)}`
}

/**
 * Reduce an uploaded filename to something safe to use as a key segment.
 *
 * Collapsing runs of dots matters as much as dropping separators: replacing
 * `/` alone turns `../../etc/passwd` into `.._.._etc_passwd`, which is no
 * longer a traversal but still contains `..` — and assertSafeKey rejects that
 * outright, so the upload would fail later with a confusing error. Collapsing
 * dots also means an innocent `chapitre..1.pdf` survives.
 */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+/, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'sans-nom'
}

/**
 * Reject a key that tries to escape its prefix.
 *
 * Keys are built server-side, but they also arrive from the database and from
 * route parameters, and a traversal in an object key is as damaging as one in
 * a filesystem path — more so for the local driver, where it is literally a
 * filesystem path.
 */
export function assertSafeKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('\0') ||
    key.includes('\\') ||
    /\/\//.test(key)
  ) {
    throw new Error(`Clé de stockage invalide : ${JSON.stringify(key)}`)
  }
}

/** The user a key belongs to, for ownership checks before signing. */
export function keyOwner(key: string): string | null {
  const [owner] = key.split('/')
  return owner && owner.length > 0 ? owner : null
}
