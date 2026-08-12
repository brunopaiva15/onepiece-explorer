import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { ask } from '@/domains/assistant/answer.ts'
import { hasModelCredentials, isAssistantEnabled } from '@/lib/env.ts'
import { getDict } from '@/lib/i18n/server.ts'

export async function generateMetadata(): Promise<Metadata> {
  const dict = await getDict()
  return { title: dict.ask.metaTitle }
}
export const dynamic = 'force-dynamic'

/**
 * Ask a question about what you have read.
 *
 * A GET form rather than a server action, so an answer is a URL: linkable,
 * reloadable, and openable at two different boundaries side by side to see what
 * you knew then versus now. That comparison is most of the point.
 *
 * "Insufficient data" is presented as an answer, in the same weight of type as
 * any other, rather than as an apology in small print. It is the correct result
 * for a question the reader's chapters do not cover, and dressing it as a
 * failure would push future versions towards guessing.
 */
export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; q?: string }>
}) {
  const { ch, q } = await searchParams
  const session = await getReaderSession(ch)
  const t = (await getDict()).ask

  const question = (q ?? '').trim()
  const answer = question
    ? await ask(session.userId, session.boundaryChapter, question, session.locale)
    : null

  return (
    <>

      <main id="contenu" className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-3xl font-semibold text-primary">{t.pageTitle}</h1>
        <p className="mt-2 max-w-2xl text-secondary">{t.intro}</p>

        {!isAssistantEnabled() && (
          <div
            role="note"
            className="mt-5 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-4 text-sm"
          >
            <p className="text-primary">
              <strong className="font-medium">{t.disabledNoticeStrong}</strong>{' '}
              {t.disabledNoticeBody}
            </p>
            <p className="mt-2 text-secondary">
              {t.disabledAltLead}{' '}
              <Link
                href={`/recherche?ch=${session.boundaryChapter}`}
                className="text-accent underline"
              >
                {t.disabledAltSearchLink}
              </Link>{' '}
              {t.disabledAltMid}{' '}
              <Link
                href={`/recherche?ch=${session.boundaryChapter}`}
                className="text-accent underline"
              >
                {t.disabledAltPathLink}
              </Link>{' '}
              {t.disabledAltTail}
            </p>
            <p className="mt-2 text-xs text-muted">
              {t.disabledEnableLead} <code>ASSISTANT_ENABLED=1</code>{' '}
              {t.disabledEnableIn} <code>.env.local</code>.
            </p>
          </div>
        )}

        {isAssistantEnabled() && !hasModelCredentials() && (
          <p
            role="note"
            className="mt-5 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-4 text-sm text-primary"
          >
            <strong className="font-medium">{t.noKeyStrong}</strong> {t.noKeyBody}
          </p>
        )}

        <form action="/ask" method="get" className="mt-6 flex flex-wrap gap-2">
          <input type="hidden" name="ch" value={session.boundaryChapter} />
          <input
            name="q"
            type="search"
            defaultValue={question}
            placeholder={t.questionPlaceholder}
            aria-label={t.questionAriaLabel}
            className="min-w-64 flex-1 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          />
          <button
            type="submit"
            className="rounded-sm bg-accent px-5 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
          >
            {t.submit}
          </button>
        </form>

        {answer && (
          <section className="mt-8">
            <div
              className={`rounded-sm border p-5 ${
                answer.insufficientData
                  ? 'border-[var(--epi-hypothetical)] bg-surface-raised'
                  : 'border-line bg-surface-raised'
              }`}
            >
              {answer.insufficientData && (
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--epi-hypothetical)]">
                  {t.insufficientData}
                </p>
              )}
              <p className="mt-1 whitespace-pre-line text-primary">{answer.answer}</p>
            </div>

            {answer.citations.length > 0 && (
              <section className="mt-6">
                <h2 className="text-lg font-semibold text-primary">
                  {t.sourcesHeading(answer.citations.length)}
                </h2>
                <ul className="mt-3 space-y-2">
                  {answer.citations.map((citation) => (
                    <li
                      key={citation.assertionId}
                      className="rounded-sm border border-line bg-surface-raised p-3"
                    >
                      <blockquote className="border-l-2 border-accent pl-2.5 text-sm text-primary">
                        {citation.excerpt}
                      </blockquote>
                      <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-xs text-muted">
                        <span>{t.citationChapter(citation.chapter)}</span>
                        <span>{citation.statement}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {answer.droppedCitations.length > 0 && (
              /*
               * Shown, not swallowed. A model citing sources that do not exist
               * is the single most important thing this page can tell you about
               * how much to trust the rest of the answer, and hiding it would
               * make the product look better while making it less useful.
               */
              <section className="mt-6">
                <h2 className="text-sm font-semibold text-[var(--epi-contradicted)]">
                  {t.droppedHeading(answer.droppedCitations.length)}
                </h2>
                <ul className="mt-2 space-y-1 text-sm text-secondary">
                  {answer.droppedCitations.map((dropped) => (
                    <li key={dropped.assertionId}>
                      <code className="font-mono text-xs">{dropped.assertionId}</code>{' '}
                      — {dropped.why}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {answer.notes.length > 0 && (
              <ul className="mt-6 space-y-1 text-xs text-muted">
                {answer.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}

            {answer.entityIds.length > 0 && (
              <p className="mt-4 text-xs text-muted">
                {t.entitiesConsulted}{' '}
                {answer.entityIds.slice(0, 8).map((id, index) => (
                  <span key={id}>
                    {index > 0 && ', '}
                    <Link
                      href={`/entite/${id}?ch=${session.boundaryChapter}`}
                      className="text-accent hover:underline"
                    >
                      {t.entitySheetLink}
                    </Link>
                  </span>
                ))}
              </p>
            )}

            {answer.costCents > 0 && (
              <p className="mt-2 font-mono text-xs text-muted">
                {t.answerCost((answer.costCents / 100).toFixed(4))}
              </p>
            )}
          </section>
        )}
      </main>
    </>
  )
}
