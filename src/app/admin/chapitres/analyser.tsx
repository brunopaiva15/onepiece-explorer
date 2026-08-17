'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { sweepStoryAction } from '../analyse/actions.ts'

/**
 * Analyser toute l'histoire, depuis la bibliothèque.
 *
 * Sa place est ici et non dans les réglages : c'est en regardant la liste des
 * chapitres qu'on se demande si l'ensemble se tient. Le bouton passe les règles
 * sur toute la bibliothèque — gratuitement, sans appeler de modèle — puis mène à
 * la page qui montre ce qu'elles ont trouvé et propose de le corriger.
 *
 * Le balayage a lieu avant la navigation plutôt qu'à l'arrivée sur la page.
 * Arriver devant une liste vide qui se remplit toute seule ne dit pas si elle
 * est vide parce que tout va bien ou parce que rien n'a encore été fait ; ici, ce
 * qui s'affiche est le résultat du clic.
 */
export function Analyser() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <span className="flex items-center gap-2">
      {error && (
        <span role="alert" className="text-xs text-[var(--epi-contradicted)]">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null)
          start(async () => {
            const outcome = await sweepStoryAction()
            if (outcome.ok) router.push('/admin/analyse')
            else setError(outcome.error ?? 'Analyse impossible.')
          })
        }}
        className="bouton"
        title="Relire toute l’histoire : doublons, noms affichés trop tôt, révélations à l’envers. Gratuit."
      >
        {pending ? 'Analyse…' : 'Analyser l’histoire'}
      </button>
    </span>
  )
}
