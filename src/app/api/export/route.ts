import { getCurrentUser } from '@/domains/auth/server.ts'
import { exportEverything } from '@/domains/observability/export.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The whole library, as one JSON file.
 *
 * A route rather than a server action because the result is a download, and
 * because it must be reachable with a plain link the reader can bookmark or
 * script against — the point of an export is that it does not depend on this
 * application's interface still existing.
 *
 * `no-store` and `private` are not incidental: this response contains every fact
 * the reader has ever recorded, and a shared cache holding it would be the
 * single worst place for it to sit.
 */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return new Response('Authentification requise', { status: 401 })
  }

  const bundle = await exportEverything(user.id)

  const stamp = new Date().toISOString().slice(0, 10)
  const body = JSON.stringify(bundle, null, 2)

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="one-piece-explorer-${stamp}.json"`,
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
