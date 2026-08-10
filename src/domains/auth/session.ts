import 'server-only'
import { eq, and, max } from 'drizzle-orm'
import { requireUser } from './server.ts'
import { withIngest } from '@/db/boundary.ts'
import { chapters, profiles, works } from '@/db/schema/index.ts'
import { resolveBoundary } from '@/db/boundary.ts'

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
