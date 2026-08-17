'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  advanceQueueAction,
  clearQueueAction,
  queueTickAction,
  type QueueTickResult,
} from './actions.ts'

/**
 * What is waiting, and why it is waiting.
 *
 * A queue that advances on an event happening elsewhere — a publication — is
 * the kind of thing that reads as broken the moment you forget the rule. So the
 * panel states the rule, names the event, and offers the two ways out: run the
 * next one now, or stop the queue.
 *
 * For a lot imported to publish itself, the panel is also what makes the chain
 * run. Not because the chain needs a client to decide anything — every decision
 * is on the server, in `queueTickAction` — but because the pipeline runs inside
 * the invocation that started it, under a five-minute ceiling. Chaining twenty
 * chapters inside one invocation would put that ceiling in the middle of
 * whichever chapter was running when it arrived, killing it with nothing
 * recorded to explain it. A tick from this page buys each chapter an invocation
 * of its own, which is the shape that never does that.
 *
 * The cost of that choice, said plainly on screen: close the page and the lot
 * pauses between two chapters. Nothing is lost and reopening it resumes — but a
 * reader who expected twenty chapters and comes back to seven deserves to have
 * been told, not to work it out.
 */

/** Between two ticks. Long enough to be free, short enough to feel immediate. */
const TICK_MS = 5_000

interface Props {
  chapters: Array<{ id: string; number: number; title: string | null; autoReview: boolean }>
}

