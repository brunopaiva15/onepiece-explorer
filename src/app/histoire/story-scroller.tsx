'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Beat } from './beat.tsx'
import { Cinema } from './cinema.tsx'
import { CopyStory } from './copy-story.tsx'
import { arcOf } from '@/domains/temporal/arcs.ts'
import type { StoryBeat } from '@/domains/temporal/story.ts'

/**
 * The scroll that pulls the thread.
 *
 * Three things it must not do, all of them things an infinite scroll usually
 * does:
 *
 *  1. **Take the scroll away.** No snap that fights the wheel, no hijacked
 *     keyboard. This decides when to ask for more and nothing else.
 *  2. **Lie when it fails.** A stretch that fails to load says so and offers to
 *     try again. Stopping quietly is indistinguishable from the end of the
 *     story, which is the one thing the reader is here to find.
 *  3. **Need JavaScript to be readable.** The first stretch is server-rendered
 *     and the thread is drawn in CSS. This adds more of it; it does not reveal
 *     what is already there.
 *
 * There is no progress widget, because the thread is one: the drawn part of the
 * line is how far the reader has come.
 *
 * It also owns the loaded beads, which is why animation mode hangs off it
 * rather than off the page: the film plays the same array, asks for the next
 * window through the same `loadMore()`, and therefore cannot reach a bead the
 * scroll could not. Two loaders would be two boundaries to keep honest.
 */

const ROOT_MARGIN = '800px'

/** A store with nothing to subscribe to — see `hydrated` below. */
const NEVER_CHANGES = () => () => {}

/**
 * How long a stretch's signed addresses are trusted, in milliseconds.
 *
 * The pictures in a page of beads are reached by URLs that expire —
 * `SIGNED_URL_TTL_SECONDS`, a minute by default — and animation mode plays for
 * a great deal longer than that from one fetch. So beads have a shelf life
 * here, and past it the film asks for the stretch again rather than showing a
 * frame that will not load.
 *
 * Deliberately well under the default: the number is not the expiry, it is when
 * we stop betting on it, and a request that turns out not to have been needed
 * costs one read of six chapters. Scrolling is unaffected — a reader who
 * scrolls past a bead sees it within seconds of its arriving.
 */
const STALE_AFTER = 40_000

interface Props {
  initialBeats: StoryBeat[]
  initialCursor: number | null
  /** The reader's boundary, echoed back so the API cannot be talked past it. */
  boundary: number
  /** Where this thread starts. With the boundary, it is which thread this is. */
  start: number
  lastChapter: number
  /** Signed in on their own library: the copy button is theirs alone. */
  isOwner: boolean
}

