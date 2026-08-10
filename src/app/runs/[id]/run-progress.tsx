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

export function RunProgress({ initial }: { initial: RunView }) {
  const [view, setView] = useState<RunView>(initial)
  /**
   * Only ever set from an event handler, never from the effect body. A
   * "connection is closed because the run finished" state would be derived
   * data pretending to be state — `terminal` already says it.
   */
  const [streamBroken, setStreamBroken] = useState(false)
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(view.run.status)
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
        {view.run.totalCostCents > 0 && (
          <p className="text-sm text-muted">
            coût réel {(view.run.totalCostCents / 100).toFixed(2)} $
          </p>
        )}
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

      <ol className="mt-6 divide-y divide-[var(--border)]">
        {view.steps.map((step) => (
          <li
            key={step.key}
            className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3 ${
              step.implemented ? '' : 'opacity-55'
            }`}
          >
            <span
              aria-hidden
              className="w-4 shrink-0 text-center font-mono text-sm"
              style={{ color: colourFor(step.status) }}
            >
              {glyphFor(step.status)}
            </span>

            <span className="font-medium text-primary">{step.label}</span>

            <span className="font-mono text-xs uppercase tracking-wide text-muted">
              {LABELS[step.status] ?? step.status}
            </span>

            {step.usesModel && (
              <span
                title="Cette étape appelle un modèle"
                className="rounded-sm border border-line px-1.5 text-[0.65rem] text-muted"
              >
                modèle
              </span>
            )}

            {step.attempt > 1 && (
              <span className="text-xs text-muted">tentative {step.attempt}</span>
            )}

            <span className="ml-auto shrink-0 font-mono text-xs text-muted">
              {step.durationMs !== null && step.durationMs > 0
                ? formatDuration(step.durationMs)
                : ''}
              {step.costCents > 0 && ` · ${(step.costCents / 100).toFixed(3)} $`}
            </span>

            <p className="w-full text-sm text-secondary">
              {step.error ?? step.note ?? step.detail}
            </p>
          </li>
        ))}
      </ol>

      {terminal && (
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href={`/chapitres/${view.run.chapterId}`}
            className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Voir les pages du chapitre
          </Link>
          <Link
            href="/import"
            className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
          >
            Importer le suivant
          </Link>
        </div>
      )}
    </section>
  )
}

function statusSentence(status: string): string {
  switch (status) {
    case 'pending':
      return 'en attente d’un worker'
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
function glyphFor(status: string): string {
  switch (status) {
    case 'succeeded':
      return '✓'
    case 'failed':
      return '✗'
    case 'running':
      return '▸'
    case 'cached':
      return '≡'
    case 'skipped':
      return '–'
    default:
      return '·'
  }
}

function colourFor(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'var(--epi-explicit)'
    case 'failed':
      return 'var(--epi-contradicted)'
    case 'running':
      return 'var(--accent)'
    case 'cached':
      return 'var(--epi-inferred)'
    default:
      return 'var(--text-muted)'
  }
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`
}
