import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { listPublishedChapterNumbers } from '@/domains/chapters/queries.ts'
import { getStoryPage, STORY_WINDOW } from '@/domains/temporal/story.ts'
import { ChapterNav } from './chapter-nav.tsx'
import { StoryScroller } from './story-scroller.tsx'

export const metadata: Metadata = { title: 'Mode histoire' }
export const dynamic = 'force-dynamic'

/**
 * The story as one thread, from the first chapter.
 *
 * Every other page asks the reader where they are and shows them that moment.
 * This one starts at chapter 1 and moves forward as they scroll — which sounds
 * like a different feature and is the same one: the scroll *is* the boundary
 * slider, advancing. Each bead below was read at its own chapter's boundary, so
 * scrolling down is being told the story in the order it was told, with the
 * names it had at the time.
 *
 * The slider in the frame still applies, and here it means where the telling
 * *stops*. Set it to 45 and the thread runs from 1 to 45 and ends there, which
 * is what someone still reading wants from a recap.
 *
 * Where it *starts* is `?depuis=`, and that is the other axis: a recap of the
 * last arc is chapters 900 to 950, not 1 to 950 scrolled through. The control
 * for it is ChapterNav — the parameter existed long before anything offered it.
 */
export default async function StoryPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; depuis?: string }>
}) {
  const { ch, depuis } = await searchParams
  const session = await getViewerSession(ch)

  const asked = Number(depuis)
  const from = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1

  /*
   * Read beside the thread, not after it: the jump control's list and the first
   * window of beads have nothing to say to each other, and the thread is the
   * slow one by an order of magnitude.
   */
  const [first, published] = await Promise.all([
    getStoryPage(session.userId, session.workId, {
      from,
      count: STORY_WINDOW,
      ceiling: session.boundaryChapter,
    }),
    listPublishedChapterNumbers(session.userId, session.workId),
  ])

  /*
   * Only what the reader may reach. The boundary is the end of the thread, so
   * offering a jump past it would be offering a jump to an empty page — and
   * naming a chapter number they have rewound past is the one thing the
   * slider's whole promise forbids.
   */
  const reachable = published.filter(
    (chapter) => chapter <= session.boundaryChapter,
  )
  const start = reachable.find((chapter) => chapter >= from) ?? from

  const nav =
    reachable.length > 0 ? (
      <ChapterNav
        chapters={reachable}
        start={start}
        boundaryParam={ch ?? null}
      />
    ) : null

  return (
    <main id="contenu" className="histoire">
      <header className="fil-tete">
        <p className="cartouche">Mode histoire</p>
        <h1 className="fil-titre">
          {from > 1 ? `Depuis le chapitre ${start}` : 'Depuis le début'}
        </h1>
        <p className="fil-texte">
          {from > 1 ? (
            <>
              Le fil reprend au chapitre {start} et court jusqu&apos;à celui où
              vous en êtes. Ce qui précède n&apos;est pas effacé&nbsp;:{' '}
              <Link
                href={pathTo(1, ch)}
                className="underline decoration-[var(--accent-strong)] decoration-2 underline-offset-2 hover:text-primary"
              >
                repartir du début
              </Link>
              .
            </>
          ) : (
            <>
              Un fil, du premier chapitre à celui où vous en êtes. Chaque chose
              y est dite avec ce que l&apos;on savait à ce moment-là&nbsp;: un
              nom qui n&apos;est pas encore tombé n&apos;est pas écrit, un
              visage trouvé grâce à ce nom n&apos;est pas montré.
            </>
          )}
        </p>

        {nav}
      </header>

      {first.beats.length === 0 ? (
        <div className="fil-bout">
          <div className="panneau">
            <p className="panneau-titre">Rien à raconter</p>
            <div className="panneau-corps">
              {reachable.length > 0 ? (
                <>
                  {/* The library is not empty — this stretch of it is. Sending
                      the reader to /import here would answer a question they
                      did not ask. */}
                  <p className="text-secondary">
                    Rien n&apos;est raconté à partir du chapitre {start}, dans
                    ce que vous avez importé et publié.
                  </p>
                  <Link
                    href={pathTo(1, ch)}
                    className="bouton bouton-primaire mt-4"
                  >
                    Repartir du début
                  </Link>
                </>
              ) : (
                /*
                 * Two audiences, two dead ends.
                 *
                 * The owner can fix this and the button says how. A visitor
                 * cannot, and offering them « Importer un chapitre » — a page
                 * they would be bounced from — turns an empty thread into a
                 * broken site.
                 */
                <>
                  <p className="text-secondary">
                    {session.isOwner
                      ? 'Le fil suit ce que vos chapitres publiés ont mis dans le graphe. Aucun ne l’est encore : importez-en un, puis revoyez ses propositions.'
                      : 'Le fil suit les chapitres publiés. Aucun ne l’est encore : revenez quand le premier sera relu.'}
                  </p>
                  {session.isOwner && (
                    <Link href="/admin/import" className="bouton bouton-primaire mt-4">
                      Importer un chapitre
                    </Link>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <StoryScroller
          initialBeats={first.beats}
          initialCursor={first.nextCursor}
          boundary={session.boundaryChapter}
          start={start}
          lastChapter={first.lastChapter}
        />
      )}
    </main>
  )
}

/**
 * A link to another start of the thread, keeping the boundary.
 *
 * `ch` is carried as the reader wrote it — absent means "wherever my session
 * is", and writing it out as a number would pin a reader who never touched the
 * slider to today's last chapter.
 */
function pathTo(from: number, ch: string | undefined): string {
  const query = new URLSearchParams({ depuis: String(from) })
  if (ch !== undefined) query.set('ch', ch)
  return `/histoire?${query.toString()}`
}
