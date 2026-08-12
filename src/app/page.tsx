import Link from 'next/link'
import { getCurrentUser } from '@/domains/auth/server.ts'
import { getViewerSession } from '@/domains/auth/session.ts'
import { listChapters, type ChapterSummary } from '@/domains/chapters/queries.ts'
import { StatusBadge } from '@/app/ui/status-badge.tsx'

export const dynamic = 'force-dynamic'

/**
 * The command deck.
 *
 * What this replaced: a page explaining, to the person who built the library,
 * what the library is for. Three paragraphs of concept and a row of links. A
 * brochure — useful exactly once, and in the way of the work every day after.
 *
 * A tool opens on **state**. The first thing on screen is what is waiting for
 * you: a chapter whose proposals nobody has reviewed, a run that failed, a
 * chapter imported but never processed. Each is a card carrying the one button
 * that clears it. Below, the library at a glance.
 *
 * A visitor has no queue — nothing waits for someone who cannot act — so they
 * get the ways in instead.
 */

function pending(chapters: ChapterSummary[]) {
  return {
    aRelire: chapters.filter((c) => c.status === 'review'),
    aTraiter: chapters.filter((c) => c.status === 'draft' || c.status === 'uploaded'),
    enEchec: chapters.filter((c) => c.status === 'failed'),
    enCours: chapters.filter((c) => c.status === 'processing'),
    publies: chapters.filter((c) => c.status === 'published'),
  }
}

/** A task card: what is waiting, how much of it, and the one way to clear it. */
function Tache({
  titre,
  compte,
  href,
  action,
  ton,
  detail,
}: {
  titre: string
  compte: number
  href: string
  action: string
  ton: 'or' | 'mer' | 'rouge'
  detail: string
}) {
  const fond = { or: 'var(--accent)', mer: 'var(--sea)', rouge: 'var(--coral)' }[ton]
  const encre = ton === 'or' ? 'var(--ink)' : '#fff'

  return (
    <li className="panneau flex flex-col">
      <div
        className="flex items-center gap-3 border-b-[3px] border-ink px-3 py-2"
        style={{ background: fond, color: encre }}
      >
        <span className="chiffre text-4xl leading-none">{compte}</span>
        <span className="font-display text-base uppercase leading-tight">{titre}</span>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3 px-3 py-2.5">
        <p className="text-sm text-secondary">{detail}</p>
        <Link href={href} className="bouton bouton-primaire self-start !py-1 !text-sm">
          {action}
        </Link>
      </div>
    </li>
  )
}

