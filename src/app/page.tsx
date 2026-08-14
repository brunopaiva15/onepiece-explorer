import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import { listChapters, type ChapterSummary } from '@/domains/chapters/queries.ts'
import {
  displayImages,
  postersFor,
  type DisplayImage,
  type PosterView,
} from '@/domains/images/index.ts'
import { ARCS, arcOf, type Arc } from '@/domains/temporal/arcs.ts'
import {
  castAtChapter,
  openQuestionsAtChapter,
  type CastMember,
  type OpenQuestion,
} from '@/domains/temporal/spotlight.ts'

export const dynamic = 'force-dynamic'

/**
 * The public front door.
 *
 * There was not one. `/` was the workshop's command deck with a four-card
 * consolation prize bolted underneath for anyone not signed in. The workshop
 * moved to `/admin`, and a page that says what this thing is took its place.
 *
 * That page was right and it was inert: six links, three counters and two
 * paragraphs about a knowledge graph, on the one screen that has to make
 * somebody want to click. Nothing of the story was on it. So the claim is
 * still first, because it is the whole product and it is not the wiki you
 * already have open in another tab: every page here is read *at a chapter*,
 * and someone on chapter 300 explores a graph built from a thousand while
 * being told only what a reader of 300 knows.
 *
 * What is new is that the page now proves it instead of promising it. The
 * faces on the wall are drawn from the reader's own boundary, the names on
 * them are the names that boundary allows, the route stops at the arc they are
 * in, and the open questions are open because *they* have not read the answer.
 * Every ornament on this page is a load-bearing demonstration of the one rule.
 *
 * Everything is read through `getViewerSession()`, which resolves the published
 * library for an anonymous visitor. Nothing here requires an account, and
 * nothing here can write.
 */

/** How many faces the wall holds. One row of six on a wide screen. */
const MUR = 6

/**
 * Portraits signed per render.
 *
 * Higher than the wall on purpose: the cap falls on entities that *have* a
 * picture, and a merged character can hold two. Asking for exactly six would
 * hand back five posters whenever one of them did.
 */
const PORTRAITS = 10

/** Ports named on the route before it folds into a count. */
const ESCALES = 8

/**
 * Drawn fresh on every visit, and deliberately not seeded.
 *
 * A stable draw would make the page identical for a week, which defeats the
 * point of having one. The pool it draws from is ranked by how connected the
 * characters are, so the wall varies without ever falling through to six
 * names mentioned once each.
 */
