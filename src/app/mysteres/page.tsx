import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { getTimeline, type TimelineEntry } from '@/domains/temporal/timeline.ts'

export const metadata: Metadata = { title: 'Mystères' }
export const dynamic = 'force-dynamic'

/**
 * The questions the story has opened, and the ones it has closed.
 *
 * Linked from the rail and from the home page since both were written, and a
 * 404 until now.
 *
 * **Open or resolved is decided by `resolvedInChapter`, never by `state`.** A
 * mystery whose row says `resolved` was resolved *somewhere* — possibly three
 * hundred chapters past where the reader is. The projection already nulls a
 * resolution chapter beyond the boundary, so reading that field is reading
 * "resolved *as far as you know*", which is the only honest question this page
 * can answer. Reading `state` instead would put « résolu » next to a question
 * whose answer is a spoiler.
 */
export default async function MysteriesPage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string }>
}) {
  const { ch } = await searchParams
  const session = await getViewerSession(ch)
  const timeline = await getTimeline(session.userId, session.boundaryChapter)

  /*
   * The same question, asked once.
   *
   * Publication now refuses to create a second entity for a question the graph
   * already holds — but a library built before that refusal has the duplicates
   * already, and re-importing every chapter to clear them is not a repair
   * anybody owes. Two rows saying exactly the same words are one question to a
   * reader, so the page shows it once, keeping the earliest: the chapter that
   * asked it first is the true one.
   */
  const seen = new Set<string>()
  const mysteries = timeline.byRevelation
    .filter((entry) => entry.kind === 'mystery')
    .sort((a, b) => a.knownFromChapter - b.knownFromChapter)
    .filter((entry) => {
      const key = (entry.summary ?? entry.label).trim().toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  const open = mysteries.filter((entry) => entry.resolvedInChapter === null)
  const closed = mysteries
    .filter((entry) => entry.resolvedInChapter !== null)
    .sort((a, b) => (b.resolvedInChapter ?? 0) - (a.resolvedInChapter ?? 0))

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-3xl font-semibold text-primary">Mystères</h1>
      <p className="mt-2 max-w-2xl text-sm text-secondary">
        Ce que l&apos;histoire a demandé sans y répondre, et ce qu&apos;elle a
        fini par éclaircir. Une question est ouverte tant que <em>vous</em>{' '}
        n&apos;avez pas lu sa réponse — reculez le curseur et une question
        refermée redevient ouverte.
      </p>

      {mysteries.length === 0 && (
        <p className="mt-8 rounded-sm border border-line bg-surface-raised p-6 text-secondary">
          Aucun mystère au chapitre {session.boundaryChapter}. Le pipeline en
          propose à partir de ce que les chapitres laissent en suspens ; il
          n&apos;y en a pas encore dans ce que vous avez publié.
        </p>
      )}

      {open.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-primary">
            Sans réponse ({open.length})
          </h2>
          <ul className="mt-3 space-y-2">
            {open.map((entry) => (
              <li key={entry.entityId}>
                <Mystery entry={entry} boundary={session.boundaryChapter} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 && (
        <section className="mt-12 border-t border-line pt-6">
          <h2 className="text-lg font-semibold text-primary">
            Refermées ({closed.length})
          </h2>
          <ul className="mt-3 space-y-2">
            {closed.map((entry) => (
              <li key={entry.entityId}>
                <Mystery entry={entry} boundary={session.boundaryChapter} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

function Mystery({
  entry,
  boundary,
}: {
  entry: TimelineEntry
  boundary: number
}) {
  const resolved = entry.resolvedInChapter
  /*
   * How long it stood open, which is the number nobody has to hand.
   *
   * For a closed question it is the distance between the two chapters. For an
   * open one it is the distance to where the reader is now — « ouverte depuis
   * 240 chapitres » is the whole reason a reader looks at this page.
   */
  const span = (resolved ?? boundary) - entry.knownFromChapter

  return (
    <article className="panneau">
      <div className="panneau-corps">
        <p className="text-primary">
          <Link
            href={`/entite/${entry.entityId}?ch=${boundary}`}
            className="hover:underline"
          >
            {entry.summary ?? entry.label}
          </Link>
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`badge ${resolved === null ? 'badge-mer' : 'badge-vert'}`}>
            {resolved === null ? 'Ouverte' : 'Refermée'}
          </span>
          <span className="cartouche">
            posée au chapitre {entry.knownFromChapter}
          </span>
          {resolved !== null && (
            <span className="cartouche">résolue au chapitre {resolved}</span>
          )}
          {span > 0 && (
            <span className="cartouche">
              {span} chapitre{span > 1 ? 's' : ''}{' '}
              {resolved === null ? 'sans réponse' : 'pour y répondre'}
            </span>
          )}
        </p>
      </div>
    </article>
  )
}
