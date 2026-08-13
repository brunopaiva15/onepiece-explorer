'use client'

import { useState, useTransition } from 'react'
import type { Coverage } from '@/domains/images/index.ts'
import { enrichImagesAction, type EnrichImagesResult } from './actions.ts'

/**
 * The illustrate button, and the coverage it is meant to move.
 *
 * The numbers are shown before the button rather than after, because "412 of
 * 690 characters have a picture" is the only thing that makes the button worth
 * pressing — or worth leaving alone. A bare "Enrichir" would be a button whose
 * effect the reader has to guess.
 *
 * It can take minutes on a large library: one HTTP request per picture, paced
 * so as not to hammer three services that owe us nothing. That is stated rather
 * than hidden behind a spinner.
 */

const TYPE_LABELS: Record<string, string> = {
  character: 'Personnages',
  power: 'Fruits du démon et pouvoirs',
  object: 'Objets et navires',
  place: 'Lieux et îles',
}

export function EnrichImages({ coverage }: { coverage: Coverage[] }) {
  const [result, setResult] = useState<EnrichImagesResult | null>(null)
  const [pending, start] = useTransition()

  const missing = coverage.reduce(
    (total, line) => total + (line.total - line.illustrated),
    0,
  )

  return (
    <div className="mt-4">
      {coverage.length === 0 ? (
        <p className="text-sm text-secondary">
          Aucune entité illustrable pour l&apos;instant. Importez et publiez un
          chapitre, et les personnages, fruits, navires et lieux qu&apos;il révèle
          apparaîtront ici.
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {coverage.map((line) => {
            const share =
              line.total === 0 ? 0 : Math.round((line.illustrated / line.total) * 100)
            return (
              <li key={line.nodeType} className="flex items-center gap-3">
                <span className="w-56 text-secondary">
                  {TYPE_LABELS[line.nodeType] ?? line.nodeType}
                </span>
                <span className="font-mono text-xs text-primary">
                  {line.illustrated}/{line.total}
                </span>
                <span
                  className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-overlay"
                  role="img"
                  aria-label={`${share} % illustrés`}
                >
                  <span
                    className="block h-full bg-accent"
                    style={{ width: `${share}%` }}
                  />
                </span>
                <span className="text-xs text-muted">{share} %</span>
              </li>
            )
          })}
        </ul>
      )}

      {coverage.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={pending || missing === 0}
              onClick={() =>
                start(async () => {
                  setResult(await enrichImagesAction())
                })
              }
              className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong disabled:opacity-40"
            >
              {pending
                ? 'Recherche des illustrations…'
                : missing === 0
                  ? 'Tout est illustré'
                  : `Chercher une image pour ${missing} entité(s)`}
            </button>

            {/*
              The same run, on entities that already have a picture.
              A library illustrated before portraits carried a date holds only
              undated ones, and no amount of ordinary enrichment will look at
              them again — the pass skips whatever already has a face. Nothing
              is replaced: what this finds is added beside what is there, and
              the reader's position decides which one is shown.
            */}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setResult(await enrichImagesAction(true))
                })
              }
              className="rounded-sm border border-line px-3 py-2 text-sm text-secondary hover:text-primary disabled:opacity-40"
            >
              Redater les portraits déjà trouvés
            </button>
          </div>

          {pending ? (
            <p className="mt-2 text-sm text-muted" role="status">
              Une requête par image, à un rythme volontairement lent : les trois
              catalogues sont gratuits et ne nous doivent rien. Comptez quelques
              minutes sur une grande bibliothèque.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Une quinzaine d&apos;entités sont illustrées automatiquement à
              chaque chapitre ouvert à la lecture. Ce bouton sert à rattraper le
              reste d&apos;un coup.
            </p>
          )}
        </>
      )}

      {result && !result.ok && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div
          role="status"
          className="mt-4 rounded-sm border border-line bg-surface-raised p-4 text-sm"
        >
          <p className="text-primary">
            {result.stored} image(s) récupérée(s) sur {result.considered} entité(s)
            examinée(s).
          </p>
          {result.preTimeskip ? (
            <p className="mt-1 text-secondary">
              Dont {result.preTimeskip} portrait(s) d&apos;avant l&apos;ellipse :
              le wiki date ses fichiers, et ce sont ceux-là qui s&apos;affichent
              tant que vous n&apos;avez pas atteint le chapitre 598. Les autres
              personnages gardent une illustration sans date, faute de mieux.
            </p>
          ) : null}
          {result.fromWiki ? (
            <p className="mt-1 text-secondary">
              Dont {result.fromWiki} trouvée(s) sur le wiki, faute de
              correspondance dans les catalogues — c&apos;est la voie des lieux,
              des groupes et des espèces, qu&apos;aucun des trois ne référence.
            </p>
          ) : null}
          <p className="mt-1 text-secondary">
            {result.unmatched} sans image : ni les {result.catalogueSize}{' '}
            illustrations du catalogue ni le wiki n&apos;ont de fiche à ce nom —
            c&apos;est le cas normal pour un personnage secondaire ou une
            désignation provisoire, pas une erreur.
          </p>
          {result.failures ? (
            <p className="mt-1 text-[var(--epi-contradicted)]">
              {result.failures} échec(s) de téléchargement.
            </p>
          ) : null}
          {result.notes && result.notes.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {result.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
