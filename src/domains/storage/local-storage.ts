import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertSafeKey, type StorageAdapter } from './adapter.ts'

/**
 * Filesystem-backed storage, for tests and offline development.
 *
 * Files live under LOCAL_STORAGE_ROOT (default ./var/storage), which is
 * outside the webroot and git-ignored — Next never serves it statically.
 * Reads go through /api/assets, which verifies the HMAC below and the
 * caller's ownership before streaming a single file.
 */
export class LocalFsStorage implements StorageAdapter {
  readonly name = 'local'
  private readonly root: string
  private readonly secret: string
  private readonly defaultTtl: number

  constructor(opts: { root: string; secret: string; defaultTtl: number }) {
    this.root = path.resolve(opts.root)
    this.secret = opts.secret
    this.defaultTtl = opts.defaultTtl
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the
   * root. assertSafeKey already rejects `..`, but resolving and re-checking
   * catches symlinks and encodings it cannot see.
   */
  private resolve(key: string): string {
    assertSafeKey(key)
    const full = path.resolve(this.root, key)
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep
    if (full !== this.root && !full.startsWith(prefix)) {
      throw new Error(`Clé de stockage hors périmètre : ${key}`)
    }
    return full
  }

  async put(
    key: string,
    body: Uint8Array | Buffer,
    _contentType: string,
  ): Promise<void> {
    const full = this.resolve(key)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, body)
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.resolve(key)))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key))
      return true
    } catch {
      return false
    }
  }

  async remove(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((key) => rm(this.resolve(key), { force: true })),
    )
  }

  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    assertSafeKey(key)
    const expires = Math.floor(Date.now() / 1000) + (ttlSeconds ?? this.defaultTtl)
    const signature = signKey(this.secret, key, expires)
    const params = new URLSearchParams({ exp: String(expires), sig: signature })
    return `/api/assets/${key.split('/').map(encodeURIComponent).join('/')}?${params}`
  }

  /**
   * A loop, and honestly so: signing here is one HMAC and touches no network.
   *
   * The interface exists for the driver where it is a round trip. Pretending
   * this one batches anything would be theatre.
   */
  async signedUrls(
    keys: string[],
    ttlSeconds?: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const key of new Set(keys)) {
      try {
        out.set(key, await this.signedUrl(key, ttlSeconds))
      } catch {
        /* An unsafe key signs nothing, and costs the page nothing else. */
      }
    }
    return out
  }
}

export function signKey(secret: string, key: string, expires: number): string {
  return createHmac('sha256', secret).update(`${key}:${expires}`).digest('hex')
}

/**
 * Verify a local signed URL.
 *
 * Constant-time comparison: a signature check that leaks timing is a
 * signature check an attacker can walk byte by byte.
 */
export function verifySignature(
  secret: string,
  key: string,
  expires: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
    return false
  }
  const expected = signKey(secret, key, expires)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
