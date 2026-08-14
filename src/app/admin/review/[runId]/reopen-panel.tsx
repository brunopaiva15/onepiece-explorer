'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reopenItemsAction } from './actions.ts'
import type { ReviewItemView } from '@/domains/review/queue.ts'

/**
 * What you already decided, and the way back.
 *
 * Rejecting a proposal used to be irreversible: the item was closed and the
 * verdict recorded against its fingerprint, so a re-import skipped it rather
 * than asking again. A mistake therefore stayed a mistake, and it took the
 * chapter's relations with it — « le sujet e5 n'existe pas dans le graphe : son
 * entité a été rejetée ou reportée. Acceptez-la d'abord » described an
 * operation the interface did not offer.
 *
 * Folded shut by default, because this is a repair tool and not part of the
 * normal pass: someone arriving with eighty proposals to triage should not have
 * to scroll past the ones they have already dealt with.
 */
export function ReopenPanel({
  runId,
  items,
}: {
  runId: string
  items: ReviewItemView[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function reopen(ids: string[]): void {
    setError(null)
    startTransition(async () => {
      const result = await reopenItemsAction(runId, ids)
      if (!result.ok) {
        setError(result.error ?? 'Opération impossible.')
        return
      }
      router.refresh()
    })
  }

  return (
    <details className="panneau mt-8">
      <summary className="panneau-titre cursor-pointer list-none">
        Déjà décidées
        <span className="font-sans text-xs normal-case opacity-80">
          {items.length} rejetée(s) ou reportée(s) · revenir dessus
        </span>
      </summary>
      <div className="panneau-corps">
        <p className="max-w-3xl text-sm text-secondary">
          Rouvrir une proposition la remet dans la file <em>et</em> efface la
          décision enregistrée, sans quoi le prochain ré-import y répondrait de
          nouveau tout seul, avec la réponse que vous venez de retirer. Une
          proposition déjà publiée n&apos;est pas ici : elle est dans le graphe,
          et ce qui l&apos;en retire est la suppression du chapitre.
        </p>

        {error && (
          <p className="mt-3 text-sm text-[var(--epi-contradicted)]">{error}</p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => reopen(items.map((item) => item.id))}
            className="bouton bouton-mer !py-1 !text-sm"
          >
            Tout rouvrir ({items.length})
          </button>
        </div>

        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 border-b border-line pb-2 text-sm"
            >
              <span className={`badge ${item.status === 'rejected' ? 'badge-rouge' : 'badge-gris'}`}>
                {item.status === 'rejected' ? 'Rejetée' : 'Reportée'}
              </span>
              <span className="cartouche">{item.category}</span>
              <span className="flex-1 text-primary">{describe(item)}</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => reopen([item.id])}
                className="bouton !py-0.5 !text-xs"
              >
                Rouvrir
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

/**
 * One line naming the proposal, from whichever shape its payload has.
 *
 * Deliberately shallow: this list exists to let someone find the thing they
 * rejected by mistake, not to re-litigate it. The card with the evidence comes
 * back the moment it returns to the queue.
 */
function describe(item: ReviewItemView): string {
  const payload = (item.payload ?? {}) as Record<string, unknown>

  const first = [
    payload.label,
    payload.question,
    payload.summary,
    payload.candidateLabel,
  ].find((value) => typeof value === 'string' && value.trim() !== '')

  if (typeof first === 'string') return first

  if (typeof payload.predicate === 'string') {
    const subject = typeof payload.subject === 'string' ? payload.subject : '?'
    const object =
      typeof payload.object === 'string' && payload.object !== ''
        ? payload.object
        : typeof payload.object_value === 'string'
          ? payload.object_value
          : ''
    return `${subject} · ${payload.predicate}${object ? ` · ${object}` : ''}`
  }

  return item.fingerprint.slice(0, 12)
}
