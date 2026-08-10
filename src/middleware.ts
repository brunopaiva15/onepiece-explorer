import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const PUBLIC_PATHS = ['/connexion', '/inscription', '/auth']

/**
 * Refreshes the Supabase session cookie and gates private routes.
 *
 * This is a convenience layer, not the security boundary. Row-level security
 * is: even a request that slipped past this middleware would read zero rows,
 * because `app.boundary_chapter` is unset outside withBoundary() and
 * `auth.uid()` would not match any row's owner. Middleware exists so the user
 * gets a sign-in page instead of an empty one.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Unconfigured instance: let the page render and explain what is missing,
  // rather than redirect-looping to a sign-in page that cannot work either.
  if (!url || !anonKey) return response

  const supabase = createServerClient(url, anonKey, {
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

  // getUser(), not getSession(): this verifies the token with the auth server
  // and is what refreshes an expired one.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )

  if (!user && !isPublic) {
    const signIn = request.nextUrl.clone()
    signIn.pathname = '/connexion'
    signIn.searchParams.set('suite', pathname)
    return NextResponse.redirect(signIn)
  }

  if (user && pathname === '/connexion') {
    const home = request.nextUrl.clone()
    home.pathname = '/'
    home.search = ''
    return NextResponse.redirect(home)
  }

  return response
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
