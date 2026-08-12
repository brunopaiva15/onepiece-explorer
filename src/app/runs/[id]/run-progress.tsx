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
