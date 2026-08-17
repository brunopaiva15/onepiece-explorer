'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { sweepStoryAction, type SweepActionResult } from './actions.ts'

/**
 * Relancer les règles sur toute la bibliothèque.
 *
 * Un seul clic, sans confirmation, contrairement à la réimportation d'un
 * chapitre : celui-ci ne dépense rien et n'écrit rien dans le graphe. Il lit, il
 * compare, il met la liste à jour — et une liste à jour est ce qu'on veut après
 * avoir corrigé quoi que ce soit.
 *
 * Ce que le compte rendu dit, et qui n'est pas le total : combien de constats
 * sont nouveaux depuis le dernier passage, et combien ont disparu parce que le
 * défaut n'est plus là. Un total seul ne dit pas si l'on avance.
 */
export function Sweep({ label = 'Analyser l’histoire' }: { label?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [result, setResult] = useState<SweepActionResult | null>(null)

  return (
    <span className="flex flex-wrap items-center gap-3">
      {result?.report && (
        <span role="status" className="text-sm text-secondary">
          {result.report.found} constat(s) · {result.report.fresh} nouveau(x)
          {result.report.resolved > 0 && ` · ${result.report.resolved} réglé(s)`}
        </span>
      )}
      {result && !result.ok && (
        <span role="alert" className="text-sm text-[var(--epi-contradicted)]">
          {result.error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const outcome = await sweepStoryAction()
            setResult(outcome)
            if (outcome.ok) router.refresh()
          })
        }
        className="bouton bouton-primaire"
        title="Passer toute la bibliothèque sous les règles. Gratuit : aucun appel à un modèle."
      >
        {pending ? 'Analyse…' : label}
      </button>
    </span>
  )
}
