'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Beat } from './beat.tsx'
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
 */

const ROOT_MARGIN = '800px'

interface Props {
  initialBeats: StoryBeat[]
  initialCursor: number | null
  /** The reader's boundary, echoed back so the API cannot be talked past it. */
  boundary: number
  /** Where this thread starts. With the boundary, it is which thread this is. */
  start: number
  lastChapter: number
}

export function StoryScroller({
  initialBeats,
  initialCursor,
  boundary,
  start,
  lastChapter,
}: Props) {
  const [beats, setBeats] = useState(initialBeats)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

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
  }

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
  }, [boundary, cursor])

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

  return (
    <>
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
                La suite n&apos;a pas pu être chargée. Rien ne s&apos;est perdu —
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
          </p>
        )}
      </div>
    </>
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
