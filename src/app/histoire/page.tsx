import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getStoryPage, STORY_WINDOW } from '@/domains/temporal/story.ts'
import { StoryScroller } from './story-scroller.tsx'

export const metadata: Metadata = { title: 'Mode histoire' }
export const dynamic = 'force-dynamic'

/**
 * The story, from the first chapter, told by scrolling.
 *
 * Every other page in this application asks the reader where they are and
 * shows them that moment. This one starts at chapter 1 and moves forward as
 * they scroll — which sounds like a different feature and is the same one: the
 * scroll *is* the boundary slider, advancing. Each chapter below is read at its
 * own boundary, so scrolling down is being told the story in the order it was
 * told, with the names it had at the time.
 *
 * The slider in the frame still applies, and here it means something slightly
 * different than elsewhere: it is where the telling *stops*. Set it to 45 and
 * the story runs from 1 to 45 and ends there, which is exactly what someone
 * still reading wants from a recap.
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
      <Cover boundary={session.boundaryChapter} empty={first.chapters.length === 0} />

      {first.chapters.length === 0 ? (
        <div className="histoire-corps">
          <div className="panneau">
            <p className="panneau-titre">Rien à raconter</p>
            <div className="panneau-corps">
              <p className="text-secondary">
                Le mode histoire raconte ce que vos chapitres publiés ont mis
                dans le graphe. Aucun n&apos;est encore publié — importez-en un,
                puis revoyez ses propositions.
              </p>
              <Link href="/import" className="bouton bouton-primaire mt-4">
                Importer un chapitre
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <StoryScroller
          initialChapters={first.chapters}
          initialCursor={first.nextCursor}
          boundary={session.boundaryChapter}
          lastChapter={first.lastChapter}
        />
      )}
    </main>
  )
}

/**
 * The cover.
 *
 * One screen that says what this is before the first chapter number lands.
 * A story mode that opens straight onto chapter 1 reads as a page that failed
 * to load its header.
 */
function Cover({ boundary, empty }: { boundary: number; empty: boolean }) {
  return (
    <header className="histoire-couverture rayons">
      <p className="cartouche">Mode histoire</p>
      <h1 className="histoire-couverture-titre">
        Depuis
        <br />
        le début
      </h1>
      <p className="histoire-couverture-texte">
        Chapitre après chapitre, dans l&apos;ordre où vous l&apos;avez appris.
        Chaque chapitre est raconté avec ce que l&apos;on savait à ce
        moment-là&nbsp;: un nom qui n&apos;est pas encore tombé n&apos;est pas
        écrit, un visage trouvé grâce à ce nom n&apos;est pas montré.
      </p>
      {!empty && (
        <p className="histoire-couverture-jusqua">
          <span className="cartouche">Jusqu&apos;au chapitre</span>
          <span className="chiffre chiffre-xl">{boundary}</span>
        </p>
      )}
      <p className="histoire-couverture-invite" aria-hidden="true">
        ↓ Défilez
      </p>
    </header>
  )
}
