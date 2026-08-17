'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  planSweepAction,
  sweepQuestionAction,
  type SweepStep,
} from './actions.ts'

/**
 * « Vérifier si l'histoire y a répondu ».
 *
 * Le bouton fait ce que `pnpm repair:mysteres` fait, depuis la page qui montre
 * les questions : pour chacune, il donne au modèle les scènes publiées des
 * chapitres suivants et lui demande d'y répondre en citant ses sources. Une
 * réponse sourcée par une scène postérieure referme la question, à la date de
 * cette scène.
 *
 * Une question à la fois, en série, et c'est visible à l'écran. Trois raisons,
 * dans cet ordre :
 *
 *   Chaque appel serveur est borné par un seul appel de modèle, donc rien ne se
 *   fait couper au milieu d'une bibliothèque de soixante-dix questions.
 *
 *   Le compteur avance. « 12 sur 41 » pendant dix minutes est la différence
 *   entre un bouton qui travaille et un bouton qui a planté.
 *
 *   On peut s'arrêter. Chaque question coûte un appel de modèle ; s'arrêter au
 *   bout de trois, en ayant vu ce que les trois ont donné, est une décision que
 *   seule une boucle interruptible permet de prendre.
 *
 * Ce qui a déjà été refermé l'est pour de bon : arrêter n'annule rien, et
 * reprendre plus tard ne redemande pas ce qui est fait.
 */

interface Line extends Omit<SweepStep, 'kind'> {
  /**
   * Les verdicts du serveur, plus celui que la boucle ajoute elle-même.
   *
   * `failed` ne vient pas de `ClosingVerdict` et ne doit pas y entrer : le
   * serveur rend ce qu'une question est devenue, et « l'appel n'a pas abouti »
   * n'est pas un état de la question. C'est un état de la ligne du rapport.
   */
  kind?: SweepStep['kind'] | 'failed'
  question: string
  openedInChapter: number
}

type Phase = 'idle' | 'running' | 'stopped' | 'done'

/**
 * Combien d'échecs **de suite** avant de renoncer.
 *
 * Une question qui échoue n'emportait pas seulement elle-même : la boucle
 * s'arrêtait dessus, et un arriéré de soixante-dix questions se terminait à la
 * douzième parce qu'un CLI était mort sans rien dire dans le bac à sable. Ce
 * n'est pas un verdict sur la treizième, qui n'avait pas été posée.
 *
 * Alors on continue — mais pas indéfiniment. Une panne qui ne se déclare pas
 * fatale et qui échoue pourtant trois fois d'affilée n'est plus un accident :
 * c'est une panne de fond que la boucle ne saurait pas nommer, et lui donner
 * soixante-dix appels de modèle pour se répéter serait cher pour rien. Trois,
 * parce que deux est un doublon de malchance et que quatre ne l'apprendrait pas
 * mieux.
 */
const GIVE_UP_AFTER = 3

