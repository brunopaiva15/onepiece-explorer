'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Going straight to a chapter, instead of scrolling to it.
 *
 * The thread is one continuous page, which is the point of story mode and also
 * its one navigational hole: reaching chapter 300 meant scrolling through two
 * hundred and ninety-nine of them, six chapters per fetch. The page already
 * accepted `?depuis=`, so the ability was there — nothing in the interface
 * offered it.
 *
 * Two ways to get there, because the thread is already loaded or it is not:
 *
 *  1. **Already on the page.** The chapter notch carries `id="ch-N"`, so the
 *     jump is a scroll. No request, no re-render, and the beads the reader has
 *     already pulled in stay pulled in.
 *  2. **Beyond it.** A navigation to `?depuis=N`, which re-renders the thread
 *     starting there. The boundary rides along in the URL, so jumping never
 *     silently un-rewinds a reader who is looking at chapter 40 of a library of
 *     900.
 *
 * A number that names no chapter is not refused, it is snapped: a library that
 * jumps from 38 to 42 answers « 40 » with 42 rather than with an error, because
 * the reader is pointing at a place in the story, not typing a primary key.
 *
 * The control is in the page header, and follows as a small button once the
 * header has scrolled away — the same form, in the corner, so that the answer
 * to "how do I get back to chapter 12" is never "scroll to the top first".
 */

interface Props {
  /** Published chapters the reader may reach, ascending. Never empty. */
  chapters: number[]
  /** The chapter the thread currently starts at. */
  start: number
  /**
   * The boundary as the URL states it, carried through the jump.
   *
   * The raw string rather than the resolved number: a URL with no `ch` means
   * "wherever the session is", and writing the resolved number back would
   * freeze a reader who never touched the slider at today's last chapter.
   */
  boundaryParam: string | null
}

export function ChapterNav({ chapters, start, boundaryParam }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  /** True once the header form has scrolled out of sight. */
  const [away, setAway] = useState(false)

  const anchor = useRef<HTMLDivElement>(null)
  const floating = useRef<HTMLDivElement>(null)

  const first = chapters[0]!
  const last = chapters.at(-1)!

  const go = useCallback(
    (raw: number): void => {
      // Upwards first: asking for a chapter that was never imported means
      // « from about here », and the story continues forwards.
      const target = chapters.find((chapter) => chapter >= raw) ?? last
      setOpen(false)

      const notch = document.getElementById(`ch-${target}`)
      if (notch) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
        notch.scrollIntoView({
          behavior: reduced.matches ? 'auto' : 'smooth',
          block: 'start',
        })
        return
      }

      const query = new URLSearchParams({ depuis: String(target) })
      if (boundaryParam !== null) query.set('ch', boundaryParam)
      router.push(`/histoire?${query.toString()}`)
    },
    [boundaryParam, chapters, last, router],
  )

  // Escape closes the floating panel, and so does a click outside it: it covers
  // the thread, and a panel you have to aim at to dismiss is worse than none.
  useEffect(() => {
    if (!open) return

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    function onPointer(event: PointerEvent): void {
      const node = floating.current
      if (node && !node.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  useEffect(() => {
    const node = anchor.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setAway(!entry.isIntersecting)
          // Scrolled back to the header: the corner copy is gone, and leaving
          // it open would spring a panel open again on the next scroll down.
          if (entry.isIntersecting) setOpen(false)
        }
      },
      { threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <div ref={anchor} className="saut">
        <Champ chapters={chapters} start={start} onGo={go} />
      </div>

      {/* Hidden from the tab order and from screen readers while the header
          form is on screen: it is the same control, and meeting it twice in a
          row is a duplicate, not a shortcut. */}
      <div
        ref={floating}
        className="saut-flottant"
        data-visible={away ? 'oui' : undefined}
        inert={!away}
      >
        {open && (
          <div className="saut-panneau">
            <Champ chapters={chapters} start={start} onGo={go} autoFocus />
          </div>
        )}

        <button
          type="button"
          className="bouton bouton-primaire saut-pastille"
          aria-expanded={open}
          aria-label={
            open
              ? 'Fermer le saut de chapitre'
              : `Aller à un chapitre, entre ${first} et ${last}`
          }
          onClick={() => setOpen((was) => !was)}
        >
          {open ? 'Fermer' : 'Chapitre'}
          <Fleche open={open} />
        </button>
      </div>
    </>
  )
}

/**
 * Which way the corner panel will move. Drawn, so it turns with the state —
 * the panel opens upwards, so the closed state points up.
 */
function Fleche({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="h-3 w-3 shrink-0"
      style={{ rotate: open ? '0deg' : '180deg' }}
    >
      <path
        d="M2 4.5 L6 8.5 L10 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  )
}

/**
 * The form itself: a number, and the two ends of what the reader has.
 *
 * Uncontrolled between submissions — the field holds what is being typed and
 * nothing else, and the chapter in force is the placeholder. A controlled value
 * read per keystroke would make typing « 120 » ask for chapter 1 on the way.
 */
function Champ({
  chapters,
  start,
  onGo,
  autoFocus,
}: {
  chapters: number[]
  start: number
  onGo: (chapter: number) => void
  autoFocus?: boolean
}) {
  const inputId = useId()
  const listId = useId()
  const [typed, setTyped] = useState('')

  const first = chapters[0]!
  const last = chapters.at(-1)!

  function submit(): void {
    const value = Number(typed)
    if (typed.trim() === '' || !Number.isFinite(value)) return
    setTyped('')
    onGo(Math.max(first, Math.min(Math.floor(value), last)))
  }

  return (
    <form
      className="saut-forme"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <label htmlFor={inputId} className="cartouche saut-label">
        Aller au chapitre
      </label>

      <div className="saut-ligne">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={first}
          max={last}
          list={listId}
          value={typed}
          placeholder={String(start)}
          autoFocus={autoFocus}
          onChange={(event) => setTyped(event.target.value)}
          className="saut-nombre"
        />
        {/* The imported chapters, as suggestions — the same list the boundary
            slider ticks with, so both controls agree on what exists. */}
        <datalist id={listId}>
          {chapters.map((chapter) => (
            <option key={chapter} value={chapter} />
          ))}
        </datalist>

        <button type="submit" className="bouton bouton-primaire saut-bouton">
          Y aller
        </button>
      </div>

      <p className="saut-aide">
        <button
          type="button"
          className="saut-lien"
          onClick={() => onGo(first)}
          disabled={start <= first}
        >
          Début
        </button>
        <span aria-hidden="true"> · </span>
        <button type="button" className="saut-lien" onClick={() => onGo(last)}>
          Dernier ({last})
        </button>
      </p>
    </form>
  )
}
