'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { analyserAction, forgetPassesAction } from './actions.ts'

/**
 * Un panneau de lecture payante, et tout ce qu'il doit dire avant de dépenser.
 *
 * Ce que les règles ne peuvent pas trouver : une phrase fausse, une identité
 * qui n'en est pas une, une réponse datée quatre-vingts chapitres trop tard. Il
 * faut avoir lu pour le savoir, et lire coûte un appel par sujet.
 *
 * La boucle est ici, dans le navigateur, plutôt que sur le serveur. Une action
 * de serveur a un plafond de durée et cent cinquante appels ne tiennent pas
 * dedans ; découpée en paquets, la lecture avance à l'écran, s'arrête au clic,
 * et reprend là où elle en était puisque chaque sujet lu est retenu avec
 * l'empreinte de ce qui lui a été donné. Une reprise ne repaye donc jamais ce
 * qui n'a pas changé.
 *
 * Un panneau peut enchaîner plusieurs analyses — vérifier les scènes, c'est les
 * relire, chercher les doublons que la règle gratuite n'ose pas replier, et
 * soupçonner les couvertures. Elles sont menées l'une après l'autre, chacune
 * avec son propre compteur : ce qui se paye séparément se rapporte séparément.
 *
 * Le coût est affiché pendant, et pas seulement à la fin : c'est la seule façon
 * d'arrêter à temps quelque chose qui se facture au sujet.
 */

export interface LectureStep {
  analysis: string
  label: string
  /** Ce que cette analyse aurait à lire en tout : chapitres, identités, questions. */
  total: number
  /** Ce qu'elle a déjà lu, et ce qui a raté, d'après les passes retenues. */
  read: number
  failed: number
  costCents: number
}

interface Progress {
  read: number
  skipped: number
  found: number
  cents: number
  remaining: number
}