export function QueuePanel({ chapters }: Props) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<QueueTickResult | null>(null)

  /*
   * Stopped, as opposed to between two ticks.
   *
   * Three ways to get here and they are all deliberate: the lot finished, the
   * queue refused to advance — the hourly run ceiling, nearly always, which
   * means "later" and not "never" — or you emptied the file. A page that kept
   * ticking against a refusal would spend the rest of the hour asking.
   */
  const [halted, setHalted] = useState(false)
  const ticking = useRef(false)

  /*
   * Both of these are sticky, and for the same reason.
   *
   * The props come from the server and shrink as the chain claims chapters, so
   * by the last one they are empty — a panel keyed on them would vanish while
   * the chapter it was watching is still running, taking the ticker and the
   * final word with it. What was true once about this lot stays true until the
   * lot is over.
   *
   * Adjusted during render rather than from an effect: this is state derived
   * from props, and React re-renders before committing, so nothing flashes and
   * no cascade is scheduled.
   */
  const [everQueued, setEverQueued] = useState(false)
  const [automatic, setAutomatic] = useState(false)
  const [seenCount, setSeenCount] = useState(chapters.length)

  if (!everQueued && chapters.length > 0) setEverQueued(true)
  if (!automatic && chapters.some((chapter) => chapter.autoReview)) setAutomatic(true)
  if (chapters.length !== seenCount) {
    setSeenCount(chapters.length)
    // A queue that grew is a second lot arriving on a page that never
    // reloaded. Whatever stopped the previous one has been answered by the act
    // of importing again.
    if (chapters.length > seenCount && halted) setHalted(false)
  }

  const tick = useCallback(async () => {
    if (ticking.current) return
    ticking.current = true
    try {
      const outcome = await queueTickAction()
      setStatus(outcome)
      if (outcome.started) setRunId(outcome.started.runId)
      // Finished, or refused. Either way there is nothing for the next tick to
      // do, and the finished case must not re-trigger the closing sweep.
      const idle =
        outcome.queued === 0 && outcome.running === null && outcome.blocked === null
      if (!outcome.ok || idle) setHalted(true)
    } finally {
      ticking.current = false
    }
  }, [])

  useEffect(() => {
    if (!automatic || halted) return
    void tick()
    const timer = setInterval(() => void tick(), TICK_MS)
    return () => clearInterval(timer)
  }, [automatic, halted, tick])

  function startNext(): void {
    setMessage(null)
    setHalted(false)
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
    setHalted(true)
    startTransition(async () => {
      const outcome = await clearQueueAction()
      setMessage(
        outcome.ok
          ? `File vidée : ${outcome.cleared} chapitre(s) restent importés, sans traitement programmé.`
          : (outcome.error ?? 'Opération impossible.'),
      )
    })
  }

  if (!everQueued && chapters.length === 0) return null

  const waiting = status?.queued ?? chapters.length

  return (
    <section
      className="mt-10 border-[3px] border-ink bg-surface-raised p-4"
      style={{ boxShadow: 'var(--shadow-hard)' }}
    >
      <h2 className="font-display text-lg uppercase text-primary">
        {waiting > 0 ? 'En attente de leur tour' : 'Fin du lot'}
        {waiting > 0 && (
          <span className="ml-2 font-sans text-sm normal-case text-muted">
            {waiting} chapitre{waiting > 1 ? 's' : ''}
          </span>
        )}
      </h2>

      <p className="mt-1 max-w-2xl text-sm text-secondary">
        {automatic ? (
          <>
            Ils s’enchaînent tout seuls&nbsp;: chacun démarre quand le précédent
            s’est ouvert, et un chapitre ne s’ouvre que s’il n’a plus rien à
            demander. Sinon la chaîne s’arrête là et attend votre réponse — le
            rapprochement des entités ne compare une proposition qu’à ce qui est{' '}
            <em>déjà</em> dans le graphe, et c’est justement l’entité en question
            qui y manquerait. <strong>Gardez cette page ouverte</strong>&nbsp;:
            c’est elle qui donne à chaque chapitre son propre traitement.
          </>
        ) : (
          <>
            Chacun démarre à la publication du chapitre précédent. Le
            rapprochement des entités ne compare une proposition qu’à ce qui est{' '}
            <em>déjà</em> dans le graphe&nbsp;: les traiter tout de suite, c’est
            perdre les questions d’identité : un alias nommé au chapitre suivant
            devient deux entités, sans que rien ne vous le demande.
          </>
        )}
      </p>

      {chapters.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {chapters.map((chapter) => (
            <li key={chapter.id}>
              <Link
                href={`/admin/chapitres/${chapter.id}`}
                className="badge badge-gris hover:underline"
                title={chapter.title ?? undefined}
              >
                {chapter.number}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {status && <ChainState status={status} halted={halted} />}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {chapters.length > 0 && (
          <button
            type="button"
            onClick={startNext}
            disabled={pending}
            className="bouton !py-1.5 !text-sm"
          >
            Traiter le {chapters[0]!.number} maintenant
          </button>
        )}
        {automatic && halted && waiting > 0 && (
          <button
            type="button"
            onClick={() => setHalted(false)}
            className="bouton !py-1.5 !text-sm"
          >
            Reprendre la chaîne
          </button>
        )}
        {chapters.length > 0 && (
          <>
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
          </>
        )}
      </div>

      {message && (
        <p role="status" className="mt-3 text-sm text-primary">
          {message}{' '}
          {runId && (
            <Link href={`/admin/runs/${runId}`} className="text-accent hover:underline">
              Suivre le traitement
            </Link>
          )}
        </p>
      )}
    </section>
  )
}

/**
 * The chain's own state, in the words the next action needs.
 *
 * The one that matters is `blocked`, because it is the only state where the
 * chain is stopped on purpose and this page is the only place that says so.
 * Naming the chapter and linking the page that unblocks it is the difference
 * between « la file ne bouge plus » and one click.
 */
function ChainState({ status, halted }: { status: QueueTickResult; halted: boolean }) {
  if (status.error) {
    return (
      <p
        role="alert"
        className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink"
      >
        La chaîne s’est arrêtée&nbsp;: {status.error}
      </p>
    )
  }

  if (status.blocked) {
    const { blocked } = status
    return (
      <p
        role="status"
        className="mt-3 border-[3px] border-ink bg-surface-overlay px-3 py-2 text-sm text-primary"
      >
        {blocked.reason === 'review' && (
          <>
            Le chapitre {blocked.chapterNumber} a gardé des questions pour
            vous&nbsp;: un nom, une identité ou une contradiction, que rien
            d’autre ne peut trancher. La suite du lot attend cette réponse.{' '}
            {blocked.runId && (
              <Link
                href={`/admin/review/${blocked.runId}`}
                className="text-accent hover:underline"
              >
                Répondre maintenant
              </Link>
            )}
          </>
        )}
        {blocked.reason === 'failed' && (
          <>
            Le traitement du chapitre {blocked.chapterNumber} a échoué.
            Relancez-le depuis sa page&nbsp;: les tranches déjà payées sont
            rejouées, pas rachetées.{' '}
            <Link
              href={`/admin/chapitres/${blocked.chapterId}`}
              className="text-accent hover:underline"
            >
              Ouvrir le chapitre {blocked.chapterNumber}
            </Link>
          </>
        )}
        {blocked.reason === 'unprocessed' && (
          <>
            Le chapitre {blocked.chapterNumber} du lot n’a aucun traitement en
            cours. S’il ne démarre pas dans quelques secondes, lancez-le depuis{' '}
            <Link
              href={`/admin/chapitres/${blocked.chapterId}`}
              className="text-accent hover:underline"
            >
              sa page
            </Link>
            .
          </>
        )}
      </p>
    )
  }

  if (status.running?.stalled) {
    return (
      <p
        role="alert"
        className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink"
      >
        Plus rien ne bouge sur le chapitre {status.running.chapterNumber} depuis
        plusieurs minutes. Le traitement a probablement été interrompu avant
        d’avoir pu enregistrer son échec.{' '}
        <Link href={`/admin/chapitres/${status.running.chapterId}`} className="underline">
          Relancez-le
        </Link>{' '}
        : les tranches déjà payées sont rejouées, pas rachetées.
      </p>
    )
  }

  if (status.running) {
    return (
      <p role="status" className="mt-3 text-sm text-secondary">
        Chapitre {status.running.chapterNumber} en cours.{' '}
        <Link
          href={`/admin/runs/${status.running.runId}`}
          className="text-accent hover:underline"
        >
          Suivre le traitement
        </Link>
      </p>
    )
  }

  if (status.queued === 0) {
    return (
      <p role="status" className="mt-3 text-sm text-secondary">
        Tout le lot est traité et ouvert. Les illustrations manquantes sont
        récupérées en arrière-plan.
      </p>
    )
  }

  return (
    <p role="status" className="mt-3 text-sm text-muted">
      {halted ? 'Chaîne en pause.' : 'Prochain chapitre dans un instant…'}
    </p>
  )
}
