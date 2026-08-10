import 'server-only'
import { createHash } from 'node:crypto'
import { env } from '@/lib/env.ts'
import type { StorageAdapter } from './adapter.ts'
import { LocalFsStorage } from './local-storage.ts'
import { SupabaseStorage } from './supabase-storage.ts'

export * from './adapter.ts'
export { LocalFsStorage, verifySignature, signKey } from './local-storage.ts'
export { SupabaseStorage } from './supabase-storage.ts'

let cached: StorageAdapter | null = null

/**
 * Secret for signing local asset URLs.
 *
 * Derived from the service-role key when there is one so it rotates with it;
 * otherwise from the anon key. Both are server-side values. Local storage is a
 * test and offline-development driver, so this never guards production data.
 */
export function localSigningSecret(): string {
  const source =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    'onepiece-explorer-development-only'
  return createHash('sha256').update(`asset-signing:${source}`).digest('hex')
}

export function storage(): StorageAdapter {
  if (cached) return cached

  const driver = process.env.STORAGE_DRIVER ?? 'supabase'
  const ttl = Number(process.env.SIGNED_URL_TTL_SECONDS ?? 60)

  if (driver === 'local') {
    cached = new LocalFsStorage({
      root: process.env.LOCAL_STORAGE_ROOT ?? './var/storage',
      secret: localSigningSecret(),
      defaultTtl: ttl,
    })
    return cached
  }

  const config = env()
  if (!config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY est requis pour le stockage Supabase. ' +
        'Renseignez-le dans .env.local, ou passez STORAGE_DRIVER=local pour un développement hors ligne.',
    )
  }

  cached = new SupabaseStorage({
    url: config.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
    bucket: config.SUPABASE_STORAGE_BUCKET,
    defaultTtl: ttl,
  })
  return cached
}

/** For tests that swap drivers. */
export function resetStorageCache(): void {
  cached = null
}
