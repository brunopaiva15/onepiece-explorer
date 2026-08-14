'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { planShots, progressOf, RATES, type Shot } from './shots.ts'
import type { DisplayImage } from '@/domains/images/index.ts'
import type { StoryBeat } from '@/domains/temporal/story.ts'

/**
 * The thread, played.
 *
 * Press play and the story runs on its own from where the thread starts to
 * where the reader stopped: a chapter card, then the beads of that chapter one
 * at a time, faces filling the screen and the line underneath, then the next
 * chapter. It is the same beads the page below is made of — same order, same
 * boundary, same wording — and it fetches through the same windowed loader, so
 * a film that has run to chapter 60 has pulled exactly what a reader who
 * scrolled to chapter 60 would have pulled.
 *
 * Three things it owes the reader, and each one is a rule here:
 *
 *  1. **It never plays past the boundary.** It cannot: it plays what the
 *     scroller loaded, and that is clamped in the database. There is no second
 *     path to the beads.
 *  2. **It can always be stopped.** Play, pause, step either way, speed, close
 *     — with the keyboard as well as with the mouse, and Escape at any moment.
 *     Motion that cannot be stopped is motion nobody can read.
 *  3. **A picture that will not load loses its frame, not its shot.** These
 *     addresses are signed and expire, and a film runs far longer than one
 *     signature lives: a face that fails asks for a fresh address and comes
 *     back, and one that cannot be recovered leaves the sentence standing on
 *     its own rather than a black rectangle standing in for it.
 *
 * The film carries no caption. On the thread each face sits beside the name it
 * was matched to, and a full-size portrait names its catalogue and that name;
 * here the pictures are the shot and a line of provenance under every one of
 * them was three seconds of small print between two sentences. The thread
 * below is where a reader checks a face, and `/entite` behind it.
 *
 * A `<dialog>` opened with `showModal()` rather than a div with a high
 * `z-index`: the browser puts it in the top layer, makes the rest of the page
 * inert — the corner chapter jump is behind it and must not be tabbable
 * through it — blocks the document from scrolling, and gives Escape for free.
 */

/**
 * How close to the end of what is loaded the film gets before asking for more.
 *
 * Eight shots is between fifteen and thirty seconds at normal speed, which is
 * comfortably longer than a window takes to come back — and short enough that
 * the signed URLs in it are still valid when the preloader gets to them. Those
 * expire in a minute by default, which is the reason the film does not simply
 * fetch the whole thread up front.
 */
const LOOKAHEAD = 8

/** Pan directions, cycled so two shots in a row never move the same way. */
const PANS = 4

interface Props {
  /** The thread as loaded so far. Grows while the film plays. */
  beats: StoryBeat[]
  /** Whether more of the thread can still be fetched. */
  hasMore: boolean
  loading: boolean
  failed: boolean
  /** Ask the scroller for the next window. Idempotent while one is in flight. */
  onNeedMore: () => void
  /**
   * Ask the scroller to re-fetch a stretch, for the signatures on its faces.
   * Idempotent per chapter while one is in flight.
   */
  onRefresh: (chapter: number) => void
  /** Whether a chapter's beads are old enough for their addresses to be. */
  isStale: (chapter: number) => boolean
  /** Closed, on the chapter it stopped at — the page below scrolls there. */
  onClose: (chapter: number) => void
  start: number
  lastChapter: number
}

