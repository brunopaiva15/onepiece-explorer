import Link from 'next/link'
import { BoundarySlider } from '@/app/graph/boundary-slider.tsx'
import { getDict, getLocale } from '@/lib/i18n/server.ts'
import { GlobalSearch } from './global-search.tsx'
import { LanguageToggle } from './language-toggle.tsx'
import { RailLink } from './rail-link.tsx'

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
 * Everything here degrades rather than throws: the shell renders above `/etat`,
 * whose promise is answering when nothing else does.
 */

interface Boundary {
  boundaryChapter: number
  maxChapter: number
  chapters: number[]
}

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
  const locale = await getLocale()
  const dict = await getDict()
  const t = dict.shell

  const explorer = [
    { href: '/graph', label: t.navGraph, icon: 'graph' as const },
    { href: '/chronologie', label: t.navTimeline, icon: 'time' as const },
    { href: '/mysteres', label: t.navMysteries, icon: 'mystery' as const },
    { href: '/recherche', label: t.navSearch, icon: 'search' as const },
  ]

  const atelier = [
    { href: '/chapitres', label: t.navChapters, icon: 'book' as const },
    { href: '/import', label: t.navImport, icon: 'upload' as const },
    { href: '/ask', label: t.navAsk, icon: 'ask' as const },
    { href: '/reglages', label: t.navSettings, icon: 'gear' as const },
  ]

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
    const numbers = chapters.map((c) => c.number).sort((a, b) => a - b)
    if (numbers.length > 0) {
      const max = numbers[numbers.length - 1]!
      boundary = { boundaryChapter: max, maxChapter: max, chapters: numbers }
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

        <nav aria-label={t.navLabel} className="px-2 py-3">
          <p className="px-2 pb-1 font-display text-[0.7rem] uppercase tracking-[0.18em] text-[var(--accent)]">
            {t.explorer}
          </p>
          <ul className="space-y-0.5">
            {explorer.map((item) => (
              <li key={item.href}>
                <RailLink {...item} />
              </li>
            ))}
          </ul>

          {isOwner && (
            <>
              <p className="mt-4 px-2 pb-1 font-display text-[0.7rem] uppercase tracking-[0.18em] text-[var(--accent)]">
                {t.atelier}
              </p>
              <ul className="space-y-0.5">
                {atelier.map((item) => (
                  <li key={item.href}>
                    <RailLink {...item} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>

        <div className="px-1 pb-3">
          <LanguageToggle locale={locale} label={t.languageLabel} />
        </div>

        {!isOwner && (
          <div className="px-3 pb-4">
            <Link href="/connexion" className="bouton bouton-primaire w-full !text-sm">
              {t.signIn}
            </Link>
          </div>
        )}
      </aside>

      {/* --- Content ---------------------------------------------------- */}
      <div className="flex min-w-0 flex-col">
        <div className="sticky top-0 z-30 border-b-[3px] border-ink bg-[var(--surface-raised)]">
          <div className="flex items-center gap-3 px-4 py-2">
            <GlobalSearch locale={locale} />
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
              locale={locale}
            />
          )}
        </div>

        <div className="min-w-0 flex-1">{children}</div>

        <footer className="mt-10 border-t-[3px] border-ink px-5 py-4">
          <p className="text-xs text-muted">
            {t.footerNote}
            <Link href="/etat" className="underline underline-offset-2 hover:text-secondary">
              {t.footerStatusLink}
            </Link>
          </p>
        </footer>
      </div>
    </div>
  )
}
