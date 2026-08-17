'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { forgetReadingsAction, relireAction } from './actions.ts'

/**
 * Relire les chapitres avec un modèle, et voir où ça en est.
 *
 * Ce que les règles ne peuvent pas trouver : une phrase fausse. « Usopp devient
 * capitaine de l'équipage » est bien datée, bien reliée, et le chapitre dit le
 * contraire — il faut l'avoir lu pour le savoir, et lire coûte un appel par
 * chapitre.
 *
 * La boucle est ici, dans le navigateur, plutôt que sur le serveur. Une action
 * de serveur a un plafond de durée et cent quarante-cinq appels ne tiennent pas
 * dedans ; découpée en paquets, la relecture avance à l'écran, s'arrête au clic,
 * et reprend là où elle en était puisque `audit_reads` retient chaque chapitre lu.
 * Une reprise ne repaye donc jamais ce qui a déjà été lu.
 *
 * Le coût est affiché pendant, et pas seulement à la fin : c'est la seule façon
 * d'arrêter à temps quelque chose qui se facture au chapitre.
 */
export function Relecture({
  read,
  chapters,
  costCents,
}: {
  read: number
  chapters: number
  costCents: number
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [progress, setProgress] = useState({ read, found: 0, cents: 0 })
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [armedReset, setArmedReset] = useState(false)
  // Un ref plutôt qu'un état : la boucle doit lire l'arrêt à chaque tour, et un
  // état capturé dans la fermeture ne change jamais pour elle.
  const stop = useRef(false)

  const remaining = Math.max(0, chapters - progress.read)

  const run = (): void => {
    setError(null)
    stop.current = false
    setRunning(true)

    start(async () => {
      /*
       * Les chapitres que cette passe a ratés, mis de côté jusqu'à la fin.
       *
       * Un chapitre en échec n'est pas marqué comme lu — c'est ce qui permet d'y
       * revenir — donc sans cette liste il reste le premier à lire, le paquet
       * suivant le redemande, et la relecture tourne en rond sur le chapitre 4
       * sans jamais atteindre le 8. Ils sont dits à la fin, et la prochaine
       * relecture les reprend depuis le début.
       */
      const failed: number[] = []

      for (;;) {
        if (stop.current) break

        const outcome = await relireAction(4, failed)
        if (!outcome.ok || !outcome.report) {
          setError(outcome.error ?? 'Relecture impossible.')
          break
        }

        const report = outcome.report
        setProgress((current) => ({
          read: current.read + report.read,
          found: current.found + report.found,
          cents: current.cents + report.costCents,
        }))

        if (report.failures.length > 0) {
          failed.push(...report.failures.map((failure) => failure.chapter))
          setNotes((current) => [
            ...current,
            ...report.failures.map(
              (failure) => `Chapitre ${failure.chapter} : ${failure.reason}`,
            ),
          ])
        }
        if (report.truncated.length > 0) {
          setNotes((current) => [
            ...current,
            `Texte tronqué avant lecture : chapitre(s) ${report.truncated.join(', ')}.`,
          ])
        }

        /*
         * La page se rafraîchit entre deux paquets, et pas seulement à la fin.
         *
         * Deux raisons, dont la seconde est la vraie. Les compteurs du haut
         * viennent du serveur : sans ça ils affichent « 1 chapitre relu » sous
         * un panneau qui en annonce trois, et le lecteur ne sait plus lequel
         * croire. Et les constats trouvés apparaissent au fur et à mesure —
         * une relecture de cent cinquante chapitres dure, et rien n'oblige à
         * attendre la fin pour lire ce qu'elle a déjà trouvé.
         *
         * Le coût est une lecture de page pour quatre appels de modèle, ce qui
         * ne se mesure pas à côté.
         */
        router.refresh()

        // Un paquet qui n'a rien lu du tout est la fin de la passe : soit il ne
        // reste rien, soit ce qui reste vient d'échouer et est mis de côté.
        if (report.read === 0) break
        if (report.remaining <= 0) break
      }

      if (failed.length > 0) {
        setNotes((current) => [
          ...current,
          `${failed.length} chapitre(s) laissés de côté après échec : ` +
            `${failed.slice(0, 12).join(', ')}${failed.length > 12 ? '…' : ''}. ` +
            `Relancer la relecture les reprend.`,
        ])
      }

      setRunning(false)
      router.refresh()
    })
  }

  return (
    <section className="panneau mt-8">
      <h2 className="panneau-titre">Relecture par le modèle</h2>

      <div className="panneau-corps">
        <p className="text-sm text-secondary">
          Chapitre par chapitre, le modèle compare ce que la bibliothèque
          raconte au texte du chapitre, et ne signale que ce que ce texte
          contredit — en recopiant la phrase qui le prouve. Il ne lui est jamais
          demandé ce qu’il sait de la suite&nbsp;: une correction tirée d’un
          chapitre ultérieur serait un spoiler écrit dans le fil.
        </p>

        <p className="mt-3 text-sm">
          <span className="tabular">
            {progress.read} chapitre(s) relu(s) sur {chapters}
          </span>
          {remaining > 0 && (
            <span className="text-muted">
              {' '}
              · {remaining} à relire, un appel chacun
            </span>
          )}
          {(costCents > 0 || progress.cents > 0) && (
            <span className="text-muted">
              {' '}
              · {((costCents + progress.cents) / 100).toFixed(2)} $ dépensés
            </span>
          )}
          {progress.found > 0 && (
            <span className="text-[var(--epi-validated)]">
              {' '}
              · {progress.found} constat(s) trouvé(s)
            </span>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={() => {
                stop.current = true
              }}
              className="bouton !py-1.5 !text-sm"
            >
              Arrêter après ce paquet
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || remaining === 0}
              onClick={run}
              className="bouton bouton-primaire !py-1.5 !text-sm"
            >
              {remaining === 0 ? 'Tout est relu' : `Relire les ${remaining} restants`}
            </button>
          )}

          {progress.read > 0 && !running && !armedReset && (
            <button
              type="button"
              onClick={() => setArmedReset(true)}
              className="cartouche underline"
              title="Oublier ce qui a été relu pour tout relire — et tout repayer"
            >
              tout relire depuis le début
            </button>
          )}

          {armedReset && (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-secondary">Tout relire coûtera un appel par chapitre.</span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    await forgetReadingsAction()
                    setProgress({ read: 0, found: 0, cents: 0 })
                    setArmedReset(false)
                    router.refresh()
                  })
                }
                className="bouton !py-1 !text-sm"
              >
                Confirmer
              </button>
              <button
                type="button"
                onClick={() => setArmedReset(false)}
                className="cartouche underline"
              >
                annuler
              </button>
            </span>
          )}
        </div>

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
