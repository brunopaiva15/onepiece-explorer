import type { Metadata } from 'next'
import Link from 'next/link'
import { getViewerSession } from '@/domains/auth/session.ts'
import {
  getChronology,
  type ChronologyEvent,
  type Placement,
} from '@/domains/temporal/chronology.ts'

export const metadata: Metadata = { title: 'Chronologie' }
export const dynamic = 'force-dynamic'

/**
 * When things happened, as opposed to when you were told.
 *
 * The page used to say « aucun événement n'a de position connue dans le temps de
 * l'histoire à ce chapitre », for every library and at every cursor position.
 * That was not a display fault and moving the cursor was never going to fix it:
 * it ordered by `events.story_time`, and nothing in the pipeline had ever
 * written that column — no field asked the model for a date, so it was null for
 * every event ever imported. The page was reporting, accurately, on a field that
 * did not exist in practice.
 *
 * Two changes bring it back. The extraction now asks *when*, and only accepts an
 * answer the chapter can be quoted for (`candidateStoryTimeSchema`). And this
 * page reads the library whole rather than at the cursor — the boundary is not
 * bypassed, it is asked at the ceiling, because a chronology of « what I knew at
 * chapter 40 » is a different and much less useful object than a chronology of
 * everything I have read.
 *
 * Nothing here comes from anywhere but your own imported chapters. What no
 * chapter of yours states is not on this page.
 */
export default async function ChronologiePage({
  searchParams,
}: {
  searchParams: Promise<{ ch?: string }>
}) {
  const { ch } = await searchParams
  const session = await getViewerSession(ch)
  const chronology = await getChronology(session.userId, session.maxChapter)

  const total =
    chronology.dated.length + chronology.earlier.length + chronology.present.length

  return (
    <main id="contenu" className="mx-auto max-w-4xl px-5 py-8">
      <h1 className="font-display text-4xl uppercase text-primary">Chronologie</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-secondary">
        L&apos;ordre où les choses se sont <strong>produites</strong>, et non
        l&apos;ordre où les chapitres les racontent. Un souvenir remonte donc
        ici, loin du chapitre qui le montre. Pour l&apos;autre axe, chapitre par
        chapitre et dans l&apos;ordre de lecture, c&apos;est{' '}
        <Link href="/histoire" className="text-accent underline underline-offset-2">
          l&apos;histoire
        </Link>
        .
      </p>

      <Scope ceiling={chronology.ceiling} boundary={session.boundaryChapter} />

      {total === 0 ? (
        <Empty ceiling={chronology.ceiling} />
      ) : (
        <>
          <Section
            title="Avant, et de combien"
            events={chronology.dated}
            note="Ce que vos chapitres datent explicitement. La distance est celle qu'ils donnent : elle n'est ni calculée, ni convertie, et la phrase qui la dit est citable."
            empty="Aucun de vos chapitres ne donne encore de distance en années. Ceux qui en donnent une la placeront ici ; voyez la note en bas de page."
          />
          <Section
            title="Avant, sans que rien dise de combien"
            events={chronology.earlier}
            note="Des souvenirs : le chapitre les présente comme du passé sans chiffrer lequel. Ils sont donc avant le présent du récit, dans l'ordre où on vous les a racontés. C'est tout ce que les pages permettent d'affirmer."
            empty="Aucun souvenir parmi ce que vous avez importé."
          />
          <Section
            title="Le présent du récit"
            events={chronology.present}
            note="Ce qui arrive au fil de la lecture, dans l'ordre des chapitres."
            empty="Rien."
          />
        </>
      )}

      <p className="mt-14 border-t-[3px] border-ink pt-4 text-xs leading-relaxed text-muted">
        Tout ce qui est sur cette page vient de vos chapitres importés, et rien
        d&apos;autre. Une date n&apos;y apparaît que si un chapitre l&apos;énonce
        et que la phrase qui l&apos;énonce a été retrouvée dans le texte.
        L&apos;âge d&apos;un personnage connu par ailleurs n&apos;est pas une
        source. Les chapitres publiés avant que l&apos;extraction ne pose la
        question n&apos;ont pas de datation : les retraiter en ajoute.
      </p>
    </main>
  )
}

