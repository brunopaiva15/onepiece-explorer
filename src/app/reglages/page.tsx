import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { listOrphanedAssertions } from '@/domains/chapters/delete.ts'
import {
  costSummary,
  failureHealth,
  quarantineHealth,
} from '@/domains/observability/costs.ts'
import { usage } from '@/domains/observability/rate-limit.ts'
import { hasEmbeddingProvider } from '@/domains/search/index.ts'
import {
  effectiveModelProvider,
  hasModelCredentials,
  isAssistantEnabled,
  publicLibraryOwnerId,
} from '@/lib/env.ts'
import { imageCoverage } from '@/domains/images/index.ts'
import { getDict } from '@/lib/i18n/server.ts'
import { DeleteChapter } from './delete-chapter.tsx'
import { EnrichImages } from './enrich-images.tsx'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.settings.metaTitle }
}
export const dynamic = 'force-dynamic'

/**
 * Where the reader can see what the tool has cost them and take their data back.
 *
 * Both are load-bearing rather than nice-to-have. A tool that spends money on
 * your behalf and does not show you the bill is asking for trust it has not
 * earned; a private tool holding months of your reading and no way out is
 * holding it hostage.
 */
export default async function SettingsPage() {
  const session = await getReaderSession()
  const dict = await getDict()
  const t = dict.settings

  const [chapters, costs, quarantine, failures, orphans, allowances, coverage] =
    await Promise.all([
      listChapters(session.userId, session.workId),
      costSummary(session.userId),
      quarantineHealth(session.userId),
      failureHealth(session.userId),
      listOrphanedAssertions(session.userId),
      usage(session.userId),
      imageCoverage(session.userId),
    ])

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-6 py-12">
      <nav className="text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          {t.breadcrumb}
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">{t.title}</h1>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-primary">{t.configHeading}</h2>
        <dl className="mt-3 divide-y divide-[var(--border)] text-sm">
          <Row
            label={t.modelProviderLabel}
            value={effectiveModelProvider()}
            note={hasModelCredentials() ? undefined : t.modelProviderNote}
          />
          <Row
            label={t.semanticSearchLabel}
            value={hasEmbeddingProvider() ? t.semanticActive : t.semanticDisabled}
            note={hasEmbeddingProvider() ? undefined : t.semanticNote}
          />
          <Row
            label={t.assistantLabel}
            value={isAssistantEnabled() ? t.assistantActive : t.assistantDisabled}
            note={isAssistantEnabled() ? t.assistantOnNote : t.assistantOffNote}
          />
          <Row
            label={t.readingPositionLabel}
            value={
              session.followingLatest
                ? t.readingAll(session.maxChapter)
                : t.readingAt(session.boundaryChapter, session.maxChapter)
            }
          />
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">{t.costHeading}</h2>

        {costs.chaptersProcessed === 0 ? (
          <p className="mt-3 text-sm text-secondary">{t.costNone}</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-secondary">
              {t.costTotals(
                (costs.totalCents / 100).toFixed(2),
                (costs.averagePerChapterCents / 100).toFixed(3),
                costs.chaptersProcessed,
              )}
              {costs.estimateAccuracy !== null && (
                <>
                  {' '}
                  {t.estimateSentence(
                    costs.estimateAccuracy > 1.15
                      ? t.estimateOptimistic(costs.estimateAccuracy.toFixed(2))
                      : costs.estimateAccuracy < 0.85
                        ? t.estimatePessimistic(
                            (1 / costs.estimateAccuracy).toFixed(2),
                          )
                        : t.estimateFair,
                  )}
                </>
              )}
              {costs.cacheHitRate !== null && costs.cacheHitRate > 0 && (
                <>
                  {' '}
                  {t.cacheHits(Math.round(costs.cacheHitRate * 100))}
                </>
              )}
            </p>

            <table className="mt-4 w-full border-collapse text-sm">
              <caption className="sr-only">{t.costTableCaption}</caption>
              <thead>
                <tr className="border-b border-line-strong text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">{t.costColStep}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t.costColRuns}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t.costColTotal}</th>
                  <th scope="col" className="py-2 pr-3 font-medium">{t.costColTokens}</th>
                  <th scope="col" className="py-2 font-medium">{t.costColModel}</th>
                </tr>
              </thead>
              <tbody>
                {costs.byStep.map((step) => (
                  <tr key={step.stepKey} className="border-b border-line">
                    <td className="py-2 pr-3 font-mono text-xs text-primary">
                      {step.stepKey}
                    </td>
                    <td className="py-2 pr-3 text-secondary">{step.runs}</td>
                    <td className="py-2 pr-3 text-secondary">
                      {step.totalCents === 0
                        ? '—'
                        : t.dollars((step.totalCents / 100).toFixed(4))}
                    </td>
                    <td className="py-2 pr-3 text-secondary">
                      {step.tokensIn + step.tokensOut === 0
                        ? '—'
                        : `${formatCount(step.tokensIn)} / ${formatCount(step.tokensOut)}`}
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">
                      {step.modelId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">{t.publicHeading}</h2>
        <p className="mt-2 max-w-2xl text-sm text-secondary">
          {publicLibraryOwnerId() === session.userId ? (
            <>
              <strong className="font-medium text-primary">
                {t.publicOpenStrong}
              </strong>{' '}
              {t.publicOpenBody}
            </>
          ) : publicLibraryOwnerId() === null ? (
            <>
              <strong className="font-medium text-primary">
                {t.publicClosedStrong}
              </strong>{' '}
              {t.publicClosedBeforeCode}{' '}
              <code className="text-primary">PUBLIC_LIBRARY_OWNER_ID</code>{' '}
              {t.publicClosedAfterCode}
            </>
          ) : (
            <>
              <strong className="font-medium text-[var(--epi-contradicted)]">
                {t.publicMismatchStrong}
              </strong>{' '}
              <code className="text-primary">PUBLIC_LIBRARY_OWNER_ID</code>{' '}
              {t.publicMismatchAfterCode}
            </>
          )}
        </p>
        <dl className="mt-4 divide-y divide-[var(--border)] text-sm">
          <Row
            label={t.libraryIdLabel}
            value={session.userId}
            note={t.libraryIdNote}
          />
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">
          {t.illustrationsHeading}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-secondary">
          {t.illustrationsBody}
        </p>
        <EnrichImages coverage={coverage} locale={session.locale} />
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">
          {t.spendGuardHeading}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-secondary">
          {t.spendGuardBody}
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {allowances.map((allowance) => (
            <li key={allowance.action} className="flex items-baseline gap-3">
              <span className="w-56 text-secondary">
                {t.actionLabels[allowance.action]}
              </span>
              <span className="font-mono text-xs text-primary">
                {allowance.used} / {allowance.max}
              </span>
              <span className="text-xs text-muted">{t.lastHour}</span>
            </li>
          ))}
        </ul>
      </section>

      {(quarantine.length > 0 || failures.length > 0) && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold text-primary">
            {t.pipelineHeading}
          </h2>

          {quarantine.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-medium text-primary">
                {t.quarantineHeading}
              </h3>
              <p className="mt-1 text-sm text-secondary">
                {/* The distribution is the diagnostic: thirty of one reason is
                    systematic, one each of thirty is an ordinary bad day. */}
                {t.quarantineBody}
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {quarantine.map((entry) => (
                  <li key={entry.reason} className="flex gap-3">
                    <span className="font-mono text-muted">{entry.count}</span>
                    <span className="text-secondary">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {failures.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-[var(--epi-contradicted)]">
                {t.stepFailuresHeading}
              </h3>
              <ul className="mt-2 space-y-2 text-sm">
                {failures.map((entry) => (
                  <li key={entry.stepKey}>
                    <span className="font-mono text-xs text-primary">
                      {entry.stepKey}
                    </span>
                    <span className="ml-2 text-muted">
                      {t.attempts(entry.attempts)}
                    </span>
                    <p className="text-secondary">{entry.lastError}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {orphans.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold text-primary">
            {t.orphansHeading(orphans.length)}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-secondary">
            {t.orphansBody}
          </p>
          <ul className="mt-3 space-y-1 text-sm text-secondary">
            {orphans.slice(0, 20).map((orphan) => (
              <li key={orphan.id}>
                <span className="font-mono text-accent">{orphan.predicate}</span>
                <span className="ml-2 text-muted">
                  {t.orphanChapter(orphan.chapter)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">{t.dataHeading}</h2>
        <p className="mt-2 max-w-2xl text-sm text-secondary">{t.dataBody}</p>
        <a
          href="/api/export"
          download
          className="mt-4 inline-block rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          {t.dataDownload}
        </a>
      </section>

      {chapters.length > 0 && (
        <section className="mt-12 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">
            {t.deleteHeading}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-secondary">{t.deleteBody}</p>
          <DeleteChapter
            chapters={chapters.map((chapter) => ({
              id: chapter.id,
              number: chapter.number,
              title: chapter.title,
              pageCount: chapter.pageCount,
            }))}
            locale={session.locale}
          />
        </section>
      )}
    </main>
  )
}

function Row({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 py-2.5">
      <dt className="text-secondary">{label}</dt>
      <dd className="ml-auto font-mono text-xs text-primary">{value}</dd>
      {note && <p className="w-full text-xs text-muted">{note}</p>}
    </div>
  )
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
