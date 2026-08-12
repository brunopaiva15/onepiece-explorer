import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/domains/auth/server.ts'
import { getDict } from '@/lib/i18n/server.ts'
import {
  assertSafeKey,
  keyOwner,
  localSigningSecret,
  storage,
  verifySignature,
} from '@/domains/storage/index.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  avif: 'image/avif',
  pdf: 'application/pdf',
}

/**
 * Serves a private asset for the local storage driver.
 *
 * Three independent checks, all required — any one of them alone would be a
 * hole:
 *
 *   1. the caller is authenticated (verified via getUser(), not a cookie claim)
 *   2. the key is under the caller's own prefix
 *   3. the URL carries a valid, unexpired HMAC signature
 *
 * (2) without (1) would let anyone name someone else's prefix. (1) without (2)
 * would let any signed-in user read any other user's pages. (3) is what makes
 * a leaked URL stop working — a screenshot pasted into a chat should not be a
 * permanent public link to a manga page.
 *
 * With the Supabase driver this route is unused: signedUrl() returns a
 * short-lived Supabase Storage URL directly, minted only after the same
 * ownership check.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await context.params
  const key = segments.map(decodeURIComponent).join('/')
  const dict = await getDict()

  try {
    assertSafeKey(key)
  } catch {
    return new NextResponse(dict.errors.invalidKey, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return new NextResponse(dict.common.authRequired, { status: 401 })
  }

  if (keyOwner(key) !== user.id) {
    // Deliberately 404, not 403: a 403 would confirm the asset exists.
    return new NextResponse(dict.errors.notFound, { status: 404 })
  }

  const expires = Number(request.nextUrl.searchParams.get('exp') ?? '')
  const signature = request.nextUrl.searchParams.get('sig') ?? ''
  if (!verifySignature(localSigningSecret(), key, expires, signature)) {
    return new NextResponse(dict.errors.linkExpired, { status: 403 })
  }

  let body: Uint8Array
  try {
    body = await storage().get(key)
  } catch {
    return new NextResponse(dict.errors.notFound, { status: 404 })
  }

  const extension = key.split('.').pop()?.toLowerCase() ?? ''
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(body.byteLength),
      // Private and short-lived: never a shared-cache entry, never indexed.
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  })
}
