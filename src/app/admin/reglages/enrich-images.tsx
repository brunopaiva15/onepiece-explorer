'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import type { Coverage } from '@/domains/images/index.ts'
import { nodeTypeLabel } from '@/domains/knowledge/predicate-label.ts'
import {
  enrichImagesAction,
  enrichPostersAction,
  type EnrichImagesResult,
  type EnrichPostersResult,
} from './actions.ts'

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
                  setResult(await enrichImagesAction({ includeIllustrated: true }))
                })
              }
              className="rounded-sm border border-line px-3 py-2 text-sm text-secondary hover:text-primary disabled:opacity-40"
            >
              Redater les portraits déjà trouvés
            </button>

            {/*
              The one button that takes something away.
              « Morgan », met in chapter 3, was wearing the face of « Morgans »,
              who appears eight hundred chapters later: a resemblance between
              two spellings and nothing else. The rule that refuses that
              rapprochement does nothing for a library already illustrated —
              the ordinary pass skips whatever has a face. This is the only
              path to it, and it hands the entity back to the catalogues in the
              same run.
            */}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setResult(await enrichImagesAction({ recheck: true }))
                })
              }
              className="rounded-sm border border-line px-3 py-2 text-sm text-secondary hover:text-primary disabled:opacity-40"
            >
              Revérifier les rapprochements
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
          {result.dropped ? (
            <p className="mt-1 text-secondary">
              {result.dropped} image(s) retirée(s) : elles avaient été trouvées
              par ressemblance de nom avec un personnage que le catalogue
              lui-même situe des centaines de chapitres plus loin. Les entités
              concernées viennent d&apos;être réexaminées.
            </p>
          ) : null}
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
              correspondance dans les catalogues. C&apos;est la voie des lieux,
              des groupes et des espèces, qu&apos;aucun des trois ne référence.
            </p>
          ) : null}
          <p className="mt-1 text-secondary">
            {result.unmatched} sans image : ni les {result.catalogueSize}{' '}
            illustrations du catalogue ni le wiki n&apos;ont de fiche à ce nom.
            C&apos;est le cas normal pour un personnage secondaire ou une
            désignation provisoire, pas une erreur.
          </p>

          {/*
            Which ones, by name.

            The count alone is not actionable: thirty walk-on characters with
            no portrait is the system working, while one missing island is
            nearly always a spelling the wiki files differently — and that is
            fixed on the fiche in a minute. Folded by default, so the summary
            stays three lines and the list is there for whoever wants it.
          */}
          <UnmatchedList
            entities={result.unmatchedEntities ?? []}
            total={result.unmatched ?? 0}
          />

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

/**
 * The entities the run left without a picture, named and linked.
 *
 * Each name goes to its fiche, because that is where the two things worth doing
 * about it live: rename the entity to the spelling the catalogues use, or
 * decide it is a walk-on and leave it alone. A list you can only read would be
 * a longer version of the count it replaces.
 *
 * `total` rather than `entities.length` in the summary: the action caps how
 * many names it sends back, and a list that quietly stops at two hundred while
 * claiming to be the whole thing would be worse than the bare number.
 */
function UnmatchedList({
  entities,
  total,
}: {
  entities: NonNullable<EnrichImagesResult['unmatchedEntities']>
  total: number
}) {
  if (entities.length === 0) return null

  const hidden = total - entities.length

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-secondary hover:text-primary">
        Voir lesquelles ({entities.length}
        {hidden > 0 ? ` sur ${total}` : ''})
      </summary>
      <ul className="mt-2 space-y-1 text-sm">
        {entities.map((entity) => (
          <li key={entity.entityId} className="flex items-baseline gap-2">
            <Link
              href={`/entite/${entity.entityId}`}
              className="text-primary hover:underline"
            >
              {entity.label}
            </Link>
            <span className="text-xs text-muted">
              {nodeTypeLabel(entity.nodeType)}
            </span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="mt-2 text-xs text-muted">
          … et {hidden} autre(s), non listée(s) ici.
        </p>
      ) : null}
    </details>
  )
}

/**
 * Les avis de recherche, et ce que la galerie du wiki ne tient pas.
 *
 * The unresolved list is the useful half of this panel, not an apology. The
 * wiki's gallery holds a handful of old printings and files them under names
 * that do not say which is which, so most of the manifest cannot be resolved
 * automatically and never will be. Printing them is what turns « fourteen
 * stored » into something a person can act on: each line is a poster somebody
 * can find, open, and pin in bounties.ts.
 */
export function EnrichPosters({ characters }: { characters: number }) {
  const [result, setResult] = useState<EnrichPostersResult | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="mt-4">
      <p className="text-sm text-secondary">
        Les vraies affiches, prises sur le wiki et datées du chapitre qui les
        montre. Le manifeste couvre {characters} personnages : la prime affichée
        est celle imprimée sur l&apos;affiche, et une affiche n&apos;apparaît pas
        avant le chapitre où vous la voyez.
      </p>

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setResult(await enrichPostersAction())
          })
        }
        className="bouton mt-3"
      >
        {pending ? 'Récupération…' : 'Récupérer les avis de recherche'}
      </button>

      {result && !result.ok && (
        <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="mt-3 border-[3px] border-ink bg-surface-raised px-3 py-2 text-sm">
          <p className="text-primary">
            {result.stored} affiche(s) stockée(s) pour {result.considered}{' '}
            personnage(s), sur {result.resolved} tirage(s) rattaché(s) à un
            fichier.
            {/*
             * « Déjà en place » rather than nothing.
             *
             * A second run stores zero, because a poster is fetched once. The
             * line above then reads as a failure unless it says where the rest
             * went — and this is also the number that says the automatic pass
             * is doing its job, since the posters it brought in on publication
             * are counted here rather than downloaded again.
             */}
            {result.skipped ? ` ${result.skipped} déjà en place.` : ''}
          </p>

          <p className="mt-1 text-xs text-muted">
            Les affiches épinglées arrivent aussi toutes seules, à la
            publication d&apos;un chapitre. Ce bouton fait la passe complète :
            il relit la galerie du wiki et rapporte ce qui reste sans fichier.
          </p>

          {result.unresolved && result.unresolved.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-secondary hover:text-primary">
                Tirages sans fichier ({result.unresolved.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {result.unresolved.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                La galerie du wiki ne nomme pas ces tirages. Pour en rattacher un,
                ajoutez son fichier à sa ligne dans{' '}
                <code>src/domains/images/bounties.ts</code>.
              </p>
            </details>
          )}

          {/*
            Declined, which is not the same thing as missing.
            These printings have a picture and it was drawn for television. The
            list is here so that nobody spends an evening looking for a file
            that is already on the line, and so that the decision stays visible
            instead of living only in a comment.
          */}
          {result.declined && result.declined.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-secondary hover:text-primary">
                Tirages écartés, image hors manga ({result.declined.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {result.declined.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                La prime est bien celle du manga ; la seule image qui existe a
                été dessinée par l&apos;anime. Ces personnages apparaissent sur
                le mur avec leur portrait et leur prime, sans affiche.
              </p>
            </details>
          )}

          {result.failures && result.failures.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-[var(--epi-contradicted)]">
              {result.failures.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
