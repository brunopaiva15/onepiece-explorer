import Link from 'next/link'
import { Portrait } from '@/app/components/portrait.tsx'
import { arcOf } from '@/domains/temporal/arcs.ts'
import type { StoryBeat, StoryPart } from '@/domains/temporal/story.ts'
import { MOT } from './shots.ts'

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

/*
 * The verb in front of the line lives in `shots.ts`, with the rest of the
 * per-kind wording: animation mode plays these same beads and has to call them
 * the same things, and one table in two files drifts the first time either is
 * reworded.
 */

/** Beads whose second line is a moment, not a sentence. */
const EVENT_KINDS = new Set<StoryBeat['kind']>(['evenement', 'souvenir'])

export function Beat({ beat }: { beat: StoryBeat }) {
  if (beat.kind === 'chapitre') {
    /*
     * Which arc this is, above the number.
     *
     * On every notch rather than only where the arc turns over. The thread is
     * one page of a thousand chapters and the reader arrives in the middle of
     * it — by the corner jump, by a link, by having scrolled for a while — so a
     * signpost planted only at chapter 155 answers « where am I » for exactly
     * one of the sixty-three chapters of Alabasta. Repeated, it is a running
     * head: small, muted, above the number, read when looked for and otherwise
     * not noticed.
     */
    const arc = arcOf(beat.chapter)

    return (
      <li className="encoche" id={`ch-${beat.chapter}`}>
        {arc && <span className="cartouche encoche-arc">{arc.name}</span>}
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

  /*
   * An event carries its moment on the small label rather than under the
   * sentence: « souvenir · environ dix ans plus tôt ». It is what kind of beat
   * this is, not a second thing it says.
   */
  const moment = EVENT_KINDS.has(beat.kind) ? beat.detail : null

  return (
    <li className="perle" data-perle data-genre={beat.kind}>
      <p className="perle-mot">
        {MOT[beat.kind]}
        {moment && <span className="perle-moment"> · {moment}</span>}
      </p>

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
                <Ligne parts={beat.textParts} fallback={beat.text} />
              </Link>
            ) : (
              <span
                className={beat.kind === 'dementi' ? 'perle-raye' : undefined}
              >
                <Ligne parts={beat.textParts} fallback={beat.text} />
              </span>
            )}
          </p>

          {beat.kind !== 'nom' && !moment && beat.detail && (
            <p className="perle-detail">
              <Ligne parts={beat.detailParts} fallback={beat.detail} />
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * A line, with a face beside every name that has one.
 *
 * The faces are images rather than links on purpose: the whole line is already
 * a link to what the bead is about, and an anchor inside an anchor is not
 * markup a browser will keep. The picture is next to the name it belongs to,
 * which is what makes it checkable without a caption.
 */
function Ligne({
  parts,
  fallback,
}: {
  parts: StoryPart[] | null
  fallback: string
}) {
  if (!parts) return <>{fallback}</>

  return (
    <>
      {parts.map((part, index) =>
        part.portrait ? (
          <span key={index} className="mention">
            {part.text}
            <Portrait image={part.portrait} label={part.text} size="inline" />
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}
