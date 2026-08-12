'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderChoice, ProviderOption } from '@/domains/ai/index.ts'
import { startRunAction } from './actions.ts'

/**
 * Hand a chapter to the pipeline, with a model.
 *
 * Separate from the import step on purpose: import gets pages on screen while
 * the user is still watching, and processing is the long part they walk away
 * from. Splitting them means a bad page order is fixed before anything is spent
 * analysing it.
 *
 * The model is chosen here rather than in a configuration file because the
 * interesting question is never "which model is better" but "is the cheaper one
 * good enough at *this*" — and that is answered by running the same chapter
 * both ways and comparing the review queue, not by picking once and forgetting.
 * The choice is stored on the run, so the comparison stays legible afterwards.
 */
export function StartRun({
  chapterId,
  options,
}: {
  chapterId: string
  options: ProviderOption[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<ProviderChoice>('auto')

  // Only worth a control when there is something to choose between: with one
  // provider configured, a radio group is a decision nobody has to make.
  const choosable = options.filter((option) => option.available)
  const selected = options.find((option) => option.id === choice)

  return (
    <div className="flex flex-col items-start gap-3">
      {choosable.length > 1 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted">
            Modèle
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <label
                key={option.id}
                className={`cursor-pointer rounded-sm border px-3 py-1.5 text-sm ${
                  choice === option.id
                    ? 'border-accent bg-surface-raised text-primary'
                    : 'border-line text-secondary hover:border-line-strong'
                } ${option.available ? '' : 'cursor-not-allowed opacity-40'}`}
              >
                <input
                  type="radio"
                  name="provider"
                  value={option.id}
                  checked={choice === option.id}
                  disabled={!option.available}
                  onChange={() => setChoice(option.id)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </div>
          {selected && <p className="text-xs text-muted">{selected.note}</p>}
        </fieldset>
      )}

      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null)
          start(async () => {
            const result = await startRunAction(chapterId, choice)
            if (result.ok && result.runId) router.push(`/runs/${result.runId}`)
            else setError(result.error ?? 'Lancement impossible.')
          })
        }}
        className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong disabled:opacity-50"
      >
        {pending ? 'Lancement…' : 'Lancer le traitement'}
      </button>

      {error && (
        <p role="alert" className="max-w-md text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}
    </div>
  )
}
