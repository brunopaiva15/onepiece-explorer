import { getViewerSession } from '@/domains/auth/session.ts'
import { getStoryPage, STORY_WINDOW } from '@/domains/temporal/story.ts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One more window of the story.
 *
 * The boundary arrives in the query string and is *not* trusted: it goes
 * through `getViewerSession()` like every other read, which clamps it to what
 * the reader actually has. A forged `ch=9999` therefore buys nothing — the
 * session resolves it down to the last published chapter, and the row-level
 * security policies would refuse anything beyond it regardless.
 *
 * `no-store`, because the response carries signed asset URLs scoped to one
 * reader and expiring shortly. A shared cache holding them would hand one
 * reader's portraits to the next.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const from = Number(url.searchParams.get('depuis') ?? '1')

  if (!Number.isFinite(from) || from < 1) {
    return new Response('Paramètre « depuis » invalide.', { status: 400 })
  }

  const session = await getViewerSession(url.searchParams.get('ch') ?? undefined)

  const page = await getStoryPage(session.userId, session.workId, {
    from: Math.floor(from),
    count: STORY_WINDOW,
    ceiling: session.boundaryChapter,
  })

  return new Response(JSON.stringify(page), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
