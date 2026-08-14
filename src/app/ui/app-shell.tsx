import Link from 'next/link'
import { BoundarySlider } from '@/app/graph/boundary-slider.tsx'
import { GlobalSearch } from './global-search.tsx'
import { RailLink } from './rail-link.tsx'
import { StickyChrome } from './sticky-chrome.tsx'

/**
 * The application's frame, which it did not have.
 *
 * Three structural faults, none of them fixable by choosing better colours —
 * and three passes of styling had already tried:
 *
 *   1. **No hierarchy.** Seven links in a row, giving "Importer" and "Graphe"
 *      the same weight, when one is a workshop and the other is the product.
 *      They are now two named groups in a rail, and the workshop only exists
 *      for the owner.
 *
 *   2. **No search.** In an application whose entire content is a knowledge
 *      graph, search is not a page you navigate to — it is how you navigate.
 *      It sits in the bar, on every screen, focused with `/`.
 *
 *   3. **The chapter boundary was not chrome.** It is the one idea this whole
 *      product exists for, and it was copy-pasted into six pages and absent
 *      from the rest, so what you saw depended on which route you happened to
 *      be on. It belongs to the frame, above everything, permanently.
 *
 * Everything here degrades rather than throws: the shell renders above `/admin/etat`,
 * whose promise is answering when nothing else does.
 */

interface Boundary {
  boundaryChapter: number
  maxChapter: number
  chapters: number[]
}

const EXPLORER = [
  { href: '/histoire', label: 'Histoire', icon: 'story' as const },
  { href: '/graph', label: 'Graphe', icon: 'graph' as const },
  { href: '/chronologie', label: 'Chronologie', icon: 'time' as const },
  { href: '/mysteres', label: 'Mystères', icon: 'mystery' as const },
  { href: '/recherche', label: 'Recherche', icon: 'search' as const },
]

const ATELIER = [
  { href: '/admin/chapitres', label: 'Chapitres', icon: 'book' as const },
  { href: '/admin/import', label: 'Importer', icon: 'upload' as const },
  { href: '/admin/ask', label: 'Demander', icon: 'ask' as const },
  { href: '/admin/reglages', label: 'Réglages', icon: 'gear' as const },
]

/** Drawn here, not borrowed: no official mark of any work is used. */
function Mark() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className="h-8 w-8 shrink-0">
      <circle cx="20" cy="20" r="18" fill="var(--accent)" stroke="var(--ink)" strokeWidth="3" />
      <path d="M20 4 L23 20 L20 36 L17 20 Z" fill="var(--ink)" />
      <path d="M4 20 L20 17 L36 20 L20 23 Z" fill="var(--ink)" opacity="0.75" />
      <circle cx="20" cy="20" r="3" fill="var(--surface-raised)" stroke="var(--ink)" strokeWidth="2" />
    </svg>
  )
}

