import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getReaderSession } from '@/domains/auth/session.ts'
import { quarantineSummary } from '@/domains/pipeline/quarantine.ts'
import { getReviewQueue } from '@/domains/review/queue.ts'
import { getDict } from '@/lib/i18n/server.ts'
import { ReviewBoard } from './review-board.tsx'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.review.metaTitle }
}
/** Signed evidence URLs expire within the minute; never cache this render. */
export const dynamic = 'force-dynamic'

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const { runId } = await params
  const session = await getReaderSession()
  const dict = await getDict()
  const t = dict.review

  const queue = await getReviewQueue(session.userId, runId)
  if (!queue) notFound()

  const quarantined = await quarantineSummary(session.userId, runId)

  return (
    <main id="contenu" className="mx-auto max-w-[1500px] px-4 py-4">
      {/*
       * A triage station, not an article.
       *
       * The page opened with a breadcrumb, a 4xl title, a subtitle and a
       * paragraph explaining the review model — four blocks of reading before
       * the first proposal, every single time, on a screen someone visits with
       * eighty decisions to make. The explanation is true and it belongs
       * somewhere; it does not belong between you and the work, every session.
       */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link
          href={`/runs/${runId}`}
          className="font-display text-sm uppercase text-muted no-underline hover:text-primary"
        >
          {t.backToRun}
        </Link>
        <h1 className="font-display text-2xl uppercase leading-none text-primary">
          {t.heading(queue.chapterNumber)}
        </h1>
        {queue.chapterTitle && (
          <span className="truncate text-secondary">{queue.chapterTitle}</span>
        )}
        {queue.counts.requiringExplicitReview > 0 && (
          <span className="badge badge-or ml-auto">
            {t.explicitReviewCount(queue.counts.requiringExplicitReview)}
          </span>
        )}
      </div>

      <ReviewBoard queue={serialisable(queue)} locale={session.locale} />

      {quarantined.length > 0 && (
        <details className="panneau mt-8">
          <summary className="panneau-titre cursor-pointer list-none">
            {t.quarantineTitle}
            <span className="font-sans text-xs normal-case opacity-80">
              {t.quarantineCount(quarantined.reduce((sum, e) => sum + e.count, 0))}
            </span>
          </summary>
          <div className="panneau-corps">
            <p className="max-w-3xl text-sm text-secondary">
              {t.quarantineBody1}
              <strong>{t.quarantineNot}</strong>
              {t.quarantineBody2}
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {quarantined.map((entry) => (
                <li key={entry.reason} className="flex gap-3">
                  <span className="chiffre text-lg">{entry.count}</span>
                  <span className="text-secondary">
                    {t.quarantineReasons[entry.reason] ?? entry.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

    </main>
  )
}

/** Dates cross to the client as strings; send one shape, not two. */
function serialisable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
