import type { Metadata } from 'next'
import Link from 'next/link'
import { getReaderSession } from '@/domains/auth/session.ts'
import { listChapters } from '@/domains/chapters/queries.ts'
import { listOrphanedAssertions } from '@/domains/chapters/delete.ts'
import {
  costSummary,
  failureHealth,
  quarantineHealth,
} from '@/domains/observability/costs.ts'
import { hasEmbeddingProvider } from '@/domains/search/index.ts'
import { effectiveModelProvider, hasModelCredentials } from '@/lib/env.ts'
import { DeleteChapter } from './delete-chapter.tsx'

export const metadata: Metadata = { title: 'Réglages et santé' }
export const dynamic = 'force-dynamic'

/**
 * Where the reader can see what the tool has cost them and take their data back.
 *
 * Both are load-bearing rather than nice-to-have. A tool that spends money on
 * your behalf and does not show you the bill is asking for trust it has not
 * earned; a private tool holding months of your reading and no way out is
 * holding it hostage.
 */
export default async function SettingsPage() {
  const session = await getReaderSession()

  const [chapters, costs, quarantine, failures, orphans] = await Promise.all([
    listChapters(session.userId, session.workId),
    costSummary(session.userId),
    quarantineHealth(session.userId),
    failureHealth(session.userId),
    listOrphanedAssertions(session.userId),
  ])

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-6 py-12">
      <nav className="text-sm">
        <Link href="/" className="text-muted hover:text-primary">
          Journal d&apos;exploration
        </Link>
      </nav>

      <h1 className="mt-4 text-4xl font-semibold text-primary">
        Réglages et santé
      </h1>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-primary">Configuration</h2>
        <dl className="mt-3 divide-y divide-[var(--border)] text-sm">
          <Row
            label="Fournisseur de modèle"
            value={effectiveModelProvider()}
            note={
              hasModelCredentials()
                ? undefined
                : "Aucune clé Anthropic : l'extraction affichée est dérivée du texte, pas d'une lecture des pages."
            }
          />
          <Row
            label="Recherche sémantique"
            value={hasEmbeddingProvider() ? 'active' : 'désactivée'}
            note={
              hasEmbeddingProvider()
                ? undefined
                : 'La recherche plein texte, approchante et par graphe fonctionne sans elle.'
            }
          />
          <Row
            label="Position de lecture"
            value={
              session.followingLatest
                ? `tout (jusqu'au chapitre ${session.maxChapter})`
                : `chapitre ${session.boundaryChapter} sur ${session.maxChapter}`
            }
          />
        </dl>
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">Coût de l&apos;IA</h2>

        {costs.chaptersProcessed === 0 ? (
          <p className="mt-3 text-sm text-secondary">
            Aucun traitement encore lancé.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-secondary">
              {(costs.totalCents / 100).toFixed(2)} $ au total ·{' '}
              {(costs.averagePerChapterCents / 100).toFixed(3)} $ par chapitre en
              moyenne, sur {costs.chaptersProcessed} chapitre(s).
              {costs.estimateAccuracy !== null && (
                <>
                  {' '}L&apos;estimation était{' '}
                  {costs.estimateAccuracy > 1.15
                    ? `optimiste d'un facteur ${costs.estimateAccuracy.toFixed(2)}`
                    : costs.estimateAccuracy < 0.85
                      ? `pessimiste d'un facteur ${(1 / costs.estimateAccuracy).toFixed(2)}`
                      : 'juste'}
                  .
                </>
              )}
              {costs.cacheHitRate !== null && costs.cacheHitRate > 0 && (
                <>
                  {' '}
                  {Math.round(costs.cacheHitRate * 100)} % des tokens d&apos;entrée
                  sont venus du cache.
                </>
              )}
            </p>

            <table className="mt-4 w-full border-collapse text-sm">
              <caption className="sr-only">Coût par étape du pipeline</caption>
              <thead>
                <tr className="border-b border-line-strong text-left text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Étape</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Exécutions</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Total</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Tokens</th>
                  <th scope="col" className="py-2 font-medium">Modèle</th>
                </tr>
              </thead>
              <tbody>
                {costs.byStep.map((step) => (
                  <tr key={step.stepKey} className="border-b border-line">
                    <td className="py-2 pr-3 font-mono text-xs text-primary">
                      {step.stepKey}
                    </td>
                    <td className="py-2 pr-3 text-secondary">{step.runs}</td>
                    <td className="py-2 pr-3 text-secondary">
                      {step.totalCents === 0
                        ? '—'
                        : `${(step.totalCents / 100).toFixed(4)} $`}
                    </td>
                    <td className="py-2 pr-3 text-secondary">
                      {step.tokensIn + step.tokensOut === 0
                        ? '—'
                        : `${formatCount(step.tokensIn)} / ${formatCount(step.tokensOut)}`}
                    </td>
                    <td className="py-2 font-mono text-xs text-muted">
                      {step.modelId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {(quarantine.length > 0 || failures.length > 0) && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold text-primary">Santé du pipeline</h2>

          {quarantine.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-medium text-primary">Quarantaine</h3>
              <p className="mt-1 text-sm text-secondary">
                {/* The distribution is the diagnostic: thirty of one reason is
                    systematic, one each of thirty is an ordinary bad day. */}
                Une même raison qui domine indique un problème systématique, pas
                une mauvaise passe du modèle.
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {quarantine.map((entry) => (
                  <li key={entry.reason} className="flex gap-3">
                    <span className="font-mono text-muted">{entry.count}</span>
                    <span className="text-secondary">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {failures.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-[var(--epi-contradicted)]">
                Échecs d&apos;étape
              </h3>
              <ul className="mt-2 space-y-2 text-sm">
                {failures.map((entry) => (
                  <li key={entry.stepKey}>
                    <span className="font-mono text-xs text-primary">
                      {entry.stepKey}
                    </span>
                    <span className="ml-2 text-muted">
                      {entry.attempts} tentative(s)
                    </span>
                    <p className="text-secondary">{entry.lastError}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {orphans.length > 0 && (
        <section className="mt-12">
          <h2 className="text-lg font-semibold text-primary">
            Faits sans source ({orphans.length})
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-secondary">
            Ces faits restent dans votre graphe mais leur chapitre a été supprimé :
            ils ne sont plus vérifiables. Réimportez le chapitre concerné et la
            preuve se rattache d&apos;elle-même.
          </p>
          <ul className="mt-3 space-y-1 text-sm text-secondary">
            {orphans.slice(0, 20).map((orphan) => (
              <li key={orphan.id}>
                <span className="font-mono text-accent">{orphan.predicate}</span>
                <span className="ml-2 text-muted">chapitre {orphan.chapter}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12">
        <h2 className="text-lg font-semibold text-primary">Vos données</h2>
        <p className="mt-2 max-w-2xl text-sm text-secondary">
          L&apos;export contient tout : chapitres, entités, assertions, preuves,
          vos théories et chacune de vos décisions de revue. Pas les pages
          elles-mêmes — ce sont vos fichiers, vous les avez déjà, et un export
          qui les embarquerait ferait de cet outil un canal de redistribution.
        </p>
        <a
          href="/api/export"
          download
          className="mt-4 inline-block rounded-sm bg-accent px-4 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
        >
          Télécharger l&apos;export complet (JSON)
        </a>
      </section>

      {chapters.length > 0 && (
        <section className="mt-12 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">
            Supprimer un chapitre
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-secondary">
            Les pages et leurs dérivés sont effacés du stockage. Les faits
            appris, eux, sont conservés : vous les avez appris, et les effacer
            réécrirait votre graphe à votre place. Ils apparaîtront ci-dessus
            comme non vérifiables jusqu&apos;à un réimport.
          </p>
          <DeleteChapter
            chapters={chapters.map((chapter) => ({
              id: chapter.id,
              number: chapter.number,
              title: chapter.title,
              pageCount: chapter.pageCount,
            }))}
          />
        </section>
      )}
    </main>
  )
}

function Row({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 py-2.5">
      <dt className="text-secondary">{label}</dt>
      <dd className="ml-auto font-mono text-xs text-primary">{value}</dd>
      {note && <p className="w-full text-xs text-muted">{note}</p>}
    </div>
  )
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