export function Lecture({
  title,
  explain,
  steps,
}: {
  title: string
  explain: string
  steps: LectureStep[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [armedReset, setArmedReset] = useState<string | null>(null)
  // Un ref plutôt qu'un état : la boucle doit lire l'arrêt à chaque tour, et un
  // état capturé dans la fermeture ne change jamais pour elle.
  const stop = useRef(false)

  const already = (step: LectureStep): number => step.read + (progress[step.analysis]?.read ?? 0)

  const run = (only?: string): void => {
    setError(null)
    stop.current = false

    start(async () => {
      for (const step of steps) {
        if (only !== undefined && step.analysis !== only) continue
        if (stop.current) break

        setRunning(step.analysis)

        /*
         * Les sujets que cette passe a ratés, mis de côté jusqu'à la fin.
         *
         * Un sujet en échec n'est pas marqué comme lu — c'est ce qui permet d'y
         * revenir — donc sans cette liste il reste le premier à lire, le paquet
         * suivant le redemande, et la lecture tourne en rond sur le chapitre 4
         * sans jamais atteindre le 8.
         */
        const failed: string[] = []

        for (;;) {
          if (stop.current) break

          const outcome = await analyserAction(step.analysis, 4, failed)
          if (!outcome.ok || !outcome.report) {
            setError(outcome.error ?? 'Lecture impossible.')
            break
          }

          const report = outcome.report
          setProgress((current) => {
            const before = current[step.analysis] ?? {
              read: 0,
              skipped: 0,
              found: 0,
              cents: 0,
              remaining: 0,
            }
            return {
              ...current,
              [step.analysis]: {
                read: before.read + report.read,
                skipped: before.skipped + report.skipped,
                found: before.found + report.found,
                cents: before.cents + report.costCents,
                remaining: report.remaining,
              },
            }
          })

          if (report.failures.length > 0) {
            failed.push(...report.failures.map((failure) => failure.subject))
            setNotes((current) => [
              ...current,
              ...report.failures.map((failure) => `${failure.label} : ${failure.reason}`),
            ])
          }
          if (report.truncated.length > 0) {
            setNotes((current) => [
              ...current,
              `Matière tronquée avant lecture : ${report.truncated.join(', ')}.`,
            ])
          }

          /*
           * La page se rafraîchit entre deux paquets, et pas seulement à la fin.
           *
           * Les compteurs du haut viennent du serveur : sans ça ils affichent
           * « 1 chapitre lu » sous un panneau qui en annonce trois. Et les
           * constats apparaissent au fur et à mesure — une lecture de cent
           * cinquante chapitres dure, et rien n'oblige à attendre la fin pour
           * lire ce qu'elle a déjà trouvé.
           */
          router.refresh()

          /*
           * Un paquet qui n'a rien lu du tout est la fin de cette analyse :
           * soit il ne reste rien, soit ce qui reste vient d'échouer et est
           * mis de côté. C'est la seule condition d'arrêt, et c'est délibéré —
           * `remaining` est une estimation faite sans charger la matière de ce
           * qui n'a pas été atteint, et s'arrêter dessus laisserait du travail
           * derrière soi.
           */
          if (report.read === 0) break
        }

        if (failed.length > 0) {
          setNotes((current) => [
            ...current,
            `${failed.length} sujet(s) laissés de côté après échec. Relancer les reprend.`,
          ])
        }
      }

      setRunning(null)
      router.refresh()
    })
  }

  const totalLeft = steps.reduce(
    (left, step) => left + Math.max(0, step.total - already(step)),
    0,
  )

  return (
    <section className="panneau mt-8">
      <h2 className="panneau-titre flex flex-wrap items-center justify-between gap-3">
        <span>{title}</span>
        {running !== null ? (
          <button
            type="button"
            onClick={() => {
              stop.current = true
            }}
            className="bouton !py-1 !text-sm"
          >
            Arrêter après ce paquet
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || totalLeft === 0}
            onClick={() => run()}
            className="bouton bouton-primaire !py-1 !text-sm"
            title="Un appel de modèle par sujet non lu. Rien n’est relu sans raison."
          >
            {totalLeft === 0 ? 'Tout est lu' : `Lire les ${totalLeft} restants`}
          </button>
        )}
      </h2>

      <div className="panneau-corps">
        <p className="text-sm text-secondary">{explain}</p>

        <ul className="mt-3 space-y-2">
          {steps.map((step) => {
            const live = progress[step.analysis]
            const done = already(step)
            const left = Math.max(0, step.total - done)
            const cents = step.costCents + (live?.cents ?? 0)

            return (
              <li key={step.analysis} className="text-sm">
                <span className="font-display uppercase text-primary">{step.label}</span>{' '}
                <span className="tabular">
                  {done}/{step.total}
                </span>
                {left > 0 && (
                  <span className="text-muted"> · {left} à lire, un appel chacun</span>
                )}
                {live !== undefined && live.skipped > 0 && (
                  <span className="text-muted"> · {live.skipped} inchangé(s), non relu(s)</span>
                )}
                {cents > 0 && (
                  <span className="text-muted"> · {(cents / 100).toFixed(2)} $</span>
                )}
                {(live?.found ?? 0) > 0 && (
                  <span className="text-[var(--epi-validated)]">
                    {' '}
                    · {live!.found} constat(s)
                  </span>
                )}
                {step.failed > 0 && (
                  <span className="text-[var(--epi-contradicted)]">
                    {' '}
                    · {step.failed} en échec
                  </span>
                )}
                {running === step.analysis && <span className="text-muted"> · en cours…</span>}

                <span className="ml-2">
                  {left > 0 && running === null && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(step.analysis)}
                      className="cartouche underline"
                    >
                      reprendre
                    </button>
                  )}
                  {done > 0 && running === null && armedReset !== step.analysis && (
                    <button
                      type="button"
                      onClick={() => setArmedReset(step.analysis)}
                      className="cartouche underline"
                      title="Oublier ce qui a été lu ici pour tout relire — et tout repayer"
                    >
                      {' '}
                      tout relire
                    </button>
                  )}
                  {armedReset === step.analysis && (
                    <span className="ml-2 inline-flex items-center gap-2">
                      <span className="text-secondary">
                        Tout relire coûtera un appel par sujet.
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            await forgetPassesAction(step.analysis)
                            setProgress((current) => {
                              const next = { ...current }
                              delete next[step.analysis]
                              return next
                            })
                            setArmedReset(null)
                            router.refresh()
                          })
                        }
                        className="bouton !py-0.5 !text-xs"
                      >
                        Confirmer
                      </button>
                      <button
                        type="button"
                        onClick={() => setArmedReset(null)}
                        className="cartouche underline"
                      >
                        annuler
                      </button>
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>

        {error && (
          <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
            {error}
          </p>
        )}

        {notes.length > 0 && (
          <ul className="mt-3 space-y-0.5 text-xs text-muted">
            {notes.slice(-5).map((note, index) => (
              <li key={`${note}-${index}`}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
