import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters, type ChapterSummary } from '@/domains/chapters/queries.ts'
import { PageTitle } from '@/app/ui/page-title.tsx'
import { StatusBadge } from '@/app/ui/status-badge.tsx'

export const metadata: Metadata = { title: 'Chapitres' }
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
function nextAction(chapter: ChapterSummary): { href: string; label: string; kind: string } {
  switch (chapter.status) {
    case 'draft':
    case 'uploaded':
      return { href: `/chapitres/${chapter.id}`, label: 'Traiter', kind: 'bouton-primaire' }
    case 'processing':
      return { href: `/chapitres/${chapter.id}`, label: 'Suivre', kind: 'bouton-mer' }
    case 'review':
      return { href: `/chapitres/${chapter.id}`, label: 'Relire', kind: 'bouton-primaire' }
    case 'published':
      return { href: `/delta/${chapter.number}`, label: 'Le delta', kind: '' }
    default:
      return { href: `/chapitres/${chapter.id}`, label: 'Ouvrir', kind: '' }
  }
}

export default async function ChaptersPage() {
  const session = await getReaderSession()
  const chapters = await listChapters(session.userId, session.workId)

  const counts = {
    total: chapters.length,
    aRelire: chapters.filter((c) => c.status === 'review').length,
    publies: chapters.filter((c) => c.status === 'published').length,
    pages: chapters.reduce((sum, c) => sum + c.pageCount, 0),
  }

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-8">
      <PageTitle
        title="Chapitres"
        action={
          <Link href="/import" className="bouton bouton-primaire">
            + Importer
          </Link>
        }
      />

      {/* Four numbers, big. A row of counts answers "where am I" faster than
          any sentence, and this page had no answer to that at all. */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Importés', counts.total, ''],
          ['À relire', counts.aRelire, counts.aRelire > 0 ? 'bg-accent' : ''],
          ['Publiés', counts.publies, ''],
          ['Pages', counts.pages, ''],
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
          <h2 className="panneau-titre panneau-titre-vedette">Rien encore</h2>
          <div className="panneau-corps">
            <p className="text-secondary">
              Commencez par le premier chapitre que vous avez lu : c&apos;est son
              numéro qui datera tout ce qu&apos;il révèle.
            </p>
            <Link href="/import" className="bouton bouton-primaire mt-4">
              Importer le chapitre 1
            </Link>
          </div>
        </section>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {chapters.map((chapter) => {
            const action = nextAction(chapter)
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
                        {chapter.title ?? `Chapitre ${chapter.number}`}
                      </Link>
                      <StatusBadge status={chapter.status} />
                    </div>

                    <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                      <span className="tabular">{chapter.pageCount} pages</span>
                      {chapter.volume !== null && <span>tome {chapter.volume}</span>}
                      {/* Which extraction path this chapter takes, and why it
                          matters: a text layer means no OCR, no model call, and
                          an excerpt that anchors to a character-exact source. */}
                      <span title={chapter.hasTextLayer ? 'Couche texte : extraction exacte, sans OCR' : 'Pas de couche texte : OCR requis'}>
                        {chapter.hasTextLayer ? 'texte exact' : 'OCR'}
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
