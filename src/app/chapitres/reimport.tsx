'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { startRunAction } from './[id]/actions.ts'

/**
 * Run a chapter through the pipeline again, from the text already stored.
 *
 * Nothing has to be pasted a second time: the passages are in the database and
 * the run reads them from there. What this is for is the case where the
 * *pipeline* got better — a distinction it could not make before, a link it
 * could not express — and the chapter deserves to be read again with it.
 *
 * **It does not lose a decision you have made.** Every proposal carries a
 * fingerprint of what it claims, and a fingerprint you have already answered is
 * skipped rather than queued again: accepted stays accepted, rejected stays
 * rejected, and a label you corrected keeps your wording. Only what the new run
 * proposes *and you have never seen* reaches the review queue.
 *
 * The chapter also stays published while it re-runs, so nothing disappears from
 * the graph or moves the boundary underneath a reader — a run may not take an
 * opened chapter back, which is enforced where the status is written.
 *
 * Two clicks, because the first one spends money: a re-import is a full set of
 * extraction calls.
 */
export function Reimport({ chapterId }: { chapterId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (error) {
    return (
      <span role="alert" className="text-xs text-[var(--epi-contradicted)]">
        {error}
      </span>
    )
  }

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="bouton !py-1 !text-sm"
        title="Relire ce chapitre avec le pipeline actuel. Vos décisions sont conservées."
      >
        Réimporter
      </button>
    )
  }

  return (
    <span className="flex items-center gap-2">
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
        className="bouton bouton-primaire !py-1 !text-sm"
      >
        {pending ? 'Lancement…' : 'Confirmer'}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => setArmed(false)}
        className="cartouche underline"
      >
        annuler
      </button>
    </span>
  )
}
