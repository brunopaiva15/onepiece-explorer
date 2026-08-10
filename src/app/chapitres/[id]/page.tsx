import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { getChapter, getChapterPages } from '@/domains/chapters/queries.ts'
import { latestRunForChapter } from '@/domains/pipeline/runs.ts'
import { PageGrid } from './page-grid.tsx'
import { StartRun } from './start-run.tsx'

export const metadata: Metadata = { title: 'Pages du chapitre' }

/**
 * Signed asset URLs live about a minute, so this page must never be cached.
 * A cached render would hand a later visitor a set of expired links and look
 * like the storage had broken.
 */
export const dynamic = 'force-dynamic'

export default async function ChapterPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const session = await getReaderSession()

  const chapter = await getChapter(session.userId, id)
  if (!chapter) notFound()

  const [pages, lastRunId] = await Promise.all([
    getChapterPages(session.userId, chapter.id, chapter.number),
    latestRunForChapter(session.userId, chapter.id),
  ])

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-6 py-12">
      <nav className="flex flex-wrap items-center gap-2 text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal
        </Link>
        <span className="text-muted">/</span>
        <Link href="/import" className="text-muted hover:text-primary">
          Import
        </Link>
      </nav>

      <header className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-2">
        <h1 className="text-4xl font-semibold text-primary">
          Chapitre {chapter.number}
        </h1>
        {chapter.title && (
          <p className="text-xl text-secondary">{chapter.title}</p>
        )}
        <span className="ml-auto rounded-sm border border-line px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-muted">
          {statusLabel(chapter.status)}
        </span>
      </header>

      <div className="mt-6 flex flex-wrap items-start gap-3">
        {pages.length > 0 && <StartRun chapterId={chapter.id} />}
        {lastRunId && (
          <Link
            href={`/runs/${lastRunId}`}
            className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Dernier traitement
          </Link>
        )}
      </div>

      {pages.length === 0 ? (
        <p className="mt-10 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
          Aucune page enregistrée pour ce chapitre. Relancez l&apos;import.
        </p>
      ) : (
        <PageGrid
          chapterId={chapter.id}
          chapterNumber={chapter.number}
          readingDirection={chapter.readingDirection}
          pages={pages}
        />
      )}

      <p className="mt-14 border-t border-line pt-6 text-sm text-muted">
        Les aperçus sont servis par des liens signés valables une minute. Aucune
        page n&apos;a d&apos;adresse permanente : un lien copié cesse de
        fonctionner.
      </p>
    </main>
  )
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'brouillon',
    processing: 'en traitement',
    review: 'à revoir',
    published: 'publié',
    failed: 'échec',
  }
  return labels[status] ?? status
}
