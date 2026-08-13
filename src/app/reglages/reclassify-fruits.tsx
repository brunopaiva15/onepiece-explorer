'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import type { FiledFruit } from '@/domains/knowledge/retype.ts'
import { reclassifyDevilFruitsAction, type ReclassifyFruitsResult } from './actions.ts'

/**
 * The fruits still filed as powers, and the one button that moves them.
 *
 * They are named before the button rather than counted after it. « 27 entités
 * seront modifiées » is a number you have to trust; the list is a claim you can
 * check, and the reader is the only one who knows whether « Sube Sube no Mi »
 * in their library is the fruit or something else that happens to end that way.
 *
 * What comes back is three groups and not a total, because they mean different
 * things: what moved, what the ontology says would cost a published fact — left
 * untouched, with a link to the fiche where that decision belongs — and what
 * refused for a reason worth reading.
 */
export function ReclassifyFruits({ fruits }: { fruits: FiledFruit[] }) {
  const [result, setResult] = useState<ReclassifyFruitsResult | null>(null)
  const [pending, start] = useTransition()

  if (fruits.length === 0 && result === null) {
    return (
      <p className="mt-4 text-sm text-secondary">
        Aucun fruit classé en pouvoir. Les entités dont le nom finit par «&nbsp;no
        Mi&nbsp;» sont déjà des objets, ou votre bibliothèque n&apos;en contient
        pas encore.
      </p>
    )
  }

  const report = result?.result

  return (
    <div className="mt-4">
      {fruits.length > 0 && (
        <>
          <p className="text-sm text-secondary">
            {fruits.length} entité(s) dont le nom finit par «&nbsp;no Mi&nbsp;»
            sont classées en pouvoir&nbsp;:
          </p>
          <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {fruits.map((fruit) => (
              <li key={fruit.entityId}>
                <Link
                  href={`/entite/${fruit.entityId}`}
                  className="text-primary hover:underline"
                >
                  {fruit.label}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        type="button"
        onClick={() =>
          start(async () => {
            setResult(await reclassifyDevilFruitsAction())
          })
        }
        disabled={pending || fruits.length === 0}
        className="bouton bouton-primaire mt-4 !py-1.5 !text-sm"
      >
        {pending ? 'Reclassement…' : 'Les reclasser en objets'}
      </button>

      {result && !result.ok && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {result.error}
        </p>
      )}

      {report && (
        <div role="status" className="mt-3 space-y-2 text-sm">
          <p className="text-[var(--epi-validated)]">
            {report.retyped.length} reclassé(s) en objet.
          </p>

          {report.blocked.length > 0 && (
            <div className="text-secondary">
              <p>
                {report.blocked.length} laissé(s) tels quels&nbsp;: des faits
                déjà publiés ne sont pas possibles pour un objet. Le choix se
                fait sur la fiche, devant la liste de ce qu&apos;il coûte.
              </p>
              <ul className="mt-1 space-y-0.5">
                {report.blocked.map((fruit) => (
                  <li key={fruit.entityId}>
                    <Link
                      href={`/entite/${fruit.entityId}`}
                      className="text-primary hover:underline"
                    >
                      {fruit.label}
                    </Link>{' '}
                    <span className="font-mono text-xs text-muted">
                      {fruit.conflicts} fait(s) en travers
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.failed.length > 0 && (
            <ul className="space-y-0.5 text-[var(--epi-contradicted)]">
              {report.failed.map((fruit) => (
                <li key={fruit.entityId}>
                  «&nbsp;{fruit.label}&nbsp;» : {fruit.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
