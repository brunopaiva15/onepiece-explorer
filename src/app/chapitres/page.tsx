import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'

export const metadata: Metadata = { title: 'Chapitres' }
/**
 * Per-user and cookie-dependent: never prerendered, and never in a shared
 * cache. Signed asset URLs expire within the minute, so a cached render would
 * hand a later request a page of dead links.
 */
export const dynamic = 'force-dynamic'


export default async function ChaptersPage() {
  const session = await getReaderSession()
  const chapters = await listChapters(session.userId, session.workId)

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-6 py-12">
      <nav className="text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal d&apos;exploration
        </Link>
      </nav>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-4xl font-semibold text-primary">Chapitres</h1>
        <Link
          href="/import"
          className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          Importer
        </Link>
      </div>

      {chapters.length === 0 ? (
        <p className="mt-10 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
          Aucun chapitre importé. Commencez par le premier que vous avez lu :
          c&apos;est son numéro qui datera tout ce qu&apos;il révèle.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-sm">
          <caption className="sr-only">
            Chapitres importés, avec leur nombre de pages et leur état
          </caption>
          <thead>
            <tr className="border-b border-line-strong text-left text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">
                N°
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Titre
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Tome
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Pages
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Texte
              </th>
              <th scope="col" className="py-2 font-medium">
                État
              </th>
            </tr>
          </thead>
          <tbody>
            {chapters.map((chapter) => (
              <tr key={chapter.id} className="border-b border-line">
                <td className="py-2.5 pr-3 font-mono">
                  <Link
                    href={`/chapitres/${chapter.id}`}
                    className="text-accent hover:underline"
                  >
                    {String(chapter.number).padStart(3, '0')}
                  </Link>
                </td>
                <td className="py-2.5 pr-3 text-primary">
                  {chapter.title ?? <span className="text-muted">—</span>}
                </td>
                <td className="py-2.5 pr-3 text-secondary">
                  {chapter.volume ?? '—'}
                </td>
                <td className="py-2.5 pr-3 text-secondary">{chapter.pageCount}</td>
                <td className="py-2.5 pr-3 text-secondary">
                  {/* Which extraction path this chapter will take, and why it
                      matters: a text layer means no OCR, no model call, and an
                      excerpt that anchors to a character-exact source. */}
                  {chapter.hasTextLayer ? (
                    <span title="Couche texte : extraction exacte, sans OCR">
                      exacte
                    </span>
                  ) : (
                    <span className="text-muted" title="Pas de couche texte : OCR requis">
                      OCR
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-secondary">{chapter.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
