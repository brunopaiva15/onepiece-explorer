'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChapterSpread } from './chapter-spread.tsx'
import type { StoryChapter } from '@/domains/temporal/story.ts'

/**
 * The scroll that advances the story.
 *
 * Three things it must not do, all of them things an infinite scroll usually
 * does:
 *
 *  1. **Take the scroll away.** No scroll-jacking, no snap that fights the
 *     wheel, no hijacked keyboard. The reader's scroll is the reader's; this
 *     component only decides when to ask for more.
 *
 *  2. **Lie when it fails.** A window that fails to load says so and offers to
 *     try again. Silently stopping would be indistinguishable from reaching the
 *     end of the story, which is the one thing the reader is here to find.
 *
 *  3. **Lose the address.** The chapter under the reader's eye is written to
 *     the URL fragment, so a link points at what they were looking at and a
 *     reload comes back to it.
 *
 * Windows are fetched from a route handler rather than a server function
 * because the response is data — the same JSON a second reader would get —
 * and because a plain GET is what a `<link rel=prefetch>` and a browser's
 * back button both already understand.
 */

const ROOT_MARGIN = '600px'

interface Props {
  initialChapters: StoryChapter[]
  initialCursor: number | null
  /** The reader's boundary, echoed back to the API so it cannot be widened. */
  boundary: number
  lastChapter: number
}

export function StoryScroller({
  initialChapters,
  initialCursor,
  boundary,
  lastChapter,
}: Props) {
  const [chapters, setChapters] = useState(initialChapters)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [current, setCurrent] = useState(initialChapters[0]?.number ?? 0)

  const sentinel = useRef<HTMLDivElement | null>(null)
  const container = useRef<HTMLDivElement | null>(null)
  /** Guards against a second fetch for a window already in flight. */
  const inFlight = useRef(false)

  const loadMore = useCallback(async () => {
    if (cursor === null || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setFailed(false)

    try {
      const response = await fetch(
        `/api/histoire?depuis=${cursor}&ch=${boundary}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw new Error(String(response.status))

      const page = (await response.json()) as {
        chapters: StoryChapter[]
        nextCursor: number | null
      }

      setChapters((previous) => {
        // The server is the authority on order, but a duplicated window —
        // two sentinels firing on a slow connection — must not double the page.
        const seen = new Set(previous.map((chapter) => chapter.number))
        return [
          ...previous,
          ...page.chapters.filter((chapter) => !seen.has(chapter.number)),
        ]
      })
      setCursor(page.nextCursor)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }, [boundary, cursor])

  /* Ask for the next window a screen and a half before the reader gets there. */
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

  /*
   * Which chapter the reader is in.
   *
   * Feeds the log book in the margin and the URL fragment. Re-observed when
   * chapters arrive, because the sections it watches did not exist before.
   */
  useEffect(() => {
    const root = container.current
    if (!root) return

    const sections = root.querySelectorAll<HTMLElement>('[data-chapitre]')
    if (sections.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (!visible) return
        const number = Number(
          (visible.target as HTMLElement).dataset.chapitre ?? '0',
        )
        if (Number.isFinite(number) && number > 0) setCurrent(number)
      },
      { rootMargin: '-45% 0px -45% 0px' },
    )
    for (const section of sections) observer.observe(section)
    return () => observer.disconnect()
  }, [chapters.length])

  /*
   * The fragment follows the reading, without a history entry per chapter.
   *
   * `replaceState` rather than a router push: three hundred chapters scrolled
   * past would otherwise be three hundred presses of the back button before
   * the reader escapes the page.
   */
  useEffect(() => {
    if (current <= 0) return
    const url = new URL(window.location.href)
    if (url.hash === `#ch-${current}`) return
    url.hash = `ch-${current}`
    window.history.replaceState(null, '', url)
  }, [current])

  const done = cursor === null

  return (
    <>
      <LogBook current={current} last={lastChapter} />

      <div ref={container}>
        {chapters.map((chapter) => (
          <div key={chapter.number} data-chapitre={chapter.number}>
            <ChapterSpread chapter={chapter} />
          </div>
        ))}
      </div>

      <div ref={sentinel} className="histoire-sentinelle" aria-live="polite">
        {loading && <p className="cartouche">Le chapitre suivant arrive…</p>}

        {failed && (
          <div className="panneau histoire-echec">
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

        {done && !failed && chapters.length > 0 && (
          <p className="histoire-fin">
            <span className="cartouche">Vous êtes arrivé au chapitre</span>
            <span className="chiffre chiffre-xl">{lastChapter}</span>
            <span className="text-secondary">
              C&apos;est tout ce que votre bibliothèque raconte pour l&apos;instant.
            </span>
          </p>
        )}
      </div>
    </>
  )
}

/**
 * Where you are, in the margin.
 *
 * A story told by scrolling loses the one thing a book gives for free: the
 * thickness of what is left. This is that, and nothing else — no controls, no
 * scrubber. Hidden from screen readers, which have the chapter headings and do
 * not need a decoration repeating them.
 */
function LogBook({ current, last }: { current: number; last: number }) {
  const progress = last > 0 ? Math.min(100, (current / last) * 100) : 0

  return (
    <div className="histoire-carnet" aria-hidden="true">
      <span className="histoire-carnet-numero chiffre">{current || '—'}</span>
      <span className="histoire-carnet-rail">
        <span
          className="histoire-carnet-jauge"
          style={{ height: `${progress}%` }}
        />
      </span>
      <span className="histoire-carnet-fin chiffre">{last}</span>
    </div>
  )
}
