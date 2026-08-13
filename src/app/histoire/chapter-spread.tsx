import Link from 'next/link'
import { Portrait } from '@/app/components/portrait.tsx'
import {
  nodeTypeLabel,
  predicateLabel,
} from '@/domains/knowledge/predicate-label.ts'
import type { StoryChapter } from '@/domains/temporal/story.ts'

/**
 * One chapter, staged.
 *
 * No `'use client'`, deliberately: the first window is rendered on the server
 * with the page, and every window after it is rendered by the scroller in the
 * browser. Both use this file, so a chapter loaded by scrolling is the same
 * markup as a chapter loaded by opening the page — which is the only way an
 * infinite scroll stays honest under a deep link.
 *
 * The types it imports come from a `server-only` module and are erased at
 * build; nothing in here reaches for a database.
 *
 * The order of the beats is the order a chapter is read, not the order the
 * schema stores them:
 *
 *   the number      — where you are, unmissable
 *   the line        — one sentence quoted from the source
 *   what happens    — the events, which is the story
 *   a name          — what someone turns out to be called
 *   who walks on    — faces
 *   what falls      — the beliefs this chapter kills
 *   what opens      — the questions it leaves you with
 *
 * Refutations sit late on purpose. « Ce que vous croyiez » only means anything
 * once the reader has been told what happened.
 */

