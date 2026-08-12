'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { RunView } from '@/domains/pipeline/runs.ts'

/**
 * Live progress for one run.
 *
 * The whole pipeline is listed from the first render, including steps that have
 * not started and steps that are not built yet. A progress view that grows one
 * row at a time cannot answer "how much is left", and a spinner answers
 * nothing at all.
 *
 * Every step shows its own duration and its own cost. That is the only way to
 * find out which step is expensive, and it is the number the cost estimate has
 * to be checked against — an estimate nobody compares to reality is decoration.
 */

const LABELS: Record<string, string> = {
  pending: 'en attente',
  running: 'en cours',
  succeeded: 'terminé',
  failed: 'échec',
  skipped: 'ignoré',
  cached: 'réutilisé',
}

/**
 * How long a silent run may stay silent before the page says so.
 *
 * A little above the route's `maxDuration`: below it, a slow but living run
 * would be accused of being dead.
 */
const STALL_AFTER_MS = 6 * 60 * 1_000

export function RunProgress({ initial }: { initial: RunView }) {
  const [view, setView] = useState<RunView>(initial)
  /**
   * Only ever set from an event handler, never from the effect body. A
   * "connection is closed because the run finished" state would be derived
   * data pretending to be state — `terminal` already says it.
   */
  const [streamBroken, setStreamBroken] = useState(false)
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(view.run.status)

  /*
   * A run that stopped without saying so.
   *
   * The pipeline runs inside the invocation that started it, so an invocation
   * killed at the platform's duration ceiling takes the run with it — mid-call,
   * with no chance to record a failure. The row stays `running` on whichever
   * step it had reached, and the page shows a spinner that will never resolve.
   *
   * Nothing can detect this from inside; the process that would have written
   * the failure is the process that died. What *can* be said is that no step
   * has changed in longer than any step should take, which is not proof but is
   * the right thing to put on screen — an honest "this looks dead, relaunch it"
   * beats a spinner that means nothing.
   */
  const startedAt = view.run.startedAt ? new Date(view.run.startedAt).getTime() : 0
  // When work was last known to finish: the start, plus every step that has
  // recorded a duration. Server truth, so it needs no client bookkeeping and
  // cannot drift with a reconnection.
  const workedFor = view.steps.reduce((total, step) => total + (step.durationMs ?? 0), 0)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (terminal) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [terminal])

  const stalled =
    !terminal &&
    view.run.status === 'running' &&
    startedAt > 0 &&
    now - (startedAt + workedFor) > STALL_AFTER_MS
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (terminal) return

    const source = new EventSource(`/api/runs/${initial.run.id}/stream`)
    sourceRef.current = source

    source.addEventListener('state', (event) => {
      setView(JSON.parse((event as MessageEvent<string>).data) as RunView)
      setStreamBroken(false)
    })
    source.addEventListener('timeout', () => {
      source.close()
    })
    source.addEventListener('error', () => {
      // EventSource reconnects on its own; this only reports that the last
      // attempt failed, so the user is not left trusting a stale bar.
      setStreamBroken(true)
    })

    return () => {
      source.close()
      sourceRef.current = null
    }
  }, [initial.run.id, terminal])

  const done = view.steps.filter((s) =>
    ['succeeded', 'skipped', 'cached'].includes(s.status),
  ).length
  const failed = view.steps.some((s) => s.status === 'failed')

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-sm text-secondary">
          {done} / {view.steps.length} étapes
        </p>
        <p className="text-sm text-muted">
          {statusSentence(view.run.status)}
          {streamBroken && !terminal && ' · connexion au flux perdue, reconnexion'}
        </p>
        {stalled && (
          <p
            role="status"
            className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink"
          >
            Plus rien ne bouge depuis plusieurs minutes. Le traitement a
            probablement été interrompu avant d&apos;avoir pu enregistrer son
            échec. Relancez-le depuis le chapitre&nbsp;: les tranches déjà
            payées sont rejouées, pas rachetées.
          </p>
        )}
        {view.run.totalCostCents > 0 && (
          <p className="text-sm text-muted">
            coût réel {(view.run.totalCostCents / 100).toFixed(2)} $
          </p>
        )}
        {/* Which model answered. Without it two runs of the same chapter are
            two sets of numbers with no way to tell what produced them, which
            makes the comparison the choice exists for impossible after the
            fact. */}
        <p className="text-sm text-muted">{providerSentence(view.run.provider)}</p>
      </div>

      <div
        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={view.steps.length}
        aria-valuenow={done}
        aria-label="Progression du pipeline"
      >
        <div
          className={`h-full transition-[width] duration-500 ${
            failed ? 'bg-[var(--epi-contradicted)]' : 'bg-accent'
          }`}
          style={{ width: `${(done / view.steps.length) * 100}%` }}
        />
      </div>

      {view.run.error && (
        <p
          role="alert"
          className="mt-4 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-3 text-sm text-primary"
        >
          {view.run.error}
        </p>
      )}

      {/*
        * Nine tiles, not nine paragraphs.
        *
        * This was a stack of rows in which the step name, its state, its
        * duration, its cost and a two-line explanation of what the step does
        * all sat at roughly the same weight — a wall of text you had to read to
        * find the one line that had changed. A tile carries its state as a
        * colour and a number you can see from across the desk; the explanation
        * is only shown for the step that is running, failed, or skipped for a
        * reason, because those are the only ones where it tells you anything.
        */}
      <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {view.steps.map((step, index) => {
          const tone = toneFor(step.status)
          const explain = step.error ?? step.note
          const showExplain =
            step.status === 'failed' ||
            step.status === 'running' ||
            step.status === 'skipped' ||
            !step.implemented

          return (
            <li
              key={step.key}
              className={`panneau flex flex-col ${step.implemented ? '' : 'opacity-70'}`}
              style={{ boxShadow: 'var(--shadow-hard-sm)' }}
            >
              <div
                className="flex items-center gap-2 border-b-[3px] border-ink px-2.5 py-1.5"
                style={{ background: tone.bg, color: tone.fg }}
              >
                <span className="chiffre text-2xl leading-none opacity-70">{index + 1}</span>
                <span className="font-display text-sm uppercase leading-tight">
                  {LABELS[step.status] ?? step.status}
                </span>
                {step.attempt > 1 && (
                  <span className="ml-auto font-display text-xs uppercase opacity-80">
                    essai {step.attempt}
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col px-2.5 py-2">
                <p className="font-display text-base uppercase leading-tight text-primary">
                  {step.label}
                </p>

                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {step.usesModel && (
                    <span className="badge badge-gris !text-[0.65rem]" title="Cette étape appelle un modèle">
                      modèle
                    </span>
                  )}
                  {step.durationMs !== null && step.durationMs > 0 && (
                    <span className="tabular text-xs text-muted">
                      {formatDuration(step.durationMs)}
                    </span>
                  )}
                  {step.costCents > 0 && (
                    <span className="tabular text-xs text-muted">
                      {(step.costCents / 100).toFixed(3)} $
                    </span>
                  )}
                </div>

                {showExplain && explain && (
                  <p className="mt-2 border-l-[3px] border-ink pl-2 text-xs text-secondary">
                    {explain}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/*
       * Everything the database knows, laid out as a table.
       *
       * The step rows have recorded tokens, model id and per-attempt timings
       * since the first version of the pipeline, and none of it was on screen.
       * That is how "why is extraction slow" became unanswerable from the page:
       * output tokens *are* the wait — a call that writes twelve thousand of
       * them takes three minutes and no amount of watching a spinner says so.
       *
       * Open by default. This is an admin screen for one person, and the whole
       * reason to look at it is to find out what happened.
       */}
      <details open className="panneau mt-8">
        <summary className="panneau-titre cursor-pointer select-none">
          Détails techniques
        </summary>
        <div className="panneau-corps overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b-[3px] border-ink text-left">
                <th className="py-1.5 pr-3">étape</th>
                <th className="py-1.5 pr-3">état</th>
                <th className="py-1.5 pr-3 text-right">essai</th>
                <th className="py-1.5 pr-3 text-right">durée</th>
                <th className="py-1.5 pr-3 text-right">tok. in</th>
                <th className="py-1.5 pr-3 text-right">tok. out</th>
                <th className="py-1.5 pr-3 text-right">cache r/w</th>
                <th className="py-1.5 pr-3 text-right">coût ¢</th>
                <th className="py-1.5">modèle</th>
              </tr>
            </thead>
            <tbody>
              {view.steps.map((step) => (
                <tr key={step.key} className="border-b border-line align-top">
                  <td className="py-1.5 pr-3">{step.key}</td>
                  <td className="py-1.5 pr-3">{step.status}</td>
                  <td className="py-1.5 pr-3 text-right tabular">{step.attempt}</td>
                  <td className="py-1.5 pr-3 text-right tabular">
                    {step.durationMs === null ? '—' : `${(step.durationMs / 1000).toFixed(1)}s`}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular">{step.tokensIn ?? '—'}</td>
                  {/* The number that explains the wait. */}
                  <td className="py-1.5 pr-3 text-right tabular font-bold">
                    {step.tokensOut ?? '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular">
                    {step.cacheReadTokens === null && step.cacheWriteTokens === null
                      ? '—'
                      : `${step.cacheReadTokens ?? 0}/${step.cacheWriteTokens ?? 0}`}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular">
                    {step.costCents === 0 ? '—' : step.costCents.toFixed(3)}
                  </td>
                  <td className="py-1.5 break-all">{step.modelId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-muted">run</dt>
            <dd className="break-all text-primary">{view.run.id}</dd>
            <dt className="text-muted">chapitre</dt>
            <dd className="text-primary">
              {view.run.chapterNumber} · <span className="break-all">{view.run.chapterId}</span>
            </dd>
            <dt className="text-muted">fournisseur</dt>
            <dd className="text-primary">{view.run.provider}</dd>
            <dt className="text-muted">version pipeline</dt>
            <dd className="text-primary">{view.run.pipelineVersion}</dd>
            <dt className="text-muted">créé</dt>
            <dd className="text-primary">{new Date(view.run.createdAt).toISOString()}</dd>
            <dt className="text-muted">démarré</dt>
            <dd className="text-primary">
              {view.run.startedAt ? new Date(view.run.startedAt).toISOString() : '—'}
            </dd>
            <dt className="text-muted">terminé</dt>
            <dd className="text-primary">
              {view.run.finishedAt ? new Date(view.run.finishedAt).toISOString() : '—'}
            </dd>
            <dt className="text-muted">temps de travail</dt>
            <dd className="text-primary">{(workedFor / 1000).toFixed(1)}s cumulés sur les étapes</dd>
          </dl>

          {view.steps.some((step) => step.note || step.error) && (
            <div className="mt-4 space-y-2 font-mono text-xs">
              {view.steps
                .filter((step) => step.note || step.error)
                .map((step) => (
                  <p key={step.key} className="break-words">
                    <span className="text-muted">{step.key} — </span>
                    <span className={step.error ? 'text-[var(--epi-contradicted)]' : 'text-primary'}>
                      {step.error ?? step.note}
                    </span>
                  </p>
                ))}
            </div>
          )}
        </div>
      </details>

      {terminal && (
        <div className="mt-8 flex flex-wrap gap-3">
          {view.run.status === 'succeeded' && (
            <Link
              href={`/review/${view.run.id}`}
              className="bouton bouton-primaire"
            >
              Revoir les propositions
            </Link>
          )}
          <Link
            href={`/chapitres/${view.run.chapterId}`}
            className="bouton"
          >
            Voir les pages du chapitre
          </Link>
          <Link
            href="/import"
            className="bouton"
          >
            Importer le suivant
          </Link>
        </div>
      )}
    </section>
  )
}

/** The recorded choice, in words. Older rows hold a resolved provider name. */
function providerSentence(provider: string): string {
  switch (provider) {
    case 'auto':
      return 'modèle par défaut'
    case 'anthropic':
      return 'Anthropic'
    case 'local':
      return 'modèle auto-hébergé'
    case 'synthetic':
      return 'fournisseur synthétique — extraction générée, pas issue des pages'
    case 'replay':
      return 'réponses rejouées'
    default:
      return provider
  }
}

/**
 * A state, as a colour you can read without reading.
 *
 * Replaces a monospace glyph in the same grey as everything else: the point of
 * a status is to be seen before it is parsed.
 */
function toneFor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'succeeded':
      return { bg: 'var(--epi-validated)', fg: '#fff' }
    case 'running':
      return { bg: 'var(--accent)', fg: 'var(--ink)' }
    case 'failed':
      return { bg: 'var(--coral)', fg: '#fff' }
    case 'cached':
      return { bg: 'var(--sea)', fg: '#fff' }
    case 'skipped':
      return { bg: 'var(--surface-sunken)', fg: 'var(--text-secondary)' }
    default:
      return { bg: 'var(--surface-sunken)', fg: 'var(--text-muted)' }
  }
}

function statusSentence(status: string): string {
  switch (status) {
    case 'pending':
      return 'en attente de démarrage'
    case 'running':
      return 'en cours'
    case 'succeeded':
      return 'terminé — les propositions attendent votre revue'
    case 'failed':
      return 'échec'
    case 'cancelled':
      return 'annulé'
    case 'paused':
      return 'en pause'
    default:
      return status
  }
}

/* Status is carried by a glyph as well as a colour: colour alone would exclude
   anyone who cannot distinguish these hues, and the whole list would read as
   uniform grey. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`
}
