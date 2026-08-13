'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { advanceQueueAction, clearQueueAction } from './actions.ts'

/**
 * What is waiting, and why it is waiting.
 *
 * A queue that advances on an event happening elsewhere — publishing a review —
 * is the kind of thing that reads as broken the moment you forget the rule. So
 * the panel states the rule, names the event, and offers the two ways out: run
 * the next one now, or stop the queue.
 *
 * The escape hatch is not a convenience. The chain waits for a publication, and
 * a publication is something only you can do; if you decide not to review the
 * chapter it is waiting on, nothing else will ever release it.
 */

interface Props {
  chapters: Array<{ id: string; number: number; title: string | null }>
}

export function QueuePanel({ chapters }: Props) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)

  if (chapters.length === 0) return null

  function startNext(): void {
    setMessage(null)
    startTransition(async () => {
      const outcome = await advanceQueueAction()
      if (outcome.ok) {
        setRunId(outcome.runId ?? null)
        setMessage(`Chapitre ${outcome.chapterNumber} : traitement lancé.`)
      } else {
        setMessage(outcome.error ?? 'Démarrage impossible.')
      }
    })
  }

  function abandon(): void {
    setMessage(null)
    startTransition(async () => {
      const outcome = await clearQueueAction()
      setMessage(
        outcome.ok
          ? `File vidée : ${outcome.cleared} chapitre(s) restent importés, sans traitement programmé.`
          : (outcome.error ?? 'Opération impossible.'),
      )
    })
  }

  return (
    <section className="mt-10 border-[3px] border-ink bg-surface-raised p-4" style={{ boxShadow: 'var(--shadow-hard)' }}>
      <h2 className="font-display text-lg uppercase text-primary">
        En attente de leur tour
        <span className="ml-2 font-sans text-sm normal-case text-muted">
          {chapters.length} chapitre{chapters.length > 1 ? 's' : ''}
        </span>
      </h2>

      <p className="mt-1 max-w-2xl text-sm text-secondary">
        Chacun démarre à la publication du chapitre précédent. Le rapprochement
        des entités ne compare une proposition qu’à ce qui est <em>déjà</em> dans
        le graphe&nbsp;: les traiter tout de suite, c’est perdre les questions
        d’identité — un alias nommé au chapitre suivant devient deux entités,
        sans que rien ne vous le demande.
      </p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {chapters.map((chapter) => (
          <li key={chapter.id}>
            <Link
              href={`/chapitres/${chapter.id}`}
              className="badge badge-gris hover:underline"
              title={chapter.title ?? undefined}
            >
              {chapter.number}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={startNext}
          disabled={pending}
          className="bouton !py-1.5 !text-sm"
        >
          Traiter le {chapters[0]!.number} maintenant
        </button>
        <button
          type="button"
          onClick={abandon}
          disabled={pending}
          className="bouton !py-1.5 !text-sm"
        >
          Vider la file
        </button>
        <span className="text-sm text-muted">
          Vider la file ne supprime rien&nbsp;: les textes restent importés.
        </span>
      </div>

      {message && (
        <p role="status" className="mt-3 text-sm text-primary">
          {message}{' '}
          {runId && (
            <Link href={`/runs/${runId}`} className="text-accent hover:underline">
              Suivre le traitement
            </Link>
          )}
        </p>
      )}
    </section>
  )
}
