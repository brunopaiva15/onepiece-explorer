'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FindingRow } from '@/domains/review/audit-run.ts'
import type { AuditFix } from '@/domains/review/audit.ts'
import { applyFindingAction, ignoreFindingAction } from './actions.ts'

/**
 * Une famille de constats, et les deux gestes qui les règlent.
 *
 * Ce que chaque ligne montre avant de proposer quoi que ce soit : le chapitre,
 * la phrase du défaut, et — quand il y en a une — la correction *en toutes
 * lettres*. « 27 entités seront modifiées » est un nombre qu'il faut croire ;
 * « la scène « … » cesse d'être lue » est une affirmation vérifiable, et c'est
 * la seule forme sous laquelle un bouton a le droit d'écrire dans le graphe.
 *
 * Corriger tout est offert par famille et jamais sur toute la page. Une famille
 * est une décision — « oui, ces doublons sont des doublons » — et les mélanger
 * ferait de « tout corriger » un vœu plutôt qu'un choix. Les familles sans
 * correction mécanique n'ont pas le bouton du tout : elles renvoient vers la
 * fiche, où le geste existe et montre ce qu'il coûte.
 */
export function FindingsBoard({
  title,
  origin,
  findings,
}: {
  title: string
  /** L'analyse d'où viennent ces constats, dite au-dessus de la liste. */
  origin: string
  findings: FindingRow[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [done, setDone] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)

  const fixable = findings.filter((finding) => finding.fix !== null && !done[finding.id])
  const remaining = findings.filter((finding) => !done[finding.id])

  const decide = (finding: FindingRow, how: 'apply' | 'ignore'): void => {
    start(async () => {
      const outcome =
        how === 'apply'
          ? await applyFindingAction(finding.id)
          : await ignoreFindingAction(finding.id)

      if (outcome.ok) {
        setDone((current) => ({ ...current, [finding.id]: outcome.message ?? 'Fait.' }))
        router.refresh()
      } else {
        setFailed((current) => ({ ...current, [finding.id]: outcome.error ?? 'Échec.' }))
      }
    })
  }

  /*
   * Un par un, et non tous ensemble.
   *
   * Une correction lit le constat en base avant d'écrire, et deux corrections de
   * la même famille peuvent viser la même fiche — la seconde doit voir ce que la
   * première a fait, sinon elle écrit par-dessus une ligne qui a changé. Le prix
   * est la durée ; ce qu'on y gagne est qu'une correction refusée le dise au lieu
   * de disparaître dans un lot.
   */
  const applyAll = (): void => {
    start(async () => {
      setRunning(true)
      for (const finding of fixable) {
        const outcome = await applyFindingAction(finding.id)
        if (outcome.ok) {
          setDone((current) => ({ ...current, [finding.id]: outcome.message ?? 'Fait.' }))
        } else {
          setFailed((current) => ({ ...current, [finding.id]: outcome.error ?? 'Échec.' }))
        }
      }
      setRunning(false)
      router.refresh()
    })
  }

  return (
    <section className="panneau">
      <h2 className="panneau-titre flex flex-wrap items-center justify-between gap-3">
        <span>
          {title} <span className="tabular text-sm">({remaining.length})</span>
          <span className="cartouche ml-2 normal-case">{origin}</span>
        </span>
        {fixable.length > 1 && (
          <button
            type="button"
            disabled={pending}
            onClick={applyAll}
            className="bouton !py-1 !text-sm"
          >
            {running ? 'Correction…' : `Corriger les ${fixable.length}`}
          </button>
        )}
      </h2>

      <ul className="panneau-corps divide-y-[3px] divide-ink">
        {findings.map((finding) => (
          <li key={finding.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3">
              <span className="chiffre shrink-0 border-[3px] border-ink bg-sea-deep px-2 py-0.5 text-white">
                {finding.chapter}
              </span>

              <div className="min-w-0 flex-1">
                <p className="font-display uppercase leading-tight text-primary">
                  {finding.title}
                </p>

                {finding.detail && (
                  <p className="mt-1 whitespace-pre-line text-sm text-secondary">
                    {finding.detail}
                  </p>
                )}

                {/* Ce que le bouton écrira, en toutes lettres et avant de le
                    cliquer. « 27 entités seront modifiées » est un nombre qu'il
                    faut croire ; une phrase qui nomme l'écriture est
                    vérifiable, et c'est la seule forme sous laquelle un bouton
                    a le droit d'écrire dans le graphe. */}
                <p className="mt-1 text-xs text-muted">
                  {finding.fix
                    ? `Ce que le bouton écrit : ${WILL_WRITE[finding.fix.action]}`
                    : 'Aucune correction mécanique : ce constat dit où regarder, et le geste se prend sur la fiche.'}
                </p>

                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                  {finding.source === 'modele' ? (
                    <span title="Trouvé en relisant le chapitre, avec la phrase qui le prouve">
                      relecture
                    </span>
                  ) : (
                    <span title="Déduit de la bibliothèque elle-même, sans appel à un modèle">
                      règle
                    </span>
                  )}
                  {finding.subjectEntityId && (
                    <Link
                      href={`/entite/${finding.subjectEntityId}`}
                      className="text-primary hover:underline"
                    >
                      la fiche
                    </Link>
                  )}
                  {finding.objectEntityId && (
                    <Link
                      href={`/entite/${finding.objectEntityId}`}
                      className="text-primary hover:underline"
                    >
                      l’autre fiche
                    </Link>
                  )}
                  <Link href={`/delta/${finding.chapter}`} className="text-primary hover:underline">
                    le delta du chapitre
                  </Link>
                </p>

                {done[finding.id] && (
                  <p role="status" className="mt-2 text-sm text-[var(--epi-validated)]">
                    {done[finding.id]}
                  </p>
                )}
                {failed[finding.id] && (
                  <p role="alert" className="mt-2 text-sm text-[var(--epi-contradicted)]">
                    {failed[finding.id]}
                  </p>
                )}
              </div>

              {!done[finding.id] && (
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {finding.fix ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => decide(finding, 'apply')}
                      className="bouton bouton-primaire !py-1 !text-sm"
                    >
                      Corriger
                    </button>
                  ) : (
                    <span className="cartouche" title="Cette correction demande un jugement">
                      sur la fiche
                    </span>
                  )}
                  {finding.fix && (
                    <span
                      className="cartouche"
                      title={
                        NEEDS_REVIEW.has(finding.fix.action)
                          ? 'Le bouton dépose une proposition ; rien n’est affirmé sans votre accord'
                          : 'Une écriture dont toutes les valeurs sont connues d’avance'
                      }
                    >
                      {NEEDS_REVIEW.has(finding.fix.action) ? 'revue humaine' : 'mécanique'}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => decide(finding, 'ignore')}
                    className="cartouche underline"
                  >
                    écarter
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Ce que chaque correction écrit, dite avant d'être cliquée.
 *
 * Une phrase par action et jamais un décompte : ce qui rend un bouton
 * acceptable ici est qu'un humain puisse lire l'écriture en entier avant de le
 * presser. Les valeurs exactes — quel nœud, quel chapitre — sont déjà dans le
 * détail du constat, qui les nomme.
 */
const WILL_WRITE: Record<AuditFix['action'], string> = {
  rejeter_entite: 'la fiche passe en « rejetée » et sort du fil. Rien n’est supprimé.',
  redater_nom: 'la date de révélation du nom change.',
  promouvoir_nom: 'le rang d’affichage du nom change ; la nature du nom, non.',
  retirer_identite: 'l’identité passe en « rejetée ». Les deux fiches redeviennent deux choses.',
  avancer_entree: 'le chapitre d’entrée en scène change.',
  raccourcir_libelle:
    'le libellé est renommé ; l’ancienne formulation reste, sans être affichée.',
  reecrire_scene: 'la phrase de la scène est remplacée.',
  proposer_identite:
    'une carte est déposée dans le centre de revue, avec sa citation. Aucune identité n’est publiée.',
  publier_resolution:
    'une relation « résout le mystère » verrouillée est écrite, puis l’état de la question est recalculé depuis ses relations acceptées.',
  retirer_resolution:
    'la relation passe en « rejetée », puis l’état de la question est recalculé depuis celles qui restent.',
  recalculer_mystere:
    'l’état et la date de la question sont refaits depuis ses relations acceptées. Aucune relation n’est écrite ni retirée.',
}

/** Les corrections qui ne font que proposer : elles attendent un humain. */
const NEEDS_REVIEW = new Set<AuditFix['action']>(['proposer_identite'])