export function ChapterSpread({ chapter }: { chapter: StoryChapter }) {
  if (chapter.isSilent) return <SilentChapter chapter={chapter} />

  const headingId = `ch-${chapter.number}-titre`

  return (
    <section
      id={`ch-${chapter.number}`}
      aria-labelledby={headingId}
      className="histoire-chapitre"
    >
      <TitleCard chapter={chapter} headingId={headingId} />

      <div className="histoire-corps">
        {chapter.quote && (
          <blockquote className="histoire-citation" data-beat>
            <p>{chapter.quote.excerpt}</p>
            <footer className="cartouche mt-3">
              Cité du chapitre {chapter.number}, dans la langue de la source
            </footer>
          </blockquote>
        )}

        {chapter.events.length > 0 && (
          <Beat titre="Ce qui arrive">
            <ol className="space-y-4">
              {chapter.events.map((event) => (
                <li key={event.entityId} className="histoire-evenement">
                  <h3 className="text-xl text-primary">{event.label}</h3>
                  {event.summary && (
                    <p className="mt-1 text-secondary">{event.summary}</p>
                  )}
                  <p className="mt-1.5 flex flex-wrap items-center gap-2">
                    {event.isFlashback && (
                      <span className="badge badge-gris">Souvenir</span>
                    )}
                    {event.storyTime && event.storyTime.kind !== 'unknown' && (
                      <span className="cartouche">
                        {event.storyTime.description}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          </Beat>
        )}

        {chapter.reveals.length > 0 && (
          <Beat titre={chapter.reveals.length > 1 ? 'Des noms' : 'Un nom'}>
            <ul className="space-y-3">
              {chapter.reveals.map((reveal) => (
                <li
                  key={`${reveal.entityId}-${reveal.label}`}
                  className="histoire-revelation"
                >
                  {reveal.previous && reveal.previous !== reveal.label ? (
                    <p className="text-lg leading-snug">
                      <span className="histoire-ancien-nom">
                        {reveal.previous}
                      </span>
                      <span aria-hidden="true" className="histoire-fleche">
                        →
                      </span>
                      <Link
                        href={`/entite/${reveal.entityId}?ch=${chapter.number}`}
                        className="histoire-nouveau-nom"
                      >
                        {reveal.label}
                      </Link>
                    </p>
                  ) : (
                    <p className="text-lg leading-snug">
                      <Link
                        href={`/entite/${reveal.entityId}?ch=${chapter.number}`}
                        className="histoire-nouveau-nom"
                      >
                        {reveal.label}
                      </Link>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Beat>
        )}

        {chapter.cast.length > 0 && (
          <Beat titre="Entrent en scène">
            <ul className="histoire-distribution">
              {chapter.cast.map((member) => {
                const portrait = chapter.portraits[member.entityId] ?? null
                return (
                  <li key={member.entityId}>
                    <Link
                      href={`/entite/${member.entityId}?ch=${chapter.number}`}
                      className="histoire-figurant"
                    >
                      {portrait ? (
                        <Portrait
                          image={portrait}
                          label={member.label ?? 'entité sans nom révélé'}
                        />
                      ) : (
                        <span className="histoire-sans-visage" aria-hidden="true" />
                      )}
                      <span className="histoire-figurant-nom">
                        {member.label ?? 'entité sans nom révélé'}
                      </span>
                      <span className="cartouche">
                        {nodeTypeLabel(member.nodeType)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </Beat>
        )}

        {chapter.refutations.length > 0 && (
          <Beat titre="Ce que ce chapitre dément" ton="rouge">
            <ul className="space-y-2">
              {chapter.refutations.map((fact) => (
                <li key={fact.assertionId} className="histoire-dementi">
                  <span className="histoire-raye">
                    {fact.subjectLabel ?? 'entité sans nom'}{' '}
                    {predicateLabel(fact.predicate)}
                    {fact.objectLabel ? ` ${fact.objectLabel}` : ''}
                  </span>
                  <span className="cartouche ml-2">
                    cru depuis le chapitre {fact.heldSince}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-secondary">
              Rien n&apos;est effacé. Ces croyances restent vraies dans les
              chapitres où vous les teniez pour vraies.
            </p>
          </Beat>
        )}

        {chapter.mysteriesOpened.length > 0 && (
          <Beat titre="Ce qui reste sans réponse">
            <ul className="histoire-mysteres">
              {chapter.mysteriesOpened.map((mystery) => (
                <li key={mystery.entityId}>
                  <Link
                    href={`/entite/${mystery.entityId}?ch=${chapter.number}`}
                    className="histoire-sceau"
                  >
                    {mystery.question}
                  </Link>
                </li>
              ))}
            </ul>
          </Beat>
        )}

        {chapter.mysteriesResolved.length > 0 && (
          <Beat titre="Ce qui trouve sa réponse" ton="vert">
            <ul className="histoire-mysteres">
              {chapter.mysteriesResolved.map((mystery) => (
                <li key={mystery.entityId}>
                  <Link
                    href={`/entite/${mystery.entityId}?ch=${chapter.number}`}
                    className="histoire-sceau histoire-sceau-ouvert"
                  >
                    {mystery.question}
                  </Link>
                </li>
              ))}
            </ul>
          </Beat>
        )}

        <footer className="histoire-pied">
          <span className="cartouche">
            {chapter.factCount === 0
              ? 'aucun fait ajouté'
              : `${chapter.factCount} fait${chapter.factCount > 1 ? 's' : ''} ajouté${chapter.factCount > 1 ? 's' : ''} au graphe`}
          </span>
          <span className="histoire-pied-liens">
            <Link href={`/graph?ch=${chapter.number}`}>Le graphe ici</Link>
            <Link href={`/delta/${chapter.number}`}>Le détail</Link>
          </span>
        </footer>
      </div>
    </section>
  )
}

function TitleCard({
  chapter,
  headingId,
}: {
  chapter: StoryChapter
  headingId: string
}) {
  return (
    <header className="histoire-carte-titre rayons">
      <p className="cartouche histoire-volume">
        {chapter.volume ? `Tome ${chapter.volume}` : 'Chapitre'}
      </p>
      <p className="chiffre histoire-numero" aria-hidden="true">
        {chapter.number}
      </p>
      <h2 id={headingId} className="histoire-titre">
        <span className="sr-only">Chapitre {chapter.number}. </span>
        {chapter.title ?? `Chapitre ${chapter.number}`}
      </h2>
    </header>
  )
}

/**
 * A chapter that added nothing.
 *
 * Not an empty spread with headings and no content — a line, and the reader
 * scrolls past it in a second. Some chapters are transitions, and a story mode
 * that gives them the same weight as the chapter where a name lands is a story
 * mode that has not read the story.
 */
function SilentChapter({ chapter }: { chapter: StoryChapter }) {
  return (
    <section
      id={`ch-${chapter.number}`}
      className="histoire-chapitre histoire-chapitre-muet"
      aria-label={`Chapitre ${chapter.number}, rien de publié`}
    >
      <p className="histoire-muet-ligne">
        <span className="chiffre histoire-muet-numero">{chapter.number}</span>
        <span className="text-secondary">
          {chapter.title ?? 'Rien n’a encore été publié pour ce chapitre.'}
        </span>
        <Link href={`/chapitres`} className="cartouche histoire-muet-lien">
          l’ouvrir
        </Link>
      </p>
    </section>
  )
}

function Beat({
  titre,
  ton,
  children,
}: {
  titre: string
  ton?: 'rouge' | 'vert'
  children: React.ReactNode
}) {
  return (
    <div className="histoire-temps" data-beat data-ton={ton}>
      <h3 className="histoire-temps-titre">{titre}</h3>
      {children}
    </div>
  )
}
