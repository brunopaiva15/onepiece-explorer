'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FindingRow } from '@/domains/review/audit-run.ts'
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
export function FindingsBoard({ title, findings }: { title: string; findings: FindingRow[] }) {
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
