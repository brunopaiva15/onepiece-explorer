import Link from 'next/link'
import { Portrait } from '@/app/components/portrait.tsx'
import type { StoryBeat } from '@/domains/temporal/story.ts'

/**
 * One bead on the thread.
 *
 * No `'use client'`, deliberately: the first stretch is rendered on the server
 * with the page, and every stretch after it is rendered by the scroller in the
 * browser. Both use this file, so a bead loaded by scrolling is the same markup
 * as one loaded by opening the page.
 *
 * The domain composed the line; this only decides what it looks like. That
 * split is why the file is short — every sentence in story mode is written in
 * one place, testable without a browser, and this is the shape it takes.
 */

/** The verb, in front of the line. Small, and the only per-kind wording here. */
const MOT: Record<StoryBeat['kind'], string> = {
  chapitre: '',
  citation: '',
  entree: 'entre en scène',
  evenement: 'il arrive',
  souvenir: 'souvenir',
  nom: 'un nom',
  dementi: 'on ne croit plus',
  reponse: 'réponse',
  question: 'question',
}

export function Beat({ beat }: { beat: StoryBeat }) {
  if (beat.kind === 'chapitre') {
    return (
      <li className="encoche" id={`ch-${beat.chapter}`}>
        <span className="chiffre encoche-numero">{beat.chapter}</span>
        {beat.text && <span className="encoche-titre">{beat.text}</span>}
      </li>
    )
  }

  if (beat.kind === 'citation') {
    return (
      <li className="perle perle-citation" data-perle>
        <figure>
          <blockquote>{beat.text}</blockquote>
          {/* Not decoration. Everything the graph writes is French; a citation
              is a copy verified character by character, so it keeps the
              language of the source — and an English line landing unannounced
              on a French page reads as a bug rather than as a quotation. */}
          <figcaption className="perle-source">
            Cité du chapitre {beat.chapter}, dans la langue de la source
          </figcaption>
        </figure>
      </li>
    )
  }

  const href = beat.entityId
    ? `/entite/${beat.entityId}?ch=${beat.chapter}`
    : null

  return (
    <li className="perle" data-perle data-genre={beat.kind}>
      <p className="perle-mot">{MOT[beat.kind]}</p>

      <div className="perle-corps">
        {beat.portrait && (
          <Portrait image={beat.portrait} label={beat.text} size="small" />
        )}

        {/* The two lines are one column beside the face, not two flex items
            next to it — otherwise a summary lands to the right of the name it
            belongs under. */}
        <div className="perle-texte">
          <p className="perle-ligne">
            {/* A name landing keeps what it replaced, struck through beside it
                — the point of the beat is the change, not the new label. */}
            {beat.kind === 'nom' && beat.detail && (
              <>
                <span className="perle-avant">{beat.detail}</span>
                <span aria-hidden="true"> → </span>
              </>
            )}

            {href ? (
              <Link href={href} className="perle-nom">
                {beat.text}
              </Link>
            ) : (
              <span
                className={beat.kind === 'dementi' ? 'perle-raye' : undefined}
              >
                {beat.text}
              </span>
            )}
          </p>

          {beat.kind !== 'nom' && beat.detail && (
            <p className="perle-detail">{beat.detail}</p>
          )}
        </div>
      </div>
    </li>
  )
}
