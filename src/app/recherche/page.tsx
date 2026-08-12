import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { search, shortestPath, type SearchHit } from '@/domains/search/index.ts'
import { displayImages, type DisplayImage } from '@/domains/images/index.ts'
import { Portrait } from '@/app/components/portrait.tsx'
import { predicateLabel } from '@/domains/knowledge/predicate-label.ts'

export const metadata: Metadata = { title: 'Recherche' }
export const dynamic = 'force-dynamic'

/**
 * Search, and the connection finder.
 *
 * The path tool is the reason this page is not just a search box. Searching
 * finds what you already know to look for; asking "how are these two
 * connected" surfaces the chain you had not thought to trace — which is the
 * thing a single interconnected graph is for, and the thing a wiki cannot do
 * at all.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string; q?: string; de?: string; vers?: string }>
}) {
  const { ch, q, de, vers } = await searchParams
  const session = await getViewerSession(ch)

  const query = (q ?? '').trim()
  const results = query
    ? await search(session.userId, session.boundaryChapter, query)
    : null

  const path =
    de && vers
      ? await shortestPath(session.userId, session.boundaryChapter, de, vers)
      : null

  // One query for the whole result list. A picture per row fetched row by row
  // would be twenty round trips to sign twenty URLs.
  const portraits = await displayImages(
    session.userId,
    session.boundaryChapter,
    [...new Set((results?.hits ?? []).map((hit) => hit.entityId).filter((id): id is string => id !== null))],
  )

  return (
    <>

      <main id="contenu" className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-3xl font-semibold text-primary">Recherche</h1>

        <form action="/recherche" method="get" className="mt-5 flex flex-wrap gap-2">
          <input type="hidden" name="ch" value={session.boundaryChapter} />
          <input
            name="q"
            type="search"
            defaultValue={query}
            placeholder="un nom, une phrase, un lieu…"
            aria-label="Rechercher"
            className="min-w-64 flex-1 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          />
          <button
            type="submit"
            className="rounded-sm bg-accent px-5 py-2 text-sm font-medium text-inverted hover:bg-accent-strong"
          >
            Chercher
          </button>
        </form>

        <p className="mt-2 text-sm text-muted">
          Cherche dans les noms, le texte des pages, les descriptions de cases,
          les événements et les mystères — le tout limité à ce que vous avez lu.
          Les accents et les fautes de frappe sont tolérés.
        </p>

        {results && (
          <>
            <ul className="mt-6 flex flex-wrap gap-2" aria-label="Méthodes utilisées">
              {results.modes.map((mode) => (
                <li
                  key={mode.mode}
                  title={mode.note}
                  className={`rounded-sm border px-2 py-0.5 text-xs ${
                    mode.ran
                      ? 'border-line text-secondary'
                      : 'border-dashed border-line text-muted'
                  }`}
                >
                  {modeLabel(mode.mode)}
                  {!mode.ran && ' — indisponible'}
                </li>
              ))}
            </ul>

            {results.modes
              .filter((mode) => !mode.ran && mode.note)
              .map((mode) => (
                <p key={mode.mode} className="mt-2 text-sm text-muted">
                  {mode.note}
                </p>
              ))}

            {results.hits.length === 0 ? (
              <p className="mt-6 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
                Rien pour « {results.query} » dans les chapitres 1 à{' '}
                {session.boundaryChapter}.
                {session.boundaryChapter < session.maxChapter &&
                  " Le curseur est en arrière : remontez-le pour chercher dans tout ce que vous avez importé."}
              </p>
            ) : (
              <ol className="mt-6 space-y-3">
                {results.hits.map((hit) => (
                  <li key={`${hit.kind}:${hit.id}`}>
                    <Hit
                      hit={hit}
                      boundary={session.boundaryChapter}
                      portrait={hit.entityId ? (portraits.get(hit.entityId) ?? null) : null}
                    />
                  </li>
                ))}
              </ol>
            )}
          </>
        )}

        <section className="mt-14 border-t border-line pt-8">
          <h2 className="text-lg font-semibold text-primary">
            Chemin entre deux entités
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-secondary">
            La chaîne de relations la plus courte, telle que vous la connaissez à
            ce chapitre. C&apos;est là qu&apos;apparaissent les liens auxquels on
            n&apos;avait pas pensé — et reculer le curseur montre à partir de quand
            le lien existait.
          </p>

          <form action="/recherche" method="get" className="mt-4 flex flex-wrap gap-2">
            <input type="hidden" name="ch" value={session.boundaryChapter} />
            <input
              name="de"
              defaultValue={de ?? ''}
              placeholder="identifiant de départ"
              aria-label="Entité de départ"
              className="min-w-56 flex-1 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 font-mono text-xs text-primary"
            />
            <input
              name="vers"
              defaultValue={vers ?? ''}
              placeholder="identifiant d'arrivée"
              aria-label="Entité d'arrivée"
              className="min-w-56 flex-1 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 font-mono text-xs text-primary"
            />
            <button
              type="submit"
              className="rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
            >
              Tracer
            </button>
          </form>

          {de && vers && !path && (
            <p className="mt-4 rounded-sm border border-line bg-surface-raised p-4 text-secondary">
              Aucun chemin connu entre ces deux entités au chapitre{' '}
              {session.boundaryChapter}. Ce n&apos;est pas une erreur : à ce stade,
              rien de ce que vous avez lu ne les relie.
            </p>
          )}

          {path && path.steps.length === 0 && (
            <p className="mt-4 text-secondary">
              Ce sont la même entité — fusionnées par une identité révélée.
            </p>
          )}

          {path && path.steps.length > 0 && (
            <ol className="mt-4 space-y-2">
              {path.steps.map((step, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-mono text-xs text-muted">{index + 1}.</span>
                  <Link
                    href={`/entite/${step.from}?ch=${session.boundaryChapter}`}
                    className="text-primary hover:underline"
                  >
                    {path.labels.get(step.from) ?? step.from}
                  </Link>
                  <span className="text-accent">{predicateLabel(step.predicate)}</span>
                  <Link
                    href={`/entite/${step.to}?ch=${session.boundaryChapter}`}
                    className="text-primary hover:underline"
                  >
                    {path.labels.get(step.to) ?? step.to}
                  </Link>
                  <span className="ml-auto font-mono text-xs text-muted">
                    su ch. {step.chapterNumber}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </>
  )
}

function Hit({
  hit,
  boundary,
  portrait,
}: {
  hit: SearchHit
  boundary: number
  portrait: DisplayImage | null
}) {
  const href = hit.entityId
    ? `/entite/${hit.entityId}?ch=${boundary}`
    : `/graph?ch=${boundary}`

  return (
    <article className="flex gap-3 rounded-sm border border-line bg-surface-raised p-4">
      {portrait && <Portrait image={portrait} label={hit.title} size="small" />}
      <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={href} className="font-medium text-primary hover:underline">
          {hit.title || '(sans titre)'}
        </Link>
        <span className="font-mono text-xs uppercase tracking-wide text-muted">
          {kindLabel(hit.kind)}
        </span>
        <span className="ml-auto font-mono text-xs text-muted">
          ch. {hit.chapterNumber}
        </span>
      </div>

      {hit.snippet !== hit.title && (
        // ts_headline wraps matches in « » rather than HTML, so this can be
        // rendered as text: no dangerouslySetInnerHTML for content that
        // originates in an imported file.
        <p className="mt-1.5 text-sm text-secondary">{hit.snippet}</p>
      )}

      <p className="mt-1 text-xs text-muted">{hit.reason}</p>
      </div>
    </article>
  )
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    lexical: 'plein texte',
    fuzzy: 'orthographe approchante',
    graph: 'voisinage dans le graphe',
    semantic: 'sens',
  }
  return labels[mode] ?? mode
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    entity: 'entité',
    text_block: 'texte de page',
    event: 'événement',
    mystery: 'mystère',
    panel: 'case',
  }
  return labels[kind] ?? kind
}
