import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { listChapters, type ChapterSummary } from '@/domains/chapters/queries.ts'

export const dynamic = 'force-dynamic'

/**
 * The public front door.
 *
 * There was not one. `/` was the workshop's command deck with a four-card
 * consolation prize bolted underneath for anyone not signed in — a page that
 * opened on "Ça vous attend" for a visitor who has never been here and has
 * nothing waiting. The workshop moved to `/admin`, and this is what took its
 * place.
 *
 * It has one job, and it is not to list features: it is to say what this thing
 * is and why it is not the wiki you already have open in another tab. The
 * answer is the slider — every page is read *at a chapter*, so someone who is
 * on chapter 300 can explore a graph built from a thousand and be told only
 * what a reader of 300 knows. That claim is the whole product, so it is the
 * first thing on the page, not a footnote under the navigation.
 *
 * Everything here is read through `getViewerSession()`, which resolves the
 * published library for an anonymous visitor. Nothing on this page requires an
 * account, and nothing on it can write.
 */

function Carte({
  titre,
  href,
  detail,
}: {
  titre: string
  href: string
  detail: string
}) {
  return (
    <Link href={href} className="panneau no-underline">
      <p className="panneau-titre panneau-titre-vedette">{titre}</p>
      <p className="panneau-corps text-sm text-secondary">{detail}</p>
    </Link>
  )
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string }>
}) {
  const { ch } = await searchParams
  let published: ChapterSummary[] = []
  let boundary = 0

  /*
   * Degrades rather than throws. A visitor arriving at a deployment whose
   * database is unreachable should read what the site is, not a stack trace —
   * the pages that need data say so themselves.
   */
  try {
    const session = await getViewerSession(ch)
    boundary = session.boundaryChapter
    const chapters = await listChapters(session.userId, session.workId)
    /*
     * Bounded like every other page, and for the same reason.
     *
     * A chapter title is a spoiler — "La mort de X" is the whole event — so the
     * list stops where the reader stopped. The home page is the one screen where
     * it would be easy to forget that and show « les derniers chapitres » of a
     * library a thousand chapters ahead of the person reading.
     */
    published = chapters
      .filter((chapter) => chapter.status === 'published' && chapter.number <= boundary)
      .sort((a, b) => b.number - a.number)
  } catch {
    published = []
  }

  const derniers = published.slice(0, 6)

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-6">
      {/* --- What this is ------------------------------------------------ */}
      <section
        className="border-[4px] border-ink bg-[var(--sea-deep)] px-5 py-6 text-white sm:px-8 sm:py-8"
        style={{ boxShadow: 'var(--shadow-hard)' }}
      >
        <h1 className="font-display text-4xl uppercase leading-none sm:text-6xl">
          One Piece Explorer
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/90 sm:text-lg">
          Un graphe de connaissances de One Piece qui <strong>ne vous spoile pas</strong>.
          Chaque fait, chaque nom, chaque relation est daté du chapitre qui l&apos;a
          révélé. Dites où vous en êtes, et le site oublie tout le reste.
        </p>
        <p className="mt-3 max-w-2xl text-sm text-white/75">
          Le curseur en haut de l&apos;écran est le réglage : posez-le sur votre
          chapitre. Les personnages n&apos;y portent que les noms que vous leur
          connaissez, les mystères y sont ouverts tant que vous n&apos;avez pas lu
          leur résolution, et la chronologie s&apos;arrête où vous vous êtes arrêté.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/histoire" className="bouton bouton-primaire">
            Commencer par l&apos;histoire
          </Link>
          <Link href="/graph" className="bouton">
            Ouvrir le graphe
          </Link>
        </div>
      </section>

      {/* --- The ways in -------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="font-display text-xl uppercase text-primary">Explorer</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Carte
            titre="L'histoire"
            href="/histoire"
            detail="Depuis le chapitre 1, en défilant : ce qui arrive, qui entre en scène, ce qui tombe."
          />
          <Carte
            titre="Le graphe"
            href="/graph"
            detail="Tout le réseau : personnages, équipages, îles, fruits, promesses."
          />
          <Carte
            titre="La chronologie"
            href="/chronologie"
            detail="Deux axes jamais confondus : l'ordre où vous l'avez appris, et l'ordre où c'est arrivé."
          />
          <Carte
            titre="Les mystères"
            href="/mysteres"
            detail="Ce qui est ouvert, ce qui a été résolu, et au bout de combien de chapitres."
          />
          <Carte
            titre="La recherche"
            href="/recherche"
            detail="Un nom, une phrase, un lieu — ou le chemin le plus court entre deux personnages."
          />
          <Carte
            titre="Les sources"
            href="/mentions-legales"
            detail="D'où vient le contenu, sous quelle licence, et à qui appartiennent les images."
          />
        </div>
      </section>

      {/* --- The state of the library ------------------------------------- */}
      <section className="mt-8">
        <h2 className="font-display text-xl uppercase text-primary">La bibliothèque</h2>

        {published.length === 0 ? (
          <p className="mt-3 border-[3px] border-ink bg-surface-raised px-4 py-3 text-secondary">
            {boundary === 0
              ? "Rien à lire pour l'instant : le curseur est au chapitre 0, ou aucun chapitre n'a encore été publié. Le graphe se remplit chapitre après chapitre, et rien n'y entre avant d'avoir été relu."
              : `Aucun chapitre publié jusqu'au ${boundary}. Avancez le curseur en haut de l'écran pour lire plus loin.`}
          </p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                ['Chapitres lisibles', published.length],
                ['Vous en êtes au', boundary],
                [
                  'Unités citables',
                  published.reduce((sum, c) => sum + c.passageCount + c.pageCount, 0),
                ],
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

            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {derniers.map((chapter) => (
                <li key={chapter.id} className="panneau flex items-stretch">
                  <Link
                    href={`/delta/${chapter.number}`}
                    className="flex w-20 shrink-0 items-center justify-center border-r-[3px] border-ink bg-[var(--sea-deep)] text-white no-underline"
                  >
                    <span className="chiffre text-3xl">{chapter.number}</span>
                  </Link>
                  <div className="min-w-0 flex-1 px-3 py-2">
                    <p className="truncate font-display text-base uppercase text-primary">
                      {chapter.title ?? `Chapitre ${chapter.number}`}
                    </p>
                    <Link
                      href={`/delta/${chapter.number}`}
                      className="text-sm text-accent-strong hover:underline"
                    >
                      Ce qu&apos;il apporte →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* --- The honest small print ---------------------------------------- */}
      <section className="mt-8 border-[3px] border-ink bg-surface-raised px-4 py-3">
        <h2 className="font-display text-base uppercase text-primary">
          Un projet de fan, et rien d&apos;autre
        </h2>
        <p className="mt-1.5 text-sm text-secondary">
          Le contenu textuel s&apos;appuie sur le One Piece Wiki (Fandom), sous
          licence CC BY-SA 3.0. Aucune page de manga n&apos;est publiée ici : vous
          lisez des faits, des relations et des références de chapitre, jamais les
          planches. One Piece Explorer est un projet non officiel, sans lien avec
          Eiichiro Oda, Shueisha ou Toei Animation.{' '}
          <Link
            href="/mentions-legales"
            className="text-accent-strong underline underline-offset-2"
          >
            Sources et droits
          </Link>
          .
        </p>
      </section>
    </main>
  )
}
