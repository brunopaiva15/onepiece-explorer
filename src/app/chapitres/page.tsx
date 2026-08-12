import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters, type ChapterSummary } from '@/domains/chapters/queries.ts'
import { PageTitle } from '@/app/ui/page-title.tsx'
import { StatusBadge } from '@/app/ui/status-badge.tsx'
import { getDict } from '@/lib/i18n/server.ts'
import type { Dict } from '@/lib/i18n/dictionaries.ts'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.chapters.metaTitle }
}
/**
 * Per-user and cookie-dependent: never prerendered, and never in a shared
 * cache. Signed asset URLs expire within the minute, so a cached render would
 * hand a later request a page of dead links.
 */
export const dynamic = 'force-dynamic'

/**
 * The library, as cards rather than as a spreadsheet.
 *
 * It was a six-column table of small grey text where every cell had the same
 * weight — the chapter number, the volume, the page count and the state all
 * competing at 14px. But the number *is* the chapter's name, and the state is
 * the only thing that decides what you do next. So the number is set at four
 * times the body size and the state is a badge you can read across the room;
 * everything else is a footnote on the card.
 */

/** What you can do next, which depends entirely on where the chapter is. */
function nextAction(
  chapter: ChapterSummary,
  t: Dict['chapters'],
): { href: string; label: string; kind: string } {
  switch (chapter.status) {
    case 'draft':
    case 'uploaded':
      return { href: `/chapitres/${chapter.id}`, label: t.actionProcess, kind: 'bouton-primaire' }
    case 'processing':
      return { href: `/chapitres/${chapter.id}`, label: t.actionFollow, kind: 'bouton-mer' }
    case 'review':
      return { href: `/chapitres/${chapter.id}`, label: t.actionReview, kind: 'bouton-primaire' }
    case 'published':
      return { href: `/delta/${chapter.number}`, label: t.actionDelta, kind: '' }
    default:
      return { href: `/chapitres/${chapter.id}`, label: t.actionOpen, kind: '' }
  }
}

export default async function ChaptersPage() {
  const session = await getReaderSession()
  const chapters = await listChapters(session.userId, session.workId)
  const dict = await getDict()
  const t = dict.chapters

  const counts = {
    total: chapters.length,
    aRelire: chapters.filter((c) => c.status === 'review').length,
    publies: chapters.filter((c) => c.status === 'published').length,
    // Pages and passages counted together: they are the same thing to a
    // reader of this figure — how much source the library holds.
    pages: chapters.reduce((sum, c) => sum + c.pageCount + c.passageCount, 0),
  }

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-8">
      <PageTitle
        title={t.title}
        action={
          <Link href="/import" className="bouton bouton-primaire">
            {t.importCta}
          </Link>
        }
      />

      {/* Four numbers, big. A row of counts answers "where am I" faster than
          any sentence, and this page had no answer to that at all. */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          [t.statImported, counts.total, ''],
          [t.statToReview, counts.aRelire, counts.aRelire > 0 ? 'bg-accent' : ''],
          [t.statPublished, counts.publies, ''],
          [t.statPages, counts.pages, ''],
        ].map(([label, value, tint]) => (
          <div
            key={String(label)}
            className={`border-[3px] border-ink px-3 py-2 ${tint || 'bg-surface-raised'}`}
            style={{ boxShadow: 'var(--shadow-hard-sm)' }}
          >
            <p className="cartouche">{label}</p>
            <p className="chiffre chiffre-l mt-1">{value}</p>
          </div>
        ))}
      </div>

      {chapters.length === 0 ? (
        <section className="panneau mt-8">
          <h2 className="panneau-titre panneau-titre-vedette">{t.emptyTitle}</h2>
          <div className="panneau-corps">
            <p className="text-secondary">{t.emptyBody}</p>
            <Link href="/import" className="bouton bouton-primaire mt-4">
              {t.emptyCta}
            </Link>
          </div>
        </section>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {chapters.map((chapter) => {
            const action = nextAction(chapter, t)
            return (
              <li key={chapter.id} className="panneau flex flex-col">
                <div className="flex items-stretch">
                  {/* The number, as the cover of the card. */}
                  <Link
                    href={`/chapitres/${chapter.id}`}
                    className="flex w-24 shrink-0 items-center justify-center border-r-[3px] border-ink bg-sea-deep px-2 py-3 text-white no-underline"
                  >
                    <span className="chiffre chiffre-xl">{chapter.number}</span>
                  </Link>

                  <div className="min-w-0 flex-1 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/chapitres/${chapter.id}`}
                        className="min-w-0 font-display text-lg uppercase leading-tight text-primary no-underline hover:underline"
                      >
                        {chapter.title ?? dict.common.chapterN(chapter.number)}
                      </Link>
                      <StatusBadge status={chapter.status} />
                    </div>

                    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span className="tabular">
                        {chapter.sourceKind === 'summary'
                          ? t.passagesN(chapter.passageCount)
                          : t.pagesN(chapter.pageCount)}
                      </span>
                      {chapter.volume !== null && <span>{t.volumeN(chapter.volume)}</span>}
                      {/* Where this chapter's citable text comes from. A
                          written chapter anchors against exactly the characters
                          you typed; a file-imported one against OCR, which is an
                          approximation and says so. */}
                      <span title={chapter.sourceKind === 'summary' ? t.sourceWrittenTitle : chapter.hasTextLayer ? t.sourceTextLayerTitle : t.sourceOcrTitle}>
                        {chapter.sourceKind === 'summary' ? t.sourceWritten : chapter.hasTextLayer ? t.sourceTextLayer : t.sourceOcr}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-end gap-2 border-t-[3px] border-ink bg-surface-sunken px-3 py-2">
                  <Link href={action.href} className={`bouton ${action.kind} !py-1 !text-sm`}>
                    {action.label}
                  </Link>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
