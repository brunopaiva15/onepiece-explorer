'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { queueTickAction, type QueueTickResult } from './import/actions.ts'

/**
 * The lot, followed from wherever you happen to be.
 *
 * A chapter that publishes itself starts the next one inside the same
 * invocation, which is what makes a lot run without anyone watching. That
 * invocation has a ceiling, so the chain stops at a chapter boundary when its
 * window is spent — and something has to pick the queue up afterwards.
 *
 * It used to be the import page, and only the import page. That is exactly
 * where nobody is: you import a lot, you go and look at the chapters, and the
 * chain stops the moment the invocation ends with no page left to nudge it. So
 * the watcher lives in the workshop's layout — any page of `/admin` keeps a lot
 * moving, and the one you are on tells you where it is.
 *
 * It costs one query on a page where nothing is running: the first tick finds
 * an empty queue, nothing waiting, and stops. Polling only continues while
 * there is a lot to follow.
 */

/** Between two ticks, while a lot is in flight. */
const TICK_MS = 5_000

export function ChainWatcher() {
  const [status, setStatus] = useState<QueueTickResult | null>(null)
  const [halted, setHalted] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const ticking = useRef(false)
  /*
   * Whether this page has seen a lot actually running.
   *
   * Two things hang on it, and both would be wrong without it: the panel stays
   * invisible on a workshop where nothing is happening, and the closing sweep
   * for illustrations fires once at the end of a lot rather than on every page
   * load — see `queueTickAction`.
   */
  const sawWork = useRef(false)

  const tick = useCallback(async () => {
    if (ticking.current) return
    ticking.current = true
    try {
      const outcome = await queueTickAction(sawWork.current)

      const busy =
        outcome.queued > 0 || outcome.running !== null || outcome.blocked !== null
      if (busy) sawWork.current = true

      // Silent about a workshop with nothing in flight — including the failure
      // to answer at all, which on `/admin/connexion` is the correct answer.
      if (!sawWork.current) {
        setHalted(true)
        return
      }

      setStatus(outcome)
      if (!outcome.ok || !busy) setHalted(true)
    } catch {
      setHalted(true)
    } finally {
      ticking.current = false
    }
  }, [])

  useEffect(() => {
    if (halted) return
    // Both ticks are scheduled rather than one being called here: the effect
    // body itself must not reach into state, and the first answer arriving a
    // turn later is invisible next to a five-second poll.
    const first = setTimeout(() => void tick(), 0)
    const timer = setInterval(() => void tick(), TICK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [halted, tick])

  if (status === null || dismissed) return null

  return (
    <aside
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-sm border-[3px] border-ink bg-surface-raised p-3 text-sm"
      style={{ boxShadow: 'var(--shadow-hard)' }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-display text-sm uppercase text-primary">
          Lot en cours
        </span>
        {status.queued > 0 && (
          <span className="text-muted">{status.queued} en attente</span>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Masquer le suivi du lot"
          className="ml-auto text-muted hover:text-primary"
        >
          ×
        </button>
      </div>

      <p className="mt-1.5 text-secondary">
        <ChainSentence status={status} halted={halted} />
      </p>

      {halted && status.queued > 0 && (
        <button
          type="button"
          onClick={() => setHalted(false)}
          className="bouton mt-2 !py-1 !text-xs"
        >
          Reprendre
        </button>
      )}
    </aside>
  )
}

/** Where the chain is, and the one link that does something about it. */
function ChainSentence({
  status,
  halted,
}: {
  status: QueueTickResult
  halted: boolean
}) {
  if (status.error) return <>Arrêtée&nbsp;: {status.error}</>

  if (status.blocked) {
    const { blocked } = status
    if (blocked.reason === 'review') {
      return (
        <>
          Le chapitre {blocked.chapterNumber} a gardé une question pour vous, et
          la suite l’attend.{' '}
          {blocked.runId && (
            <Link
              href={`/admin/review/${blocked.runId}`}
              className="text-accent hover:underline"
            >
              Y répondre
            </Link>
          )}
        </>
      )
    }
    return (
      <>
        Le chapitre {blocked.chapterNumber}{' '}
        {blocked.reason === 'failed' ? 'a échoué' : 'n’a pas de traitement'}.{' '}
        <Link
          href={`/admin/chapitres/${blocked.chapterId}`}
          className="text-accent hover:underline"
        >
          Ouvrir le chapitre
        </Link>
      </>
    )
  }

  if (status.running?.stalled) {
    return (
      <>
        Plus rien ne bouge sur le chapitre {status.running.chapterNumber}.{' '}
        <Link
          href={`/admin/chapitres/${status.running.chapterId}`}
          className="text-accent hover:underline"
        >
          Le relancer
        </Link>
      </>
    )
  }

  if (status.running) {
    return (
      <>
        Chapitre {status.running.chapterNumber} en cours.{' '}
        <Link
          href={`/admin/runs/${status.running.runId}`}
          className="text-accent hover:underline"
        >
          Suivre
        </Link>
      </>
    )
  }

  if (status.queued === 0) return <>Tout le lot est traité et ouvert.</>

  return <>{halted ? 'En pause.' : 'Chapitre suivant dans un instant…'}</>
}
