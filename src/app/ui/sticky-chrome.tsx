'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The top chrome, out of the way while reading down a phone.
 *
 * Search and the boundary slider are pinned to the top of every page, and on a
 * desktop that costs nothing. On a phone the two of them plus the banner under
 * them take roughly a fifth of the screen, permanently, on pages whose whole
 * job is to show a long column of content — story mode most of all, where what
 * is left is about four beads.
 *
 * So it folds away when the reader scrolls down and comes back the moment they
 * scroll up, which is the gesture people already make when they want the
 * controls. Four things keep that from becoming a bar that flickers:
 *
 *  1. **Only once pinned.** On a small screen the navigation rail sits above
 *     this bar in the flow, so for the first few hundred pixels of a scroll the
 *     bar is not at the top of the screen at all — it is still on its way
 *     there. Folding it then would slide it up across the rail. The sentinel
 *     below says where the bar's own place in the page is, and nothing happens
 *     until the page has scrolled past it.
 *  2. **A dead zone.** A few pixels of movement is a thumb resting on the
 *     glass, not a decision. Under it, nothing happens.
 *  3. **The top is always open.** Just past the pin point the bar is shown
 *     whatever the direction, so it can never be folded away at the one place
 *     where there is nothing to gain by folding it.
 *  4. **Focus wins.** `/` focuses the search from anywhere, including from a
 *     scrolled-down page where the bar is folded. Focus moving inside opens it
 *     — otherwise the caret lands somewhere off-screen.
 *
 * Only on small screens, and that is decided in CSS rather than here: the
 * attribute carries the state, the media query decides whether the state means
 * anything. A resize therefore needs no listener, and the desktop rendering is
 * the one it always was.
 */

/** Above this many pixels of movement, a scroll is a decision. */
const DEADZONE = 8

/** How far past its own place in the page the bar stays open regardless. */
const REVEAL_WITHIN = 96

export function StickyChrome({ children }: { children: React.ReactNode }) {
  const [folded, setFolded] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const frame = useRef(0)

  useEffect(() => {
    // Clamped: iOS rubber-banding reports positions past both ends, and a
    // negative one read as "scrolled up" folds the bar open and shut at rest.
    let last = Math.max(0, window.scrollY)

    function measure(): void {
      frame.current = 0
      const y = Math.max(0, window.scrollY)
      const delta = y - last

      /*
       * How far the bar's own place in the page has gone above the fold. Read
       * from the sentinel rather than from the bar, because the bar is pinned —
       * and, once folded, translated — so its own position says nothing.
       */
      const above = -(sentinel.current?.getBoundingClientRect().top ?? 0)

      if (above < REVEAL_WITHIN) {
        last = y
        setFolded(false)
        return
      }
      if (Math.abs(delta) < DEADZONE) return

      last = y
      setFolded(delta > 0)
    }

    function onScroll(): void {
      if (frame.current !== 0) return
      frame.current = requestAnimationFrame(measure)
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (frame.current !== 0) cancelAnimationFrame(frame.current)
    }
  }, [])

  return (
    <>
      <div ref={sentinel} aria-hidden="true" />
      <div
        className="chrome-haut sticky top-0 z-30 border-b-[3px] border-ink bg-[var(--surface-raised)]"
        data-replie={folded ? 'oui' : undefined}
        onFocus={() => setFolded(false)}
      >
        {children}
      </div>
    </>
  )
}
