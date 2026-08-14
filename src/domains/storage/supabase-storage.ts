import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertSafeKey, type StorageAdapter } from './adapter.ts'

/**
 * Supabase Storage, private bucket.
 *
 * The bucket must not be public. If it is, every imported page becomes
 * reachable by anyone who can guess a key, and the signed-URL machinery below
 * is decorative. `verifyBucketIsPrivate()` checks this at startup so the
 * mistake is loud rather than silent.
 *
 * Uses the service-role key and therefore never runs in the browser.
 */
/** Paths per signing request. See signedUrls(). */
const SIGN_CHUNK = 200

export class SupabaseStorage implements StorageAdapter {
  readonly name = 'supabase'
  private readonly client: SupabaseClient
  private readonly bucket: string
  private readonly defaultTtl: number

  constructor(opts: {
    url: string
    serviceRoleKey: string
    bucket: string
    defaultTtl: number
  }) {
    this.client = createClient(opts.url, opts.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    this.bucket = opts.bucket
    this.defaultTtl = opts.defaultTtl
  }

  async put(
    key: string,
    body: Uint8Array | Buffer,
    contentType: string,
  ): Promise<void> {
    assertSafeKey(key)
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(key, body, { contentType, upsert: true })
    if (error) {
      throw new Error(`Échec de l'envoi vers le stockage (${key}) : ${error.message}`)
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key)
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(key)
    if (error || !data) {
      throw new Error(`Fichier introuvable dans le stockage : ${key}`)
    }
    return new Uint8Array(await data.arrayBuffer())
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    const slash = key.lastIndexOf('/')
    const folder = slash === -1 ? '' : key.slice(0, slash)
    const name = slash === -1 ? key : key.slice(slash + 1)
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list(folder, { search: name, limit: 1 })
    return !error && (data?.some((f) => f.name === name) ?? false)
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    keys.forEach(assertSafeKey)
    const { error } = await this.client.storage.from(this.bucket).remove(keys)
    if (error) {
      throw new Error(`Échec de la suppression dans le stockage : ${error.message}`)
    }
  }

  async signedUrl(key: string, ttlSeconds?: number): Promise<string> {
    assertSafeKey(key)
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, ttlSeconds ?? this.defaultTtl)
    if (error || !data) {
      throw new Error(`Impossible de signer l'URL (${key}) : ${error?.message}`)
    }
    return data.signedUrl
  }

  /**
   * Every key in one POST.
   *
   * `createSignedUrls` takes a list and answers a list, so a page showing forty
   * portraits costs one request instead of eighty. The chunk is there because
   * the request body is a JSON array of paths and nothing on the other side
   * promises to accept an unbounded one; two hundred is comfortably below any
   * limit anyone has hit and still turns every realistic page into one call.
   *
   * Per-key failures come back *inside* the successful response, one `error`
   * field per path. They are skipped rather than thrown: a picture whose file
   * has gone missing should cost the reader that picture, not the page.
   */
  async signedUrls(
    keys: string[],
    ttlSeconds?: number,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(keys)]
    unique.forEach(assertSafeKey)

    const out = new Map<string, string>()
    for (let start = 0; start < unique.length; start += SIGN_CHUNK) {
      const chunk = unique.slice(start, start + SIGN_CHUNK)
      const { data, error } = await this.client.storage
        .from(this.bucket)
        .createSignedUrls(chunk, ttlSeconds ?? this.defaultTtl)

      if (error || !data) {
        throw new Error(
          `Impossible de signer ${chunk.length} URL(s) : ${error?.message}`,
        )
      }

      for (const row of data) {
        if (row.error || !row.path || !row.signedUrl) continue
        out.set(row.path, row.signedUrl)
      }
    }
    return out
  }

  /**
   * Fail loudly if the bucket is public.
   *
   * A public bucket silently voids the product's confidentiality promise and
   * nothing else in the system would notice.
   */
  async verifyBucketIsPrivate(): Promise<void> {
    const { data, error } = await this.client.storage.getBucket(this.bucket)
    if (error) {
      throw new Error(
        `Bucket « ${this.bucket} » introuvable. Créez-le dans Supabase Storage, en privé.`,
      )
    }
    if (data.public) {
      throw new Error(
        `Le bucket « ${this.bucket} » est PUBLIC. Les pages importées seraient accessibles ` +
          `à quiconque devine une URL. Passez-le en privé dans Supabase Storage.`,
      )
    }
  }
}
