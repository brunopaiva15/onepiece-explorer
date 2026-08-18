'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { arbitrateRunAction } from './actions.ts'

/**
 * Demander la seconde lecture depuis le centre de revue.
 *
 * Le pipeline la fait tout seul sur les chapitres qu'il traite, et cette page
 * existe pour les autres : un traitement lancé avant que la passe existe, un
 * chapitre dont le fournisseur ne lisait pas ce jour-là, une file qu'on rouvre.
 * Le geste est le même que celui du pipeline et passe par le même code — il n'y
 * a pas deux arbitrages, il y a un arbitrage et deux façons de le déclencher.
 *
 * Un bouton, pas une case à cocher : l'appel coûte, va chercher une page sur le
 * réseau et peut décider des cartes. Ce genre de chose se demande, ça ne se
 * découvre pas en rechargeant une page.
 */
export function ArbitratePanel({ runId, pending }: { runId: string; pending: number }) {
  const router = useRouter()
  const [running, start] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  if (pending === 0) return null

  return (
    <section className="panneau mt-8">
      <h2 className="panneau-titre">
        Arbitrage sur le wiki
        <span className="font-sans text-xs normal-case opacity-80">
          {pending} proposition(s) en attente
        </span>
      </h2>
      <div className="panneau-corps">
        <p className="max-w-3xl text-sm text-secondary">
          Un second modèle relit chaque proposition en tenant la page du chapitre
          sur le One Piece Fandom, entière, en anglais et en français. Il tranche
          ce qu&apos;une phrase de la page tranche — citée mot pour mot, sinon le
          verdict est annulé — et laisse le reste ici, avec son avis sur la carte.
          Les rapprochements et les contradictions ne sont jamais décidés
          ainsi&nbsp;: l&apos;avis s&apos;affiche, le clic reste le vôtre.
        </p>

        <button
          type="button"
          className="bouton bouton-mer mt-3"
          disabled={running}
          onClick={() => {
            setMessage(null)
            setFailed(false)
            start(async () => {
              const result = await arbitrateRunAction(runId)
              setFailed(!result.ok)
              setMessage(result.note ?? result.error ?? null)
              if (result.ok) router.refresh()
            })
          }}
        >
          {running ? 'Lecture de la page…' : 'Arbitrer les propositions restantes'}
        </button>

        {message && (
          <p
            className={`mt-3 border-[3px] border-ink px-2 py-1.5 text-sm ${
              failed ? 'bg-[var(--coral)] text-white' : 'bg-[var(--halftone)] text-ink'
            }`}
          >
            {message}
          </p>
        )}
      </div>
    </section>
  )
}