export function StoryScroller({
  initialBeats,
  initialCursor,
  boundary,
  start,
  lastChapter,
  isOwner,
}: Props) {
  const [beats, setBeats] = useState(initialBeats)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)

  /**
   * When each chapter's beads were last fetched.
   *
   * A ref rather than state: nothing on the page changes when a stretch ages,
   * and the only reader is the film, which asks at the moment it needs to know.
   */
  const stamps = useRef(new Map<number, number>())
  const stamp = useCallback((fetched: StoryBeat[]): void => {
    const now = Date.now()
    for (const beat of fetched) stamps.current.set(beat.chapter, now)
  }, [])

  const isStale = useCallback((chapter: number): boolean => {
    const at = stamps.current.get(chapter)
    return at === undefined || Date.now() - at > STALE_AFTER
  }, [])

  /*
   * Which thread is on screen — and the reset when the server sends another.
   *
   * `useState(initialBeats)` is read once, at mount, and never again. Every
   * other prop here comes from the server on each render, so an interface built
   * on them looks like it works: jumping to chapter 41 re-rendered the page,
   * the title said « Depuis le chapitre 41 », and the thread under it was still
   * the one that started at chapter 1 — the only part of the page that had not
   * heard about the navigation was the part the navigation was for.
   *
   * A client-side navigation to the same route keeps this component instance,
   * so nothing remounts and the initial state stands. The boundary slider has
   * the same shape and therefore had the same fault: rewinding to chapter 20
   * left the beads of chapter 900 on the page.
   *
   * Keyed on the two numbers that say which thread this is rather than on the
   * array, whose identity is new on every render: a refresh that returns the
   * same stretch must not throw away twenty chapters the reader has scrolled
   * through.
   */
  const thread = `${start}|${boundary}`
  const [shown, setShown] = useState(thread)
  if (shown !== thread) {
    setShown(thread)
    setBeats(initialBeats)
    setCursor(initialCursor)
    setLoading(false)
    setFailed(false)
    // Another thread means the film would be playing beads that no longer
    // belong to the page under it.
    setPlaying(false)
  }

  /*
   * The first stretch of a thread, stamped as it arrives.
   *
   * It was signed when the server rendered the page, so it ages from the moment
   * the reader received it. Keyed on the thread rather than on mount, because a
   * navigation to another stretch hands over a new `initialBeats` without
   * remounting anything — see above; and the old thread's stamps go with it,
   * since they describe addresses nothing will ask for again.
   */
  useEffect(() => {
    stamps.current = new Map()
    stamp(initialBeats)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread, stamp])

  /** The arc the thread stops in — which is the arc the reader is in. */
  const end = arcOf(lastChapter)

  const sentinel = useRef<HTMLDivElement | null>(null)
  /** Guards against a second fetch for a stretch already in flight. */
  const inFlight = useRef(false)
  /*
   * The thread a request was asked for, read back when it answers.
   *
   * A jump made while a stretch is in flight would otherwise land the tail of
   * the old thread on the head of the new one — chapter 7 arriving under
   * chapter 41 seconds after the page settled, which reads as corruption
   * rather than as a late response.
   */
  const asked = useRef(thread)
  useEffect(() => {
    asked.current = thread
  }, [thread])

  const loadMore = useCallback(async () => {
    if (cursor === null || inFlight.current) return
    const forThread = asked.current
    inFlight.current = true
    setLoading(true)
    setFailed(false)

    try {
      const response = await fetch(`/api/histoire?depuis=${cursor}&ch=${boundary}`)
      if (!response.ok) throw new Error(String(response.status))

      const page = (await response.json()) as {
        beats: StoryBeat[]
        nextCursor: number | null
      }

      if (asked.current !== forThread) return

      stamp(page.beats)
      setBeats((previous) => {
        // Two sentinels firing on a slow connection must not double the thread.
        const seen = new Set(previous.map((beat) => beat.id))
        return [...previous, ...page.beats.filter((beat) => !seen.has(beat.id))]
      })
      setCursor(page.nextCursor)
    } catch {
      if (asked.current === forThread) setFailed(true)
    } finally {
      inFlight.current = false
      if (asked.current === forThread) setLoading(false)
    }
  }, [boundary, cursor, stamp])

  useEffect(() => {
    const node = sentinel.current
    if (!node || cursor === null) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { rootMargin: ROOT_MARGIN },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loadMore])

  /**
   * The same stretch again, for the signatures on it.
   *
   * Not more thread: the beads that come back are the ones already on the page,
   * with fresh addresses for their faces, and they are merged **by id** so the
   * array keeps its shape — the film is in the middle of playing it, and
   * replacing the array would be replacing the reel. A bead the refresh does
   * not mention keeps what it had.
   *
   * One request per chapter at a time, and one request covers a whole window,
   * so a film crossing six chapters asks once rather than six times.
   */
  const refreshing = useRef(new Set<number>())
  const refresh = useCallback(
    async (chapter: number): Promise<void> => {
      if (refreshing.current.has(chapter)) return
      refreshing.current.add(chapter)

      try {
        const response = await fetch(
          `/api/histoire?depuis=${chapter}&ch=${boundary}`,
        )
        if (!response.ok) throw new Error(String(response.status))

        const page = (await response.json()) as { beats: StoryBeat[] }
        stamp(page.beats)

        const fresh = new Map(page.beats.map((beat) => [beat.id, beat]))
        setBeats((previous) =>
          previous.map((beat) => fresh.get(beat.id) ?? beat),
        )
      } catch {
        /*
         * Silent, and it is the one place in this file where that is right.
         * Nothing was lost — the beads on the page are the beads that were
         * there — and the reader did not ask for this request. A face that
         * still will not load falls off its shot; the shot plays without it.
         */
      } finally {
        refreshing.current.delete(chapter)
      }
    },
    [boundary, stamp],
  )

  const play = useRef<HTMLButtonElement>(null)

  /**
   * Whether the browser has taken over from the server rendering.
   *
   * `useSyncExternalStore` with a store that never changes: the server snapshot
   * is false, the client one is true, and React swaps them on hydration without
   * a state write in an effect. It is the one thing that separates « this
   * component runs in the browser » from « this markup was produced there ».
   */
  const hydrated = useSyncExternalStore(NEVER_CHANGES, () => true, () => false)

  /** Stable, because the film re-asks whenever this identity changes. */
  const needMore = useCallback((): void => void loadMore(), [loadMore])

  /**
   * Closed, on the chapter the film stopped at.
   *
   * The page underneath scrolls there, because someone who watched to chapter
   * 60 and pressed Escape is asking about chapter 60 — landing them back at
   * the top would make closing the film a way of losing their place. The focus
   * goes back to the button that opened it, and without moving the page again:
   * `focus()` scrolls its target into view by default, which would undo the
   * line above.
   */
  const closeCinema = useCallback((chapter: number): void => {
    setPlaying(false)
    document.getElementById(`ch-${chapter}`)?.scrollIntoView({ block: 'start' })
    play.current?.focus({ preventScroll: true })
  }, [])

  return (
    <>
      {/* Drawn once the browser has taken over, and not before. The thread is
          complete without the film, so a page whose JavaScript never arrives
          shows no button rather than one that does nothing — and this component
          is server-rendered like everything else, so « client component » is not
          on its own the same promise. */}
      {hydrated && (
        <div className="fil-projection">
          <button
            ref={play}
            type="button"
            className="bouton bouton-primaire"
            onClick={() => setPlaying(true)}
          >
            <Triangle />
            Voir en animation
          </button>
          {/* Beside the film rather than in the header: both are the same kind
              of control — something that takes the whole thread at once — and
              both need the browser, so they appear and disappear together.
              Before the help text, which grows to fill the row: after it, the
              two buttons would sit at opposite ends of something they both
              act on. */}
          {isOwner && (
            <CopyStory
              start={start}
              boundary={boundary}
              lastChapter={lastChapter}
            />
          )}

          <p className="fil-projection-aide">
            Le fil se déroule tout seul, image par image, du chapitre {start} à
            celui où vous en êtes.
          </p>
        </div>
      )}

      {playing && (
        <Cinema
          beats={beats}
          hasMore={cursor !== null}
          loading={loading}
          failed={failed}
          onNeedMore={needMore}
          onRefresh={refresh}
          isStale={isStale}
          onClose={closeCinema}
          start={start}
          lastChapter={lastChapter}
        />
      )}

      <ol className="fil">
        {fold(beats).map((run) =>
          Array.isArray(run) ? (
            <li key={run[0]!.id} className="perle-repli">
              <details>
                <summary>
                  Voir les {run.length} autre{run.length > 1 ? 's' : ''} événement
                  {run.length > 1 ? 's' : ''} de ce chapitre
                </summary>
                <ol>
                  {run.map((beat) => (
                    <Beat key={beat.id} beat={beat} />
                  ))}
                </ol>
              </details>
            </li>
          ) : (
            <Beat key={run.id} beat={run} />
          ),
        )}
      </ol>

      <div ref={sentinel} className="fil-bout" aria-live="polite">
        {loading && <p className="cartouche">La suite arrive…</p>}

        {failed && (
          <div className="panneau">
            <div className="panneau-corps">
              <p className="text-secondary">
                La suite n&apos;a pas pu être chargée. Rien ne s&apos;est perdu,
                seulement cette requête.
              </p>
              <button
                type="button"
                onClick={() => void loadMore()}
                className="bouton bouton-primaire mt-3"
              >
                Réessayer
              </button>
            </div>
          </div>
        )}

        {cursor === null && !failed && beats.length > 0 && (
          <p className="fil-fin">
            <span className="cartouche">Le fil s&apos;arrête au chapitre</span>
            <span className="chiffre chiffre-xl">{lastChapter}</span>
            {/* Where the reader is, named. The number is the boundary, and the
                arc is the same fact in the words people use when they say how
                far they have got. */}
            {end && <span className="cartouche">{end.name}</span>}
          </p>
        )}
      </div>
    </>
  )
}

/** The play mark, drawn rather than typed: « ▶ » is an emoji on half the phones. */
function Triangle() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3 w-3 shrink-0">
      <path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" />
    </svg>
  )
}

/**
 * Consecutive folded beads, gathered into one run.
 *
 * A chapter of fifteen events shows five and offers the rest; the thread stays
 * readable and the chapter keeps everything it had. A `<details>` rather than a
 * state flag: it opens without JavaScript, a browser's find-in-page can already
 * reach inside it, and there is no third state to get wrong.
 */
function fold(beats: StoryBeat[]): Array<StoryBeat | StoryBeat[]> {
  const out: Array<StoryBeat | StoryBeat[]> = []
  for (const beat of beats) {
    if (!beat.collapsed) {
      out.push(beat)
      continue
    }
    const last = out.at(-1)
    if (Array.isArray(last)) last.push(beat)
    else out.push([beat])
  }
  return out
}