function tirage<T>(items: readonly T[]): T[] {
  const drawn = [...items]
  for (let i = drawn.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!]
  }
  return drawn
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string }>
}) {
  const { ch } = await searchParams
  let published: ChapterSummary[] = []
  let boundary = 0
  let wall: Array<{
    member: CastMember
    portrait: DisplayImage | null
    poster: PosterView | null
  }> = []
  let questions: OpenQuestion[] = []

  /*
   * Degrades rather than throws. A visitor arriving at a deployment whose
   * database is unreachable should read what the site is, not a stack trace.
   * The pages that need data say so themselves, and so does this one: no cast
   * means no wall, not a broken home page.
   */
  try {
    const session = await getViewerSession(ch)
    boundary = session.boundaryChapter
    const chapters = await listChapters(session.userId, session.workId)
    /*
     * Bounded like every other page, and for the same reason.
     *
     * A chapter title is a spoiler: « La mort de X » is the whole event, so the
     * list stops where the reader stopped. The home page is the one screen
     * where it would be easy to forget that and show « les derniers chapitres »
     * of a library a thousand chapters ahead of the person reading.
     */
    published = chapters
      .filter((chapter) => chapter.status === 'published' && chapter.number <= boundary)
      .sort((a, b) => b.number - a.number)

    const [cast, open] = await Promise.all([
      castAtChapter(session.userId, boundary, { nodeTypes: ['character'] }),
      openQuestionsAtChapter(session.userId, boundary),
    ])

    /*
     * Drawn first, illustrated second.
     *
     * The order matters: `displayImages` signs the first entities in the list
     * that have a picture, so shuffling before signing is what makes the wall
     * a draw rather than a ranking with a shuffled layout.
     */
    const drawn = tirage(cast)
    const images = await displayImages(
      session.userId,
      boundary,
      drawn.flatMap((member) => member.memberIds),
      PORTRAITS,
    )

    const faceOf = (member: CastMember): DisplayImage | null => {
      for (const id of member.memberIds) {
        const found = images.get(id)
        if (found) return found
      }
      return null
    }

    /*
     * Faces first, then anyone. A library whose catalogue matched nobody still
     * gets a wall, drawn as initials, rather than an empty section that reads
     * as a page half-built.
     */
    const illustrated = drawn.filter((member) => faceOf(member) !== null)
    const rest = drawn.filter((member) => faceOf(member) === null)
    const chosen = [...illustrated, ...rest].slice(0, MUR)

    /*
     * The real poster, when the reader has read the chapter that prints it.
     *
     * Asked only for the six on the wall, because each one is a signed URL and
     * the other fifty-four would be minted to be thrown away. The bounty comes
     * back with it, dated the same way, so the number under the picture is the
     * one the reader has seen and not the one it became.
     */
    const posters = await postersFor(
      session.userId,
      boundary,
      chosen.flatMap((member) => member.memberIds),
      new Map(chosen.flatMap((member) => member.memberIds.map((id) => [id, member.label]))),
    )

    wall = chosen.map((member) => ({
      member,
      portrait: faceOf(member),
      poster: member.memberIds.map((id) => posters.get(id)).find((found) => found) ?? null,
    }))

    questions = tirage(open).slice(0, 3)
  } catch {
    published = []
  }

  const derniers = published.slice(0, MUR)
  const arc = arcOf(boundary)
  const route = ARCS.filter((port) => port.from <= boundary)
  /*
   * Every catalogue that put a picture on this wall, named.
   *
   * Both kinds, because both are on screen: the posters come from the wiki and
   * the portraits from the community APIs, and crediting only the ones the
   * first version happened to load would credit the wrong site on a wall made
   * of wanted posters.
   */
  const sources = [
    ...new Set(
      wall
        .flatMap((poster) => [poster.poster?.attribution, poster.portrait?.attribution])
        .filter((name): name is string => name !== undefined),
    ),
  ]
  const hasPoster = wall.some((poster) => poster.poster !== null)

  return (
    <main id="contenu" className="mx-auto max-w-6xl px-5 py-8 sm:py-10">
      {/*
       * What this is, in one claim.
       *
       * It said the same thing three times: a paragraph on the graph, a
       * paragraph on the slider, and a paragraph on what the slider does to
       * each page. All true, all correct, and a wall of prose is not an
       * invitation. The rest of the page demonstrates every sentence that used
       * to be here, which is why they could go.
       */}
      <section className="banniere">
        <div className="px-6 pt-10 pb-4 sm:px-12 sm:pt-14 sm:pb-6">
          <p className="font-display text-[0.72rem] uppercase tracking-[0.2em] text-[var(--accent)]">
            {arc ? `Journal de bord · chapitre ${boundary} · ${arc.name}` : 'Journal de bord'}
          </p>
          <h1 className="mt-3 font-display text-5xl uppercase leading-none sm:text-7xl">
            One Piece Explorer
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/90 sm:text-xl">
            Tout One Piece, arrêté au chapitre où vous en êtes.{' '}
            <strong>Rien de ce qui vient après.</strong>
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/histoire" className="bouton bouton-primaire">
              Commencer par l&apos;histoire
            </Link>
            <Link href="/graph" className="bouton">
              Ouvrir le graphe
            </Link>
          </div>
        </div>
        <Vague />
      </section>

      {/* --- The wall ------------------------------------------------------ */}
      {wall.length > 0 && (
        <section className="mt-14">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
            <h2 className="font-display text-2xl uppercase text-primary">
              Avis de recherche
            </h2>
            <p className="text-sm text-secondary">
              Tirés au sort. Rechargez : l&apos;équipage change.
            </p>
          </div>

          <ul className="mur mt-5">
            {wall.map(({ member, portrait, poster }) => (
              <li key={member.entityId}>
                <Link
                  href={`/entite/${member.entityId}?ch=${boundary}`}
                  className={`affiche ${poster ? 'affiche-vraie' : ''}`}
                >
                  {/*
                   * The real poster wins, when the reader has read the chapter
                   * that prints it.
                   *
                   * `object-fit: contain` rather than the portrait's crop: a
                   * wanted poster is a document, and cropping one is throwing
                   * away the half that says what it is.
                   */}
                  {poster ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={poster.url}
                      alt={`Avis de recherche de ${member.label}`}
                      loading="lazy"
                      className="affiche-vue affiche-vue-entiere"
                    />
                  ) : (
                    /*
                     * No poster the reader has reached, so the site prints one.
                     *
                     * The wall promised avis de recherche and handed back six
                     * portrait crops, because the gallery holds fourteen
                     * printings and none of them is visible before chapter 398.
                     * That is most readers, most of the time, and « we have no
                     * picture of the paper » is a poor reason to stop drawing
                     * the paper: the heading, the rules and the plate are this
                     * site's own, printed around whatever illustration the
                     * catalogues had.
                     *
                     * What the frame never carries is a figure. A bounty is a
                     * fact with a chapter attached, and it goes on a card only
                     * when it comes off a poster the reader has read.
                     */
                    <span className="affiche-papier">
                      <span className="affiche-entete">Avis de recherche</span>
                      {portrait ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={portrait.thumbUrl}
                          alt={`Illustration de ${member.label}`}
                          loading="lazy"
                          className="affiche-vue"
                        />
                      ) : (
                        <span className="affiche-vide" aria-hidden="true">
                          <span className="chiffre text-4xl">
                            {member.label.slice(0, 1).toUpperCase()}
                          </span>
                        </span>
                      )}
                    </span>
                  )}
                  <span className="affiche-corps">
                    <span className="affiche-nom">{member.label}</span>
                  </span>
                  {/*
                   * The band a bounty is printed on, and what may go on it.
                   *
                   * A figure when there is a real one, dated like everything
                   * else: the printing this reader has read, from a manifest
                   * somebody maintains by hand. Otherwise the chapter they met
                   * them in, which is also a fact. What never goes here is an
                   * invented berry amount — on a page whose whole claim is that
                   * its numbers come from chapters, that would be the one lie.
                   */}
                  <span className="affiche-prime">
                    {poster ? (
                      <>
                        <span className="affiche-prime-mot">Mort ou vif</span>
                        <span className="chiffre affiche-prime-somme">{poster.berries}</span>
                      </>
                    ) : (
                      <>
                        <span className="affiche-prime-mot">Vu au chapitre</span>
                        <span className="chiffre text-2xl">{member.firstSeenChapter}</span>
                      </>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {/*
           * Where the faces come from, next to the faces.
           *
           * These pictures are matched to an entity by name, which is a guess,
           * and a face shown without saying so reads as something the pipeline
           * established from the pages. It did not. The rule is the same one
           * `Portrait` states, applied to a place that does not have room for a
           * caption under every picture: one line under the wall, naming the
           * catalogues and what a match is worth.
           */}
          {sources.length > 0 && (
            <p className="mt-4 text-xs text-muted">
              Illustrations : {sources.join(', ')}. Ce n&apos;est pas une preuve
              tirée de vos pages.
              {hasPoster
                ? " Les primes sont celles qu'affiche l'avis de recherche, daté du chapitre qui le montre."
                : ' Les portraits sont rapprochés de chaque personnage par le nom.'}
            </p>
          )}
        </section>
      )}

      {/* --- The route sailed so far -------------------------------------- */}
      {published.length > 0 && (
        <section className="mt-14">
          <h2 className="font-display text-2xl uppercase text-primary">
            Votre traversée
          </h2>

          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                ['Vous en êtes au', boundary],
                ['Chapitres lisibles', published.length],
                ['Escales franchies', route.length],
                [
                  'Unités citables',
                  published.reduce((sum, c) => sum + c.passageCount + c.pageCount, 0),
                ],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="border-[3px] border-ink bg-surface-raised px-4 py-3"
                style={{ boxShadow: 'var(--shadow-hard-sm)' }}
              >
                <p className="cartouche">{label}</p>
                <p className="chiffre chiffre-l mt-1">{value}</p>
              </div>
            ))}
          </div>

          {/*
           * The arcs, and only the ones already opened.
           *
           * An arc name is not knowledge held behind the boundary (see
           * arcs.ts): it is the table of contents of a work published for
           * thirty years. What it must never do is name what comes next, so
           * this list is cut at the reader's chapter rather than greyed out
           * past it. « Elbaf » on the home page of someone in Alabasta would
           * be a spoiler served by the decoration.
           */}
          {route.length > 0 && <Route ports={route} arc={arc} />}
        </section>
      )}

      {/* --- Two columns: the questions, and the last chapters ------------- */}
      <div className="mt-14 grid gap-10 lg:grid-cols-2">
        {questions.length > 0 && (
          <section>
            <h2 className="font-display text-2xl uppercase text-primary">
              Sans réponse
            </h2>
            <ul className="mt-5 space-y-4">
              {questions.map((question) => (
                <li key={question.entityId} className="panneau">
                  <div className="panneau-corps">
                    <p className="text-primary">
                      <Link
                        href={`/entite/${question.entityId}?ch=${boundary}`}
                        className="hover:underline"
                      >
                        {question.question}
                      </Link>
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="badge badge-mer">Ouverte</span>
                      <span className="cartouche">
                        posée au chapitre {question.openedInChapter}
                      </span>
                      {boundary - question.openedInChapter > 0 && (
                        <span className="cartouche">
                          · sans réponse depuis {boundary - question.openedInChapter}{' '}
                          chapitre{boundary - question.openedInChapter > 1 ? 's' : ''}
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-4">
              <Link href="/mysteres" className="text-accent-strong hover:underline">
                Toutes les questions ouvertes →
              </Link>
            </p>
          </section>
        )}

        <section>
          <h2 className="font-display text-2xl uppercase text-primary">
            Derniers chapitres
          </h2>

          {published.length === 0 ? (
            <p className="mt-5 border-[3px] border-ink bg-surface-raised px-4 py-3 text-secondary">
              {boundary === 0
                ? "Rien à lire pour l'instant : le curseur est au chapitre 0, ou rien n'est encore publié."
                : `Aucun chapitre publié jusqu'au ${boundary}. Avancez le curseur pour lire plus loin.`}
            </p>
          ) : (
            <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
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
          )}
        </section>
      </div>

      {/*
       * The ways in.
       *
       * Six cards that each explained themselves in a sentence and a half,
       * under a rail that already lists the same six destinations with icons.
       * A door does not need a paragraph: the name and four words are the
       * whole of what a visitor reads before clicking anyway.
       */}
      <section className="mt-14">
        <h2 className="font-display text-2xl uppercase text-primary">Explorer</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Carte titre="L'histoire" href="/histoire" detail="Le fil, depuis le chapitre 1" />
          <Carte titre="Le graphe" href="/graph" detail="Tout le réseau, d'un coup d'œil" />
          <Carte titre="La chronologie" href="/chronologie" detail="Dans l'ordre où c'est arrivé" />
          <Carte titre="Les mystères" href="/mysteres" detail="Ouverts, refermés, et depuis quand" />
          <Carte titre="La recherche" href="/recherche" detail="Un nom, une phrase, un chemin" />
          <Carte titre="Les sources" href="/mentions-legales" detail="D'où vient tout ceci" />
        </div>
      </section>

      {/* --- The honest small print ---------------------------------------- */}
      <section className="mt-14 border-[3px] border-ink bg-surface-raised px-5 py-4">
        <h2 className="font-display text-base uppercase text-primary">
          Un projet de fan, et rien d&apos;autre
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-secondary">
          Contenu tiré du One Piece Wiki (Fandom), sous licence CC BY-SA 3.0.
          Aucune planche de manga n&apos;est publiée ici. Projet non officiel,
          sans lien avec Eiichiro Oda, Shueisha ou Toei Animation.{' '}
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
      <p className="px-4 py-3 text-sm text-secondary">{detail}</p>
    </Link>
  )
}

/**
 * The ports of call, ending where the reader is.
 *
 * Long libraries fold: a reader at chapter 1100 has crossed thirty arcs, and
 * thirty chips is a strip nobody reads to the end of. The ones kept are the
 * last ones, which is where the reader actually is, and the rest are counted
 * rather than dropped silently.
 */
function Route({ ports, arc }: { ports: readonly Arc[]; arc: Arc | null }) {
  const shown = ports.slice(-ESCALES)
  const folded = ports.length - shown.length

  return (
    <div className="traversee mt-4" aria-label="Les arcs que vous avez traversés">
      <div className="traversee-piste">
        {folded > 0 && (
          <span className="escale escale-avant">
            + {folded} escale{folded > 1 ? 's' : ''}
          </span>
        )}
        {shown.map((port) => (
          <span
            key={port.name}
            className={`escale ${port.name === arc?.name ? 'escale-ici' : ''}`}
          >
            {port.name}
            {port.name === arc?.name && (
              <span className="ml-1.5 text-[0.62rem] tracking-[0.14em]">vous êtes ici</span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * The sea, closing the banner.
 *
 * Two crests rather than one, the back one in ink at a low opacity, so the
 * edge reads as water drawn by hand instead of as a section divider. Inline
 * because it takes its colour from the page below it: the wave is the hole the
 * banner leaves, not a shape laid on top of it.
 */
function Vague() {
  return (
    <svg
      className="vague"
      viewBox="0 0 1200 40"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M0 22 Q 75 4 150 22 T 300 22 T 450 22 T 600 22 T 750 22 T 900 22 T 1050 22 T 1200 22 V40 H0 Z"
        fill="currentColor"
        opacity="0.35"
      />
      <path
        d="M0 30 Q 100 12 200 30 T 400 30 T 600 30 T 800 30 T 1000 30 T 1200 30 V40 H0 Z"
        fill="currentColor"
      />
    </svg>
  )
}
