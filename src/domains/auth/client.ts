'use client'

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Browser Supabase client.
 *
 * Authentication only — sign-in, sign-out, session refresh. It is never used
 * to read a table: the chapter boundary lives in a per-transaction session
 * variable that PostgREST cannot carry, so a browser-side table read would
 * bypass the product's central guarantee. The `anon` role is granted no table
 * privileges at all (drizzle/0005), so such a query would fail anyway — but
 * the rule is the design, not the grant.
 */
let cached: SupabaseClient | null = null

export function supabaseBrowser(): SupabaseClient {
  if (cached) return cached
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  return cached
}
