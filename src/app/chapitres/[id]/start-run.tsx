'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { startRunAction } from './actions.ts'

/**
 * Hand a chapter to the pipeline.
 *
 * Separate from the import step on purpose: import gets pages on screen while
 * the user is still watching, and processing is the long part they walk away
 * from. Splitting them means a bad page order is fixed before anything is
 * spent analysing it.
 */
export function StartRun({ chapterId }: { chapterId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null)
          start(async () => {
            const result = await startRunAction(chapterId)
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
