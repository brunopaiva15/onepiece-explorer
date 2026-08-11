import 'server-only'
import { eq, and, max } from 'drizzle-orm'
import { getCurrentUser, requireUser } from './server.ts'
import { withIngest } from '@/db/boundary.ts'
import { chapters, profiles, works } from '@/db/schema/index.ts'
import { resolveBoundary } from '@/db/boundary.ts'
import { publicLibraryOwnerId } from '@/lib/env.ts'

export interface ReaderSession {
  userId: string
  email: string | null
  workId: string
  /** Highest published chapter number — the ceiling for the boundary slider. */
  maxChapter: number
  /** Where the reader currently is. Defaults to everything they have. */
  boundaryChapter: number
  /** True when the reader has not deliberately rewound. */
  followingLatest: boolean
}

/**
 * Resolve the current reader's session: identity, library, and boundary.
 *
 * Reads through withIngest() rather than withBoundary(), which looks
 * backwards but is correct: these are the rows needed to *establish* the
 * boundary, so filtering them by it would be circular. All three
 * (profile, work, chapter numbers) are ownership-scoped facts about the
 * library, not knowledge about the story — knowing you imported chapter 700
 * is not a spoiler about its contents. Every query here filters on the
 * verified userId explicitly.
 */
export async function getReaderSession(
  requestedBoundary?: unknown,
): Promise<ReaderSession> {
  const user = await requireUser()

  return withIngest(async (db) => {
    let [work] = await db
      .select()
      .from(works)
      .where(and(eq(works.userId, user.id), eq(works.slug, 'one-piece')))
      .limit(1)

    // First sign-in: create the library and the profile.
    if (!work) {
      await db
        .insert(profiles)
        .values({ id: user.id })
        .onConflictDoNothing()
      const inserted = await db
        .insert(works)
        .values({
          userId: user.id,
          slug: 'one-piece',
          title: 'One Piece',
          defaultReadingDirection: 'rtl',
        })
        .returning()
      work = inserted[0]!
    }

    const [row] = await db
      .select({ maxNumber: max(chapters.number) })
      .from(chapters)
      .where(
        and(
          eq(chapters.workId, work.id),
          eq(chapters.userId, user.id),
          eq(chapters.status, 'published'),
        ),
      )
    const maxChapter = row?.maxNumber ?? 0

    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1)

    /*
     * No stored position means "show me everything I have".
     *
     * This used to default to 0, so a reader who had never touched the slider
     * saw an empty graph — every chapter they had imported and published hidden
     * by the feature meant to protect them. Dating facts by revelation chapter
     * exists to make the whole graph safe to accumulate while you are still
     * reading, not to withhold it.
     */
    const stored = profile?.boundaryChapter ?? null
    const boundaryChapter =
      requestedBoundary === undefined
        ? (stored === null ? maxChapter : Math.min(stored, maxChapter))
        : resolveBoundary(requestedBoundary, maxChapter)

    return {
      userId: user.id,
      email: user.email,
      workId: work.id,
      maxChapter,
      boundaryChapter,
      followingLatest: boundaryChapter >= maxChapter,
    }
  })
}

/** Remember where the reader left the slider. */
export async function persistBoundary(
  userId: string,
  boundary: number,
): Promise<void> {
  await withIngest(async (db) => {
    await db
      .update(profiles)
      .set({ boundaryChapter: resolveBoundary(boundary) })
      .where(eq(profiles.id, userId))
  })
}

/**
 * The session for a page anyone may read.
 *
 * Two shapes, and the difference is a single boolean that every write path
 * checks:
 *
 *   signed in            → the owner. Everything, including writes.
 *   anonymous + open      → a visitor, read-only, over the owner's library.
 *   anonymous + not open  → sent to the sign-in page, as before.
 *
 * The third case is the default. Public reading exists only when
 * PUBLIC_LIBRARY_OWNER_ID is set to a well-formed id — absent or malformed, the
 * site is exactly as private as it was, and the failure direction of a typo is
 * "nobody gets in" rather than "everybody does".
 *
 * A visitor gets the boundary slider, unrestricted. That is not a concession,
 * it is the point: someone still reading the series sets it where they are and
 * explores everything up to there without being spoiled. A wiki cannot do that,
 * and it is the only reason to make this public rather than link to one.
 *
 * What a visitor does *not* get is the pages. Panel and page images stay behind
 * `/api/assets`, which refuses an anonymous caller and refuses any key outside
 * the caller's own prefix. Publishing the graph is what a fan wiki does;
 * publishing the scans would be redistribution, and the project has refused
 * that since its first line.
 */
export interface ViewerSession extends ReaderSession {
  /** False for an anonymous visitor. Every write path must check it. */
  isOwner: boolean
}

export async function getViewerSession(
  requestedBoundary?: unknown,
): Promise<ViewerSession> {
  const user = await getCurrentUser()

  if (user) {
    const session = await getReaderSession(requestedBoundary)
    return { ...session, isOwner: true }
  }

  const ownerId = publicLibraryOwnerId()
  if (!ownerId) {
    // Unchanged behaviour: no public library, so read your own or sign in.
    const session = await getReaderSession(requestedBoundary)
    return { ...session, isOwner: true }
  }

  return withIngest(async (db) => {
    /*
     * Look the library up. Never create it.
     *
     * getReaderSession() provisions a profile and a work on first sign-in,
     * which is right for a person and wrong for a stranger: an anonymous
     * request must not be able to write a row, and a mistyped owner id must
     * produce an empty site rather than a second empty library.
     */
    const [work] = await db
      .select()
      .from(works)
      .where(and(eq(works.userId, ownerId), eq(works.slug, 'one-piece')))
      .limit(1)

    if (!work) {
      return {
        userId: ownerId,
        email: null,
        workId: '',
        maxChapter: 0,
        boundaryChapter: 0,
        followingLatest: true,
        isOwner: false,
      }
    }

    const [row] = await db
      .select({ maxNumber: max(chapters.number) })
      .from(chapters)
      .where(
        and(
          eq(chapters.workId, work.id),
          eq(chapters.userId, ownerId),
          eq(chapters.status, 'published'),
        ),
      )
    const maxChapter = row?.maxNumber ?? 0

    /*
     * A visitor's position comes from the URL, never from the owner's profile.
     *
     * Two reasons. The owner's stored slider is their reading position, which
     * is nobody else's business and would leak how far along they are. And a
     * visitor has nowhere to store one — there is no account — so the query
     * string is the whole state, which also makes a view shareable as a link.
     */
    const boundaryChapter =
      requestedBoundary === undefined
        ? maxChapter
        : resolveBoundary(requestedBoundary, maxChapter)

    return {
      userId: ownerId,
      email: null,
      workId: work.id,
      maxChapter,
      boundaryChapter,
      followingLatest: boundaryChapter >= maxChapter,
      isOwner: false,
    }
  })
}

/**
 * The session for anything that writes, or that a visitor has no business
 * seeing.
 *
 * Today it is `getReaderSession()` and nothing more — that function already
 * requires a signed-in user and sends anyone else to the sign-in page. The name
 * exists anyway, and is worth the indirection: at a write site,
 * `getViewerSession()` and `getReaderSession()` look equally plausible and only
 * one of them is safe. `requireOwner()` cannot be mistaken for the other, and
 * "which write paths are guarded?" becomes one grep.
 */
export async function requireOwner(): Promise<ReaderSession> {
  return getReaderSession()
}
