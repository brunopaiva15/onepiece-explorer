import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/** Reachable with no session, always: signing in, and diagnosing. */
const PUBLIC_PATHS = ['/connexion', '/inscription', '/auth', '/etat']

/**
 * Owner-only, even when the library is open to readers.
 *
 * Everything that writes, everything that spends money, and everything that
 * shows a page image. The list is deliberately a denylist rather than the
 * reading routes being an allowlist: a route added next month should be private
 * until somebody decides otherwise, not public because nobody remembered it.
 */
const OWNER_PATHS = [
  '/import',
  '/chapitres',
  '/runs',
  '/review',
  '/reglages',
  '/ask',
  '/api/export',
]

/** The reading routes, open when a public library is configured. */
const READER_PATHS = [
  '/',
  '/graph',
  '/entite',
  '/chronologie',
  '/delta',
  '/recherche',
]

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Is a public library configured?
 *
 * Duplicated from `publicLibraryOwnerId()` rather than imported, because that
 * module is `server-only` and this file runs in the proxy runtime. The check is
 * four lines and both sides fail closed on a malformed value, which is the
 * property that matters; sharing it would cost a runtime boundary crossing to
 * save nothing.
 */
function publiclyOpen(): boolean {
  const value = process.env.PUBLIC_LIBRARY_OWNER_ID?.trim()
  return Boolean(value && UUID_RE.test(value))
}

/**
 * The two values this file needs, if they are usable at all.
 *
 * Present is not the same as usable. `createServerClient` throws on a value that
 * is not an http(s) URL — and a variable filled in by hand from a documentation
 * table holds a description far more often than it holds nothing.
 */
export function usableAuthConfig(
  source: Record<string, string | undefined> = process.env,
): { url: string; anonKey: string } | null {
  const url = source.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  return { url, anonKey }
}

function matches(pathname: string, paths: string[]): boolean {
  return paths.some(
    (p) => pathname === p || (p !== '/' && pathname.startsWith(`${p}/`)),
  )
}

export type Decision = 'allow' | 'sign-in' | 'home'

/**
 * Who may see what, as a pure function.
 *
 * Extracted from the request handling so it can be tested directly, which is
 * not incidental: the first version of public reading shipped with the graph
 * open at the domain level and this file still bouncing every anonymous visitor
 * to the sign-in page. Every test passed. A rule about who gets in needs a test
 * of the rule, not of the thing it guards.
 */
export function decide(
  pathname: string,
  hasUser: boolean,
  isPubliclyOpen: boolean,
): Decision {
  if (hasUser) {
    // Already signed in: the sign-in page has nothing to offer.
    return pathname === '/connexion' ? 'home' : 'allow'
  }

  if (matches(pathname, PUBLIC_PATHS)) return 'allow'

  // Owner-only paths stay owner-only whether or not reading is public.
  if (matches(pathname, OWNER_PATHS)) return 'sign-in'

  if (isPubliclyOpen && matches(pathname, READER_PATHS)) return 'allow'

  return 'sign-in'
}

/**
 * Refreshes the Supabase session cookie and gates private routes.
 *
 * Next 16 calls this a proxy; it is what earlier versions called middleware.
 *
 * This is a convenience layer, not the security boundary. Row-level security
 * is: even a request that slipped past this file would read zero rows, because
 * `app.boundary_chapter` is unset outside withBoundary() and `auth.uid()` would
 * not match any row's owner. This exists so the user gets a sign-in page
 * instead of an empty one — and, when a public library is configured, so a
 * visitor gets the graph instead of a sign-in page.
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request })

  /*
   * Unconfigured OR misconfigured instance: let the page render and explain what
   * is missing, rather than redirect-loop to a sign-in page that cannot work
   * either.
   *
   * The shape check is not decoration. This file runs before every route,
   * including /etat — the one page written to answer when everything else fails.
   * An earlier version tested only for presence, so a variable holding something
   * that was not a URL threw inside createServerClient, and the diagnostic page
   * went down with the rest. A guard whose whole purpose is to survive a broken
   * configuration must not itself require a working one.
   */
  const auth = usableAuthConfig()
  if (!auth) return response

  const supabase = createServerClient(auth.url, auth.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) {
          request.cookies.set(name, value)
        }
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, {
            ...options,
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
          })
        }
      },
    },
  })

  /*
   * getUser(), not getSession(): this verifies the token with the auth server
   * and is what refreshes an expired one.
   *
   * Which means it is a network call, and a network call fails. Unreachable auth
   * used to turn every single route into a 500, /etat included. Failing closed —
   * treating the visitor as signed out — sends them to a sign-in page that will
   * say what is wrong, and leaves the diagnostic page reachable.
   */
  let user: { id: string } | null = null
  try {
    const result = await supabase.auth.getUser()
    user = result.data.user
  } catch {
    user = null
  }

  const { pathname } = request.nextUrl

  switch (decide(pathname, user !== null, publiclyOpen())) {
    case 'sign-in': {
      const signIn = request.nextUrl.clone()
      signIn.pathname = '/connexion'
      signIn.searchParams.set('suite', pathname)
      return NextResponse.redirect(signIn)
    }
    case 'home': {
      const home = request.nextUrl.clone()
      home.pathname = '/'
      home.search = ''
      return NextResponse.redirect(home)
    }
    default:
      return response
  }
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the asset route, which does its own
     * ownership check and must not pay the auth round-trip per image tile.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/assets|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif)$).*)',
  ],
}
