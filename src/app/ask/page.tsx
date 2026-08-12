import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { ask } from '@/domains/assistant/answer.ts'
import { hasModelCredentials, isAssistantEnabled } from '@/lib/env.ts'

export const metadata: Metadata = { title: 'Question' }
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

  const question = (q ?? '').trim()
  const answer = question
    ? await ask(session.userId, session.boundaryChapter, question)
    : null

  return (
    <>

      <main id="contenu" className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-3xl font-semibold text-primary">Poser une question</h1>
        <p className="mt-2 max-w-2xl text-secondary">
          La réponse est construite à partir des seules assertions validées de vos
          chapitres lus, et chaque affirmation est reliée à la case qui la prouve.
          Si la réponse ne s&apos;y trouve pas, elle vous le dira.
        </p>

        {!isAssistantEnabled() && (
          <div
            role="note"
            className="mt-5 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-4 text-sm"
          >
            <p className="text-primary">
              <strong className="font-medium">
                L&apos;assistant conversationnel est désactivé.
              </strong>{' '}
              Il se facture à la question, indéfiniment, et cet outil est un
              explorateur de graphe — pas un moteur de réponses payant.
            </p>
            <p className="mt-2 text-secondary">
              La{' '}
              <Link
                href={`/recherche?ch=${session.boundaryChapter}`}
                className="text-accent underline"
              >
                recherche
              </Link>{' '}
              cherche dans exactement les mêmes données, gratuitement, et vous
              montre les extraits sans les reformuler. Le{' '}
              <Link
                href={`/recherche?ch=${session.boundaryChapter}`}
                className="text-accent underline"
              >
                chemin entre deux entités
              </Link>{' '}
              y répond même à des questions que celui-ci ne sait pas traiter.
            </p>
            <p className="mt-2 text-xs text-muted">
              Pour l&apos;activer malgré tout : <code>ASSISTANT_ENABLED=1</code>{' '}
              dans <code>.env.local</code>.
            </p>
          </div>
        )}

        {isAssistantEnabled() && !hasModelCredentials() && (
          <p
            role="note"
            className="mt-5 rounded-sm border border-[var(--epi-hypothetical)] bg-surface-raised p-4 text-sm text-primary"
          >
            <strong className="font-medium">Aucune clé Anthropic configurée.</strong>{' '}
            Le mode sans modèle retrouve les assertions correspondantes et vous les
            montre telles quelles, sans les reformuler — il ne compose pas de
            phrases qu&apos;il ne pourrait pas soutenir.
          </p>
        )}

        <form action="/ask" method="get" className="mt-6 flex flex-wrap gap-2">
          <input type="hidden" name="ch" value={session.boundaryChapter} />
          <input
            name="q"
            type="search"
            defaultValue={question}
            placeholder="Qui a promis quoi à qui ?"
            aria-label="Votre question"
            className="min-w-64 flex-1 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          />
          <button
            type="submit"
            className="rounded-sm bg-accent px-5 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
          >
            Demander
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
                  Données insuffisantes
                </p>
              )}
              <p className="mt-1 whitespace-pre-line text-primary">{answer.answer}</p>
            </div>

            {answer.citations.length > 0 && (
              <section className="mt-6">
                <h2 className="text-lg font-semibold text-primary">
                  Sources ({answer.citations.length})
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
                        <span>chapitre {citation.chapter}</span>
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
                  {answer.droppedCitations.length} source(s) écartée(s)
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
                Entités consultées :{' '}
                {answer.entityIds.slice(0, 8).map((id, index) => (
                  <span key={id}>
                    {index > 0 && ', '}
                    <Link
                      href={`/entite/${id}?ch=${session.boundaryChapter}`}
                      className="text-accent hover:underline"
                    >
                      fiche
                    </Link>
                  </span>
                ))}
              </p>
            )}

            {answer.costCents > 0 && (
              <p className="mt-2 font-mono text-xs text-muted">
                coût de cette réponse : {(answer.costCents / 100).toFixed(4)} $
              </p>
            )}
          </section>
        )}
      </main>
    </>
  )
}
