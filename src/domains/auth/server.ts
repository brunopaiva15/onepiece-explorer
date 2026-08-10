import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env.ts'

/**
 * Server-side Supabase client, backed by the request's cookies.
 *
 * Used for authentication only. Table reads never go through supabase-js:
 * the chapter boundary is a per-transaction session variable that a stateless
 * PostgREST call cannot carry, so all knowledge reads use withBoundary()
 * against a direct connection (ADR 0001).
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  // cookies() first, deliberately. It is what tells Next this render depends on
  // the request, and reading configuration before it would let the build try to
  // prerender a per-user page and fail on missing configuration instead —
  // reporting a setup problem where the real issue is a caching decision.
  const cookieStore = await cookies()
  const config = env()

  return createServerClient(
    config.NEXT_PUBLIC_SUPABASE_URL,
    config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, {
                ...options,
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                path: '/',
              })
            }
          } catch {
            // Server Components cannot set cookies. The middleware refreshes
            // the session on every request, so this is safe to ignore here.
          }
        },
      },
    },
  )
}

export interface AuthenticatedUser {
  id: string
  email: string | null
}

/**
 * The authenticated user, or null.
 *
 * Always `getUser()`, never `getSession()`. getSession() returns whatever the
 * cookie claims without verifying it against the auth server — and this uid
 * becomes `request.jwt.claims.sub`, which is what every row-level security
 * policy trusts to decide whose data to return. An unverified uid here would
 * be an authorisation bypass, not a login bug.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentification requise.')
    this.name = 'UnauthenticatedError'
  }
}

export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser()
  if (!user) throw new UnauthenticatedError()
  return user
}