export function VerifierLesMysteres({
  boundaryChapter,
  questions,
  blocked,
}: {
  boundaryChapter: number
  /**
   * Combien de questions le balayage examinerait — le décompte de la table.
   *
   * Il est plus petit que « Sans réponse » ci-dessus dès que l'histoire referme
   * une question plus loin que le curseur du lecteur, et ce n'est pas une
   * incohérence : celles-là ont leur réponse écrite, il n'y a rien à demander.
   */
  questions: number
  /** Pourquoi le bouton ne peut rien faire, quand c'est le cas. */
  blocked: string | null
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [total, setTotal] = useState(0)
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  /*
   * Un drapeau, pas un état.
   *
   * La boucle tourne dans une seule fonction asynchrone ; elle lit ce drapeau
   * entre deux questions. Un `useState` ne lui donnerait que la valeur figée à
   * son premier rendu, et « Arrêter » ne serait qu'un bouton.
   */
  const stopped = useRef(false)

  async function run() {
    setPhase('running')
    setError(null)
    setLines([])
    setTotal(0)
    stopped.current = false

    const plan = await planSweepAction()
    if (!plan.ok || !plan.questions) {
      setError(plan.error ?? 'Lecture des questions impossible.')
      setPhase('idle')
      return
    }

    setTotal(plan.questions.length)

    let closed = 0
    let consecutiveFailures = 0

    for (const question of plan.questions) {
      if (stopped.current) break

      const step = await sweepQuestionAction(question.entityId)
      const line: Line = {
        ...step,
        entityId: question.entityId,
        question: question.question,
        openedInChapter: question.openedInChapter,
      }

      if (!step.ok) {
        consecutiveFailures++
        setLines((previous) => [...previous, { ...line, kind: 'failed' }])

        if (step.fatal || consecutiveFailures >= GIVE_UP_AFTER) {
          setError(step.error ?? 'Vérification impossible.')
          break
        }
        continue
      }

      consecutiveFailures = 0
      if (step.kind === 'closed') closed++
      setLines((previous) => [...previous, line])
    }

    // Les questions refermées ne sont plus au même endroit de la page.
    if (closed > 0) router.refresh()
    setPhase(stopped.current ? 'stopped' : 'done')
  }

  const running = phase === 'running'
  const closed = lines.filter((line) => line.kind === 'closed')
  const stillOpen = lines.filter((line) => line.kind === 'open')
  const failed = lines.filter((line) => line.kind === 'failed')
  const cost = lines.reduce((sum, line) => sum + (line.costCents ?? 0), 0)

  return (
    <section className="mt-8 border-t border-line pt-6">
      <h2 className="text-lg font-semibold text-primary">
        Demander à l&apos;histoire
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-secondary">
        Question par question, le modèle relit les scènes des chapitres qui
        suivent et dit si l&apos;une d&apos;elles y répond. Celles qui répondent
        referment la question à leur propre chapitre — un jugement de machine,
        enregistré comme tel&nbsp;: la fiche de la question montrera la scène qui
        la referme, et une erreur se défait en écartant cette relation.
      </p>

      {blocked ? (
        <p className="mt-3 max-w-2xl border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
          {blocked}
        </p>
      ) : questions === 0 && phase === 'idle' ? (
        /*
         * Zéro veut dire deux choses, et l'une est nouvelle.
         *
         * « Tout a déjà sa réponse » était vrai quand la seule façon de sortir du
         * balayage était d'être refermée. Une question examinée contre toute la
         * bibliothèque et laissée ouverte en sort aussi maintenant — sans quoi
         * chaque relance repayait ses neuf cents scènes pour le même verdict. Le
         * décompte tombe donc à zéro sur une bibliothèque pleine de questions
         * ouvertes, et le dire autrement serait mentir sur l'état du graphe.
         */
        <p className="mt-3 text-sm text-muted">
          Aucune question à examiner pour l&apos;instant : chacune a déjà sa
          réponse, ou a déjà été posée à toute la bibliothèque publiée sans que
          l&apos;histoire n&apos;y réponde. Celles qui restent «&nbsp;Sans
          réponse&nbsp;» ci-dessus le sont donc soit parce que la réponse
          n&apos;existe pas encore, soit parce qu&apos;elle est plus loin que le
          chapitre {boundaryChapter}. Publiez un chapitre de plus et celles
          qu&apos;il pourrait éclaircir redeviennent à examiner.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={running}
            onClick={() => void run()}
            className="bouton bouton-mer"
          >
            {running
              ? total === 0
                ? 'Lecture…'
                : `Lecture… ${lines.length} sur ${total}`
              : phase === 'idle'
                ? `Vérifier les ${questions} question(s) sans réponse`
                : 'Recommencer'}
          </button>

          {running && (
            <button
              type="button"
              onClick={() => {
                stopped.current = true
              }}
              className="bouton"
            >
              Arrêter
            </button>
          )}
        </div>
      )}

      {running && (
        <p className="mt-3 text-sm text-muted" role="status">
          Un appel de modèle par question, en série : comptez une dizaine de
          secondes chacune, et quelques dollars pour un arriéré de soixante-dix.
          Vous pouvez arrêter à tout moment — ce qui est refermé le reste.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}

      {lines.length > 0 && (
        <div className="mt-4">
          <p role="status" className="text-sm text-primary">
            {lines.length} question(s) examinée(s) sur {total} — {closed.length}{' '}
            refermée(s), {stillOpen.length} laissée(s) ouverte(s)
            {failed.length > 0 ? `, ${failed.length} en échec` : ''}.
            {cost > 0 ? ` Coût des appels : ${(cost / 100).toFixed(2)} $.` : ''}
            {failed.length > 0
              ? ' Les questions en échec n’ont rien changé : relancez pour les reprendre.'
              : ''}
            {phase === 'stopped' ? ' Arrêté : le reste n’a pas été examiné.' : ''}
          </p>

          <ul className="mt-3 space-y-2">
            {lines.map((line) => (
              <li key={line.entityId}>
                <Resultat line={line} boundaryChapter={boundaryChapter} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * Ce qu'une question a donné, et ce qu'on peut en dire.
 *
 * Une résolution postérieure au chapitre où le lecteur se trouve est annoncée
 * sans son chapitre et sans sa scène. Ce n'est pas de la pudeur : le balayage
 * lit toute la bibliothèque publiée, donc il *sait* — et la page qui masque
 * cette date partout ailleurs la donnerait ici, dans le rapport d'un bouton que
 * le lecteur a pressé lui-même. L'action a déjà retiré ce qu'il ne faut pas
 * dire ; ce composant ne reçoit que ce qui est montrable.
 */
function Resultat({
  line,
  boundaryChapter,
}: {
  line: Line
  boundaryChapter: number
}) {
  const closed = line.kind === 'closed' || line.kind === 'already'
  /*
   * Une question que l'appel n'a pas pu examiner n'est pas « toujours ouverte ».
   *
   * La distinction n'est pas cosmétique : « toujours ouverte » est un résultat —
   * le modèle a relu les scènes et aucune n'y répond — et l'afficher sur un
   * appel qui n'a jamais eu lieu ferait dire au rapport le contraire de ce qui
   * s'est passé. Elle est intacte, elle n'a rien coûté, et la relancer la posera.
   */
  const broke = line.kind === 'failed'
  /* Refermée sans chapitre : la réponse est au-delà du curseur. */
  const beyond = closed && line.chapter == null

  return (
    <article className="panneau">
      <div className="panneau-corps">
        <p className="text-primary">
          {line.entityId ? (
            <Link
              href={`/entite/${line.entityId}?ch=${boundaryChapter}`}
              className="hover:underline"
            >
              {line.question}
            </Link>
          ) : (
            line.question
          )}
        </p>

        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span
            className={`badge ${broke ? 'badge-gris' : closed ? 'badge-vert' : 'badge-mer'}`}
          >
            {broke ? 'Non examinée' : closed ? 'Refermée' : 'Toujours ouverte'}
          </span>
          <span className="cartouche">
            posée au chapitre {line.openedInChapter}
          </span>
          {closed && line.chapter != null && (
            <span className="cartouche">résolue au chapitre {line.chapter}</span>
          )}
          {line.kind === 'already' && (
            <span className="cartouche">déjà refermée avant ce passage</span>
          )}
        </p>

        {beyond && (
          <p className="mt-2 text-sm text-secondary">
            La réponse est plus loin que le chapitre {boundaryChapter}, où vous
            en êtes. Elle est écrite&nbsp;; elle apparaîtra le jour où vous
            l&apos;aurez lue.
          </p>
        )}

        {line.kind === 'closed' && line.summary && (
          <p className="mt-2 text-sm text-secondary">{line.summary}</p>
        )}

        {line.kind === 'open' && (
          <p className="mt-2 text-sm text-muted">
            {line.because === 'no-scenes'
              ? 'Aucune scène publiée après elle : rien à lui opposer.'
              : line.because === 'refused'
                ? 'Le modèle n’a pas répondu sur cette question.'
                : `${line.scenesRead} scène(s) relue(s), aucune n’y répond.`}
            {line.scenesDropped
              ? ` ${line.scenesDropped} scène(s) non lues (plafond par question).`
              : ''}
          </p>
        )}

        {broke && (
          <p className="mt-2 text-sm text-muted">
            L&apos;appel a échoué&nbsp;: {line.error ?? 'raison inconnue'} Le
            balayage a continué sans elle — elle est restée telle quelle, et la
            relancer la posera.
          </p>
        )}

        {line.kind === 'gone' && (
          <p className="mt-2 text-sm text-muted">
            Cette question n&apos;est plus dans le graphe : son chapitre a dû
            être supprimé entre-temps.
          </p>
        )}
      </div>
    </article>
  )
}
