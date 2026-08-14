import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * One prefix holds everything private.
 *
 * The site used to be a single space where each route argued its own case, and
 * the argument was a list of six paths nobody remembered to extend. Now the URL
 * carries the rule: `/admin/**` is the workshop — importing, processing,
 * reviewing, settings, the assistant, and the sign-in form that leads to them —
 * and everything outside it is either an explicitly public reading route or
 * private by default.
 *
 * The value of the prefix is that a route added under it next month is private
 * without anybody deciding so.
 */
const ADMIN_PREFIX = '/admin'

/**
 * The two pages under /admin that must answer without a session.
 *
 * `/admin/connexion` is where an anonymous request is *sent*, so gating it
 * behind a session is a redirect loop. `/admin/etat` reports which variable is
 * missing, and the failures it diagnoses take the sign-in page down with them —
 * gating it behind the thing it explains makes it useless in the only situation
 * it exists for.
 */
const OPEN_ADMIN_PATHS = ['/admin/connexion', '/admin/etat']

/** Signing in, and the OAuth callback. */
const PUBLIC_PATHS = ['/auth']

/**
 * The public site: everything a visitor may read without an account.
 *
 * An allowlist, deliberately. A page added next month is private until somebody
 * decides otherwise, rather than public because nobody remembered it.
 *
 * What is *not* here is as considered as what is. Page and panel images stay
 * behind `/api/assets`, which refuses an anonymous caller: publishing the graph
 * is what a fan wiki does, publishing the scans would be redistribution.
 */
const READER_PATHS = [
  '/',
  '/histoire',
  '/graph',
  '/entite',
  '/chronologie',
  '/mysteres',
  '/recherche',
  '/delta',
  '/mentions-legales',
  '/api/histoire',
]

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

export type Decision = 'allow' | 'sign-in' | 'admin'

/**
 * Who may see what, as a pure function.
 *
 * Extracted from the request handling so it can be tested directly, which is
 * not incidental: the first version of public reading shipped with the graph
 * open at the domain level and this file still bouncing every anonymous visitor
 * to the sign-in page. Every test passed. A rule about who gets in needs a test
 * of the rule, not of the thing it guards.
 *
 * Four lines, in order, and the order is the policy:
 *
 *   signed in            → everything, except the sign-in page they no longer
 *                          need, which sends them to the workshop.
 *   /admin/**            → the workshop. Sign in, apart from the two pages that
 *                          have to answer before you can.
 *   a reading route      → the public site.
 *   anything else        → private, because nobody has said otherwise.
 */
export function decide(pathname: string, hasUser: boolean): Decision {
  if (hasUser) {
    // Already signed in: the sign-in page has nothing to offer.
    return pathname === '/admin/connexion' ? 'admin' : 'allow'
  }

  if (matches(pathname, OPEN_ADMIN_PATHS)) return 'allow'
  if (matches(pathname, [ADMIN_PREFIX])) return 'sign-in'
  if (matches(pathname, PUBLIC_PATHS)) return 'allow'
  if (matches(pathname, READER_PATHS)) return 'allow'

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
 * not match any row's owner. This exists so the owner gets a sign-in page
 * instead of an empty one, and so a visitor gets the graph instead of a sign-in
 * page they have no account for.
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request })

  /*
   * Unconfigured OR misconfigured instance: let the page render and explain what
   * is missing, rather than redirect-loop to a sign-in page that cannot work
   * either.
   *
   * The shape check is not decoration. This file runs before every route,
   * including /admin/etat — the one page written to answer when everything else fails.
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

  switch (decide(pathname, user !== null)) {
    case 'sign-in': {
      const signIn = request.nextUrl.clone()
      signIn.pathname = '/admin/connexion'
      signIn.searchParams.set('suite', pathname)
      return NextResponse.redirect(signIn)
    }
    case 'admin': {
      const admin = request.nextUrl.clone()
      admin.pathname = '/admin'
      admin.search = ''
      return NextResponse.redirect(admin)
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