/**
 * What this page is showing, and why it is not what the slider says.
 *
 * The cursor is chrome on every screen, so a page that deliberately ignores it
 * has to say so where the reader is looking, not in a comment. It is only worth
 * a line when the two actually differ — someone reading at the end of their
 * library is not being told about an exception they are not experiencing.
 */
function Scope({ ceiling, boundary }: { ceiling: number; boundary: number }) {
  if (ceiling === 0) return null

  return (
    <p className="mt-4 border-l-[3px] border-accent bg-surface-raised px-3 py-2 text-sm text-secondary">
      Cet axe couvre <strong>toute votre bibliothèque</strong>, jusqu&apos;au
      chapitre {ceiling}.{' '}
      {boundary < ceiling && (
        <>
          Le curseur est sur {boundary} et ne s&apos;applique pas ici :
          l&apos;ordre du temps de l&apos;histoire n&apos;a aucun sens tronqué,
          puisque c&apos;est presque toujours un chapitre tardif qui situe une
          scène ancienne.
        </>
      )}
    </p>
  )
}

function Empty({ ceiling }: { ceiling: number }) {
  return (
    <div className="mt-8 border-[3px] border-ink bg-surface-raised p-5">
      <p className="text-secondary">
        {ceiling === 0
          ? "Aucun chapitre publié : la chronologie se remplit en même temps que la bibliothèque."
          : `Aucun événement dans les ${ceiling} chapitres publiés. Le pipeline en propose à partir de ce que les chapitres racontent ; il n'y en a pas encore dans ce que vous avez publié.`}
      </p>
    </div>
  )
}

function Section({
  title,
  events,
  note,
  empty,
}: {
  title: string
  events: ChronologyEvent[]
  note: string
  empty: string
}) {
  return (
    <section className="mt-10">
      <h2 className="panneau-titre border-[3px] border-ink">
        <span>{title}</span>
        <span className="shrink-0 text-sm normal-case tracking-normal">
          {events.length}
        </span>
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-secondary">{note}</p>

      {events.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ol className="mt-4 ml-3 border-l-[3px] border-ink pl-6">
          {events.map((event) => (
            <li key={event.entityId} className="relative pt-6">
              <span
                aria-hidden="true"
                className="absolute -left-[calc(1.5rem+0.5rem+1.5px)] top-[1.75rem] h-3.5 w-3.5 border-[3px] border-ink bg-accent"
              />
              <Event event={event} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Event({ event }: { event: ChronologyEvent }) {
  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <When placement={event.placement} />
        {event.isFlashback && (
          <span
            className="badge badge-gris"
            title="Le chapitre le présente comme un souvenir ou un récit"
          >
            souvenir
          </span>
        )}
        {/*
         * The chapter is shown and is not a link.
         *
         * It is the whole of what makes a flashback legible — « raconté au
         * chapitre 5 » beside a scene placed ten years earlier is the definition
         * of one. But every other page of this site takes `?ch=`, and this one
         * deliberately does not stop at the cursor: a link from here would be a
         * one-click way to move the boundary somewhere the reader never asked to
         * go.
         */}
        <span className="ml-auto shrink-0 font-mono text-xs text-muted">
          raconté au ch. {event.chapter}
        </span>
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-primary">
        <Link
          href={`/entite/${event.entityId}?ch=${event.chapter}`}
          className="hover:underline"
        >
          {event.summary ?? event.label}
        </Link>
      </p>
    </article>
  )
}

/**
 * The coordinate, in the words the chapter used.
 *
 * « Environ vingt ans plus tôt » stays « environ vingt ans plus tôt ». Turning
 * it into a year would need a calendar the chapters do not contain, and reading
 * one in from outside is exactly what this library refuses to do.
 */
function When({ placement }: { placement: Placement }) {
  if (placement.kind === 'dated') {
    return (
      <>
        <span className="chiffre chiffre-l text-primary">
          −{placement.yearsAgo}
        </span>
        <span className="cartouche">{placement.description}</span>
      </>
    )
  }

  if (placement.kind === 'earlier') {
    return (
      <span className="cartouche">
        {placement.description ?? 'plus tôt, sans distance connue'}
      </span>
    )
  }

  return <span className="cartouche">présent du récit</span>
}