export async function AppShell({
  children,
}: {
  children: React.ReactNode
}) {
  let isOwner = false
  let boundary: Boundary | null = null

  try {
    const { getCurrentUser } = await import('@/domains/auth/server.ts')
    isOwner = (await getCurrentUser()) !== null
  } catch {
    isOwner = false
  }

  try {
    const { getViewerSession } = await import('@/domains/auth/session.ts')
    const { listChapters } = await import('@/domains/chapters/queries.ts')
    const session = await getViewerSession()
    const chapters = await listChapters(session.userId, session.workId)
    /*
     * Published chapters only, and the session's own ceiling.
     *
     * Both used to come from the full list, drafts included, which made the
     * control disagree with every page under it: the far right of the bar was
     * a chapter number the boundary refuses to go to — a session stops at the
     * last *published* chapter — so dragging to the end landed short of the end
     * and looked like a control that had stopped responding. A tick you cannot
     * reach is the same lie in smaller print.
     *
     * The starting position is the session's boundary rather than the maximum,
     * for the same reason: it is the one the pages were rendered with.
     */
    const numbers = chapters
      .filter((c) => c.status === 'published' && c.number <= session.maxChapter)
      .map((c) => c.number)
      .sort((a, b) => a - b)
    if (numbers.length > 0) {
      boundary = {
        boundaryChapter: session.boundaryChapter,
        maxChapter: session.maxChapter,
        chapters: numbers,
      }
    }
  } catch {
    // No session, no database, or nothing imported: the frame still draws.
    boundary = null
  }

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      {/* --- Rail ------------------------------------------------------- */}
      <aside className="border-b-[4px] border-ink bg-[var(--sea-deep)] lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r-[4px]">
        <Link
          href="/"
          className="flex items-center gap-2.5 border-b-[3px] border-ink px-4 py-3 no-underline"
        >
          <Mark />
          <span className="font-display text-lg uppercase leading-none text-white">
            One Piece
            <br />
            Explorer
          </span>
        </Link>

        <nav aria-label="Navigation principale" className="px-2 py-3">
          <p className="px-2 pb-1 font-display text-[0.7rem] uppercase tracking-[0.18em] text-[var(--accent)]">
            Explorer
          </p>
          <ul className="space-y-0.5">
            {EXPLORER.map((item) => (
              <li key={item.href}>
                <RailLink {...item} />
              </li>
            ))}
          </ul>

          {isOwner && (
            <>
              <p className="mt-4 px-2 pb-1 font-display text-[0.7rem] uppercase tracking-[0.18em] text-[var(--accent)]">
                Atelier
              </p>
              <ul className="space-y-0.5">
                {ATELIER.map((item) => (
                  <li key={item.href}>
                    <RailLink {...item} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>

        <div className="px-3 pb-4">
          {isOwner ? (
            <Link href="/admin" className="bouton w-full !text-sm">
              Poste de commandement
            </Link>
          ) : (
            /*
             * One link to the workshop, and it is deliberately quiet.
             *
             * The site is public; the sign-in form serves exactly one person. It
             * stays reachable because a bookmark is not a navigation plan, and it
             * stays small because a visitor has no account to sign in with.
             */
            <Link
              href="/admin/connexion"
              className="block px-2 py-1 text-xs text-white/60 no-underline hover:text-white"
            >
              Espace d&apos;administration
            </Link>
          )}
        </div>
      </aside>

      {/* --- Content ---------------------------------------------------- */}
      <div className="flex min-w-0 flex-col">
        {/*
         * Folded away on a phone while the reader scrolls down — see
         * StickyChrome. On a wide screen it is the bar it always was.
         */}
        <StickyChrome>
          <div className="flex items-center gap-3 px-4 py-2">
            <GlobalSearch />
          </div>
          {/*
           * The boundary, once, above everything.
           *
           * Six pages each rendered their own and the rest had none, so whether
           * you could rewind depended on the route. Here it is chrome: it is
           * either present or the library is empty.
           */}
          {boundary && (
            <BoundarySlider
              boundaryChapter={boundary.boundaryChapter}
              maxChapter={boundary.maxChapter}
              chapters={boundary.chapters}
              isOwner={isOwner}
            />
          )}
        </StickyChrome>

        <div className="min-w-0 flex-1">{children}</div>

        {/*
         * The footer is where the attribution lives, on every page.
         *
         * A site built on somebody else's wiki and about somebody else's manga
         * owes three statements — the source and its licence, the rights holders
         * of the work, and that this is not affiliated with them — and owes them
         * where a reader lands rather than only on a page they must think to
         * look for. The long form is /mentions-legales; this is the short one,
         * and it is not optional chrome.
         */}
        <footer className="mt-10 border-t-[3px] border-ink px-5 py-5">
          <div className="mx-auto max-w-4xl space-y-2 text-xs leading-relaxed text-muted">
            <p>
              Source : One Piece Wiki / Fandom — contenu sous{' '}
              <a
                href="https://creativecommons.org/licenses/by-sa/3.0/deed.fr"
                rel="noreferrer noopener nofollow"
                target="_blank"
                className="underline underline-offset-2 hover:text-secondary"
              >
                CC BY-SA 3.0
              </a>
              . Illustrations : onepieceapi.com, api-onepiece.com, AniList.
            </p>
            <p>
              Les illustrations, captures, personnages et autres éléments visuels
              issus de ONE PIECE sont la propriété de leurs ayants droit
              respectifs, notamment Eiichiro Oda, Shueisha Inc. et Toei
              Animation. © Eiichiro Oda/Shueisha, Toei Animation.
            </p>
            <p>
              One Piece Explorer est un projet non officiel et n&apos;est ni
              affilié, ni approuvé, ni sponsorisé par Eiichiro Oda, Shueisha ou
              Toei Animation. Aucune planche de manga n&apos;est publiée ici.
            </p>
            <p>
              <Link
                href="/mentions-legales"
                className="underline underline-offset-2 hover:text-secondary"
              >
                Mentions légales
              </Link>
              {isOwner && (
                <>
                  {' · '}
                  <Link
                    href="/admin/etat"
                    className="underline underline-offset-2 hover:text-secondary"
                  >
                    état du déploiement
                  </Link>
                </>
              )}
            </p>
          </div>
        </footer>
      </div>
    </div>
  )
}
