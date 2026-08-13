import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getStoryPage, STORY_WINDOW } from '@/domains/temporal/story.ts'
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
 */
export default async function StoryPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; depuis?: string }>
}) {
  const { ch, depuis } = await searchParams
  const session = await getViewerSession(ch)

  const from = Number(depuis)
  const first = await getStoryPage(session.userId, session.workId, {
    from: Number.isFinite(from) && from >= 1 ? Math.floor(from) : 1,
    count: STORY_WINDOW,
    ceiling: session.boundaryChapter,
  })

  return (
    <main id="contenu" className="histoire">
      <header className="fil-tete">
        <p className="cartouche">Mode histoire</p>
        <h1 className="fil-titre">Depuis le début</h1>
        <p className="fil-texte">
          Un fil, du premier chapitre à celui où vous en êtes. Chaque chose y
          est dite avec ce que l&apos;on savait à ce moment-là&nbsp;: un nom qui
          n&apos;est pas encore tombé n&apos;est pas écrit, un visage trouvé
          grâce à ce nom n&apos;est pas montré.
        </p>
      </header>

      {first.beats.length === 0 ? (
        <div className="fil-bout">
          <div className="panneau">
            <p className="panneau-titre">Rien à raconter</p>
            <div className="panneau-corps">
              <p className="text-secondary">
                Le fil suit ce que vos chapitres publiés ont mis dans le graphe.
                Aucun ne l&apos;est encore — importez-en un, puis revoyez ses
                propositions.
              </p>
              <Link href="/import" className="bouton bouton-primaire mt-4">
                Importer un chapitre
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <StoryScroller
          initialBeats={first.beats}
          initialCursor={first.nextCursor}
          boundary={session.boundaryChapter}
          lastChapter={first.lastChapter}
        />
      )}
    </main>
  )
}