export default async function HomePage() {
  const user = await getCurrentUser()
  const isOwner = user !== null

  let chapters: ChapterSummary[] = []
  try {
    const session = await getViewerSession()
    chapters = await listChapters(session.userId, session.workId)
  } catch {
    chapters = []
  }

  const p = pending(chapters)
  const derniers = [...chapters].sort((a, b) => b.number - a.number).slice(0, 6)
  const taches: React.ReactNode[] = []

  if (isOwner) {
    if (p.aRelire.length > 0) {
      taches.push(
        <Tache
          key="relire"
          titre="à relire"
          compte={p.aRelire.length}
          ton="or"
          href={`/chapitres/${p.aRelire[0]!.id}`}
          action={`Ouvrir le ${p.aRelire[0]!.number}`}
          detail="Le traitement a produit des propositions. Rien n'entre dans le graphe avant votre décision."
        />,
      )
    }
    if (p.enEchec.length > 0) {
      taches.push(
        <Tache
          key="echec"
          titre="en échec"
          compte={p.enEchec.length}
          ton="rouge"
          href={`/chapitres/${p.enEchec[0]!.id}`}
          action="Voir la raison"
          detail="Le traitement s'est arrêté. Les étapes réussies sont conservées : relancer reprend où ça s'est arrêté."
        />,
      )
    }
    if (p.enCours.length > 0) {
      taches.push(
        <Tache
          key="cours"
          titre="en cours"
          compte={p.enCours.length}
          ton="mer"
          href={`/chapitres/${p.enCours[0]!.id}`}
          action="Suivre"
          detail="Le traitement est en cours. La progression montre chaque étape, sa durée et son coût réel."
        />,
      )
    }
    if (p.aTraiter.length > 0) {
      taches.push(
        <Tache
          key="traiter"
          titre="à traiter"
          compte={p.aTraiter.length}
          ton="mer"
          href={`/chapitres/${p.aTraiter[0]!.id}`}
          action="Lancer"
          detail="Importés, pas encore analysés. Le coût est estimé avant lancement, pas après."
        />,
      )
    }
  }

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-6">
      {isOwner && (
        <section>
          <h1 className="sr-only">Poste de commandement</h1>
          {taches.length > 0 ? (
            <>
              <h2 className="font-display text-xl uppercase text-primary">Ça vous attend</h2>
              <ul className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{taches}</ul>
            </>
          ) : (
            <div
              className="border-[4px] border-ink bg-[var(--epi-validated)] px-4 py-3 text-white"
              style={{ boxShadow: 'var(--shadow-hard)' }}
            >
              <p className="font-display text-2xl uppercase leading-none">Rien en attente</p>
              <p className="mt-1.5 text-sm text-white/90">
                {chapters.length === 0
                  ? 'La bibliothèque est vide. Importez le premier chapitre que vous avez lu.'
                  : 'Tout est traité, relu et publié. Le chapitre suivant vous attend.'}
              </p>
              <Link href="/import" className="bouton mt-3 !py-1 !text-sm">
                Importer un chapitre
              </Link>
            </div>
          )}
        </section>
      )}

      {/* The library, in four numbers. */}
      <section className={isOwner ? 'mt-8' : ''}>
        <h2 className="font-display text-xl uppercase text-primary">La bibliothèque</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Chapitres', chapters.length],
            ['Publiés', p.publies.length],
            ['Passages', chapters.reduce((s, c) => s + c.passageCount + c.pageCount, 0)],
            ['Dernier', chapters.length > 0 ? Math.max(...chapters.map((c) => c.number)) : 0],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="border-[3px] border-ink bg-surface-raised px-3 py-2"
              style={{ boxShadow: 'var(--shadow-hard-sm)' }}
            >
              <p className="cartouche">{label}</p>
              <p className="chiffre chiffre-l mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </section>

      {derniers.length > 0 && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-xl uppercase text-primary">Derniers chapitres</h2>
            <Link
              href="/chapitres"
              className="font-display text-sm uppercase text-accent-strong hover:underline"
            >
              Tous →
            </Link>
          </div>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {derniers.map((chapter) => (
              <li key={chapter.id} className="panneau flex items-stretch">
                <Link
                  href={`/chapitres/${chapter.id}`}
                  className="flex w-20 shrink-0 items-center justify-center border-r-[3px] border-ink bg-[var(--sea-deep)] text-white no-underline"
                >
                  <span className="chiffre text-3xl">{chapter.number}</span>
                </Link>
                <div className="min-w-0 flex-1 px-3 py-2">
                  <p className="truncate font-display text-base uppercase text-primary">
                    {chapter.title ?? `Chapitre ${chapter.number}`}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <StatusBadge status={chapter.status} />
                    <span className="tabular text-xs text-muted">
                      {chapter.sourceKind === 'summary'
                        ? `${chapter.passageCount} passages`
                        : `${chapter.pageCount} p.`}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isOwner && (
        <section className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            ['Le graphe', '/graph', 'Tout le réseau : personnages, équipages, îles, fruits, promesses.'],
            ['La chronologie', '/chronologie', "Dates exactes, ordres relatifs, flashbacks, et l'incertitude assumée."],
            ['Les mystères', '/mysteres', 'Ce qui est ouvert, ce qui a été résolu, et au bout de combien de chapitres.'],
          ].map(([label, href, detail]) => (
            <Link key={href} href={href!} className="panneau no-underline">
              <p className="panneau-titre panneau-titre-vedette">{label}</p>
              <p className="panneau-corps text-sm text-secondary">{detail}</p>
            </Link>
          ))}
        </section>
      )}
    </main>
  )
}