export function Cinema({
  beats,
  hasMore,
  loading,
  failed,
  onNeedMore,
  onRefresh,
  isStale,
  onClose,
  start,
  lastChapter,
}: Props) {
  const shots = useMemo(() => planShots(beats), [beats])

  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [rate, setRate] = useState(1)
  /** Pictures whose signed URL did not answer. A shot survives losing them. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set())

  const shot = shots[index] ?? null
  const done = !hasMore && index >= shots.length && shots.length > 0

  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  /*
   * The chapter the film is on. Past the last shot it is the chapter the film
   * ended on, which is what the gauge and the close handler both want.
   */
  const at = shot?.chapter ?? shots.at(-1)?.chapter ?? start

  /*
   * The same number, kept in a ref for the close handler.
   *
   * Escape closes the dialog through the browser rather than through a click,
   * so the handler that reacts to it is the one React attached at mount, and a
   * value read from that closure would send the reader back to the first
   * chapter every time.
   */
  const stopped = useRef(at)
  useEffect(() => {
    stopped.current = at
  }, [at])

  /*
   * The countdown. One timer, restarted whenever the shot or the speed
   * changes — and deliberately keyed on the shot's *id* rather than on the
   * object, because a window arriving mid-shot rebuilds every shot in the
   * array and would otherwise restart the hold the reader was halfway through.
   */
  useEffect(() => {
    if (!playing || shot === null) return
    const timer = setTimeout(() => setIndex((n) => n + 1), shot.ms * rate)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, rate, index, shot?.id, shot?.ms])

  /*
   * There is no effect stopping the film at the end, and there does not need
   * to be: the countdown above only runs while there is a shot to hold, so
   * running out of thread stops it on its own. `playing` stays true and means
   * nothing until there is something to play again.
   */

  useEffect(() => {
    if (hasMore && index >= shots.length - LOOKAHEAD) onNeedMore()
  }, [hasMore, index, shots.length, onNeedMore])

  /*
   * A face that did not answer, and the second chance the film gives it.
   *
   * An address here is signed and expires — a minute, by default — and a film
   * runs for a great deal longer than that. The window it came in was preloaded
   * on arrival, which puts the bytes in the browser's cache while the signature
   * is still good; when that is not enough, the fix is not to hide the picture,
   * it is to ask for a new address. So a broken image asks the scroller to
   * re-fetch that stretch, and the fresh beads come back with fresh signatures.
   *
   * Once per *picture*, and which of the two identities a picture has does the
   * guarding is the whole of whether this terminates. Signing is not
   * idempotent: ask twice and the same file comes back under two addresses. So
   * a set of addresses guards nothing — the retry produces a URL it has never
   * seen, which fails, which retries, which is a loop against the API for as
   * long as the reel is open. The catalogue page is the same for every
   * signature of the same file, so it is what counts the attempt.
   *
   * Two goes per picture, then: the one that expired and the one that was
   * freshly signed. If the second fails too, the file is gone rather than
   * stale, and the shot plays without it.
   */
  const retried = useRef<Set<string>>(new Set())
  const broke = useCallback(
    (image: DisplayImage, chapter: number): void => {
      setBroken((was) => (was.has(image.url) ? was : new Set(was).add(image.url)))
      if (retried.current.has(image.sourceUrl)) return
      retried.current.add(image.sourceUrl)
      onRefresh(chapter)
    },
    [onRefresh],
  )

  /*
   * And the same ask, before anything breaks.
   *
   * The reactive path above costs a blink: the reader sees the frame fail and
   * then fill. Entering a chapter whose beads were fetched long enough ago that
   * their signatures are doubtful, the film re-asks for them first — one
   * request that re-signs the next six chapters, and the shots play against
   * addresses minted seconds earlier.
   */
  useEffect(() => {
    if (shot !== null && isStale(shot.chapter)) onRefresh(shot.chapter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot?.chapter, isStale, onRefresh])

  /*
   * Every picture, fetched the moment its window arrives.
   *
   * Not when the shot comes up. A film that waited until it needed a face would
   * be asking for a signature minted several minutes earlier and getting a 403
   * on the shots furthest into the window — the exact opposite of the failure
   * one would design for. Fetched on arrival the bytes land in the HTTP cache
   * while the address is still good, and the shot that eventually shows them
   * is a cache hit against the same URL.
   */
  const asked = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const shot of shots) {
      for (const image of shot.images) {
        if (asked.current.has(image.url)) continue
        asked.current.add(image.url)
        const probe = new window.Image()
        probe.onerror = () => broke(image, shot.chapter)
        probe.src = image.url
      }
    }
  }, [shots, broke])

  const step = useCallback(
    (by: number): void => {
      setPlaying(false)
      setIndex((n) => Math.min(Math.max(0, n + by), shots.length))
    },
    [shots.length],
  )

  const replay = useCallback((): void => {
    setIndex(0)
    setPlaying(true)
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      step(1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      step(-1)
      return
    }
    // Space is the play/pause key everywhere, and it is also how a focused
    // button is pressed. The button wins when there is one under the cursor of
    // the keyboard, otherwise the film takes it.
    if (event.key === ' ' || event.key === 'Spacebar') {
      const target = event.target as HTMLElement | null
      if (target?.closest('button')) return
      event.preventDefault()
      setPlaying((was) => !was)
    }
  }

  const images = shot?.images.filter((image) => !broken.has(image.url)) ?? []
  const progress = progressOf(at, start, lastChapter)

  return (
    <dialog
      ref={dialog}
      className="cine"
      aria-label="Le fil en animation"
      onKeyDown={onKeyDown}
      onClose={() => onClose(stopped.current)}
    >
      {/*
        * The stage, and the one element on it that never moves.
        *
        * `aria-live` has to sit on something stable: the shot below is keyed so
        * that each one mounts fresh — the entrance is a CSS animation, and an
        * element that is merely re-rendered does not replay one — and a live
        * region that is itself replaced announces nothing. So the region is the
        * container and the shots change inside it.
        *
        * What is announced is the card: its label, its line, its second line.
        * That is all the card carries now — the film shows the pictures and
        * says nothing about them, provenance included, which is the thread's
        * job and `/entite` after it.
        */}
      <div className="cine-plateau" aria-live="polite">
        <div className="cine-scene" key={shot?.id ?? (done ? 'fin' : 'attente')}>
          {shot === null ? (
            <Attente
              done={done}
              failed={failed}
              loading={loading}
              lastChapter={lastChapter}
              onRetry={onNeedMore}
              onReplay={replay}
            />
          ) : shot.kind === 'chapitre' ? (
            <Carton shot={shot} />
          ) : (
            <Plan
              shot={shot}
              images={images}
              index={index}
              rate={rate}
              playing={playing}
              onBroken={broke}
            />
          )}
        </div>
      </div>

      <div className="cine-chrome">
        <div
          className="cine-jauge"
          role="progressbar"
          aria-label="Avancée dans le fil"
          aria-valuemin={start}
          aria-valuemax={lastChapter}
          aria-valuenow={at}
          aria-valuetext={`Chapitre ${at}`}
        >
          <span style={{ width: `${(progress * 100).toFixed(2)}%` }} />
        </div>

        <div className="cine-commandes">
          <p className="cartouche cine-position">Chapitre {at}</p>

          <div className="cine-transport">
            <button
              type="button"
              className="bouton cine-bouton"
              onClick={() => step(-1)}
              disabled={index === 0}
            >
              Précédent
            </button>
            <button
              type="button"
              className="bouton bouton-primaire cine-bouton"
              autoFocus
              onClick={() => (done ? replay() : setPlaying((was) => !was))}
            >
              {done ? 'Revoir' : playing ? 'Pause' : 'Lecture'}
            </button>
            <button
              type="button"
              className="bouton cine-bouton"
              onClick={() => step(1)}
              disabled={index >= shots.length}
            >
              Suivant
            </button>
          </div>

          <div className="cine-vitesse" role="group" aria-label="Vitesse">
            {RATES.map((speed) => (
              <button
                key={speed.name}
                type="button"
                className="saut-lien cine-lien"
                aria-pressed={rate === speed.factor}
                data-choisi={rate === speed.factor ? 'oui' : undefined}
                onClick={() => setRate(speed.factor)}
              >
                {speed.name}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="bouton cine-bouton"
            onClick={() => dialog.current?.close()}
          >
            Fermer
          </button>
        </div>
      </div>
    </dialog>
  )
}

/** A chapter turning over: the arc, the number, and the title when there is one. */
function Carton({ shot }: { shot: Shot }) {
  return (
    <div className="cine-carton">
      {shot.label !== '' && <p className="cartouche">{shot.label}</p>}
      <p className="chiffre cine-chiffre">{shot.chapter}</p>
      {shot.line !== '' && <p className="cine-carton-titre">{shot.line}</p>}
    </div>
  )
}

/**
 * One shot: the faces, and the line they belong to.
 *
 * The pan runs for exactly as long as the shot is held, so the picture is
 * still moving when it cuts — a movement that finishes early and then sits
 * still is what makes a slideshow look like a slideshow. It is one CSS
 * animation on the image, switched off entirely for a reader who asked for
 * less motion, and the shot still holds for the same time.
 */
function Plan({
  shot,
  images,
  index,
  rate,
  playing,
  onBroken,
}: {
  shot: Shot
  images: Shot['images']
  index: number
  rate: number
  playing: boolean
  onBroken: (image: DisplayImage, chapter: number) => void
}) {
  return (
    <>
      {images.length > 0 && (
        // Paused, the picture stops too. A film held on one frame while the
        // camera keeps drifting across it is a film that looks broken rather
        // than paused — and it would drift to the end of its travel and sit
        // there for as long as the reader left it.
        <div
          className="cine-images"
          data-faces={images.length}
          data-arret={playing ? undefined : 'oui'}
        >
          {images.map((image, place) => (
            // The frame crops; the picture inside it moves. Without the wrapper
            // the pan would spill over the neighbouring face.
            <div className="cine-cadre" key={image.sourceUrl}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt=""
                className="cine-image"
                data-pan={(index + place) % PANS}
                style={{ animationDuration: `${Math.round(shot.ms * rate)}ms` }}
                onError={() => onBroken(image, shot.chapter)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="cine-legende" aria-live="polite" aria-atomic="true">
        {shot.label !== '' && <p className="cartouche cine-mot">{shot.label}</p>}

        <p className="cine-ligne" data-genre={shot.kind}>
          {shot.before !== null && (
            <>
              <span className="perle-avant">{shot.before}</span>
              <span aria-hidden="true"> → </span>
            </>
          )}
          {shot.line}
        </p>

        {shot.detail !== null && <p className="cine-detail">{shot.detail}</p>}
      </div>
    </>
  )
}

/**
 * Between two windows, or at the end of the thread.
 *
 * The waiting card is not a spinner over a blank screen on purpose: a film
 * that stops dead is indistinguishable from the end of the story, which is the
 * one thing the reader is watching to find out.
 */
function Attente({
  done,
  failed,
  loading,
  lastChapter,
  onRetry,
  onReplay,
}: {
  done: boolean
  failed: boolean
  loading: boolean
  lastChapter: number
  onRetry: () => void
  onReplay: () => void
}) {
  if (done) {
    return (
      <div className="cine-carton">
        <p className="cartouche">Le fil s&apos;arrête au chapitre</p>
        <p className="chiffre cine-chiffre">{lastChapter}</p>
        <p className="cine-carton-titre">
          C&apos;est là que vous en êtes. La suite viendra des chapitres que
          vous publierez.
        </p>
        <button type="button" className="bouton bouton-primaire mt-4" onClick={onReplay}>
          Revoir depuis le début
        </button>
      </div>
    )
  }

  if (failed) {
    return (
      <div className="cine-carton">
        <p className="cartouche">Coupure</p>
        <p className="cine-carton-titre">
          La suite du fil n&apos;a pas pu être chargée. Rien ne s&apos;est perdu,
          seulement cette requête.
        </p>
        <button type="button" className="bouton bouton-primaire mt-4" onClick={onRetry}>
          Réessayer
        </button>
      </div>
    )
  }

  return (
    <div className="cine-carton">
      <p className="cartouche">{loading ? 'La suite arrive…' : 'Un instant…'}</p>
    </div>
  )
}
