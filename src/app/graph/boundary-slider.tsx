'use client'

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * The chapter boundary, always visible.
 *
 * The default position is the far right: everything imported. The slider is a
 * lens for looking *back*, not a gate to unlock — its normal state shows the
 * whole graph, and only a deliberate drag hides anything.
 *
 * It lives in the URL rather than in component state, so a view at chapter 20
 * is something you can link to, reload, and open in a tab beside chapter 300.
 * State that only existed in memory would make "compare two moments" need a
 * second mechanism.
 *
 * The banner is not decoration, but it only appears once you have rewound:
 * someone returning to a tab has no other way to tell that what they are
 * reading is deliberately partial, and a graph quietly missing half the story
 * looks exactly like a graph that has all of it.
 */

interface Props {
  /** The session's boundary — the fallback when the URL names none. */
  boundaryChapter: number
  maxChapter: number
  /** Chapters actually imported, for the tick marks. */
  chapters: number[]
  /** Only changes the wording: a visitor did not import any of this. */
  isOwner: boolean
}

/**
 * How long the control waits, after the last change, before navigating.
 *
 * A drag fires a change per step, so crossing the bar from 0 to 20 is twenty of
 * them. Each one used to be a navigation, and each navigation is a full render
 * of a dynamic page — /histoire opens a database transaction per chapter of its
 * window. One sweep of this control was therefore a burst of tens of renders
 * against the same database, which is how playing with the bar emptied the
 * connection slots and took every page down with it, this one included.
 *
 * Only the navigation waits: the bar and the banner follow the thumb as they
 * did. And letting go commits at once, so nobody who releases the mouse ever
 * waits out the delay — it exists for the twenty steps *before* the release.
 */
const SETTLE_MS = 300

export function BoundarySlider({
  boundaryChapter,
  maxChapter,
  chapters,
  isOwner,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const listId = useId()
  const inputId = useId()

  /*
   * The boundary in force, taken from the URL rather than from the prop.
   *
   * The prop comes from the frame, and a layout is never handed the query
   * string, so it can only offer the session's default — which is the whole
   * library. The URL is what the page below was actually rendered with, so it
   * is what this control has to show. Without it the thumb sprang back to the
   * far right after every change and the banner announced a complete view of a
   * page stopped at chapter 5; the natural response to that is to grab the bar
   * and drag it again, which is exactly the wrong thing to invite.
   */
  const committed = fromUrl(params.get('ch'), boundaryChapter, maxChapter)

  // What the controls display: the boundary in force, or the one being chosen.
  const [shown, setShown] = useState(committed)
  const [lastCommitted, setLastCommitted] = useState(committed)
  if (lastCommitted !== committed) {
    setLastCommitted(committed)
    setShown(committed)
  }

  /*
   * The value a waiting navigation will use.
   *
   * A ref rather than the state above, because a release is dispatched in the
   * same task as the change that preceded it: read from state, the handler
   * would still see the step before last and commit the wrong chapter.
   */
  const target = useRef(committed)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const navigate = useCallback(
    (value: number): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      // Back where it started — a drag out and back is not a change.
      if (value === committed) return

      startTransition(() => {
        const next = new URLSearchParams(params.toString())
        next.set('ch', String(value))
        router.replace(`${pathname}?${next.toString()}`, { scroll: false })
      })
    },
    [committed, params, pathname, router],
  )

  /** A step of a drag: shown at once, sent once the drag stops. */
  const choose = useCallback(
    (value: number): void => {
      setShown(value)
      target.current = value
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        navigate(value)
      }, SETTLE_MS)
    },
    [navigate],
  )

  /** Released, or tabbed away: nothing left to wait for. */
  const settle = useCallback((): void => navigate(target.current), [navigate])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  /*
   * The number field holds its own text while it is being edited, and commits
   * on Enter or on leaving.
   *
   * Two reasons, both about what a controlled numeric input does otherwise: it
   * cannot be emptied, so backspace puts the old number straight back, and a
   * value read per keystroke means typing « 20 » asks for chapter 2 first and
   * renders a page nobody wanted.
   */
  const [typed, setTyped] = useState<string | null>(null)

  function commitTyped(): void {
    const raw = typed
    setTyped(null)
    if (raw === null) return

    const parsed = Number(raw)
    // Empty or unreadable: the field simply returns to the boundary in force.
    if (raw.trim() === '' || !Number.isFinite(parsed)) return

    const value = Math.max(0, Math.min(Math.floor(parsed), maxChapter))
    setShown(value)
    target.current = value
    navigate(value)
  }

  const atPresent = shown >= maxChapter

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface-base/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
        <label htmlFor={inputId} className="shrink-0 text-sm font-medium text-primary">
          Jusqu&apos;au chapitre
        </label>

        <input
          id={inputId}
          type="range"
          min={0}
          max={Math.max(maxChapter, 1)}
          step={1}
          value={shown}
          list={listId}
          onChange={(event) => choose(Number(event.target.value))}
          onPointerUp={settle}
          onKeyUp={settle}
          onBlur={settle}
          aria-valuetext={`chapitre ${shown} sur ${maxChapter}`}
          className="h-1.5 min-w-48 flex-1 cursor-pointer accent-[var(--accent)]"
        />
        <datalist id={listId}>
          {chapters.map((chapter) => (
            <option key={chapter} value={chapter} />
          ))}
        </datalist>

        <input
          type="number"
          min={0}
          max={maxChapter}
          value={typed ?? String(shown)}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={commitTyped}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitTyped()
          }}
          aria-label="Numéro de chapitre"
          className="w-20 rounded-sm border border-line-strong bg-surface-overlay px-2 py-1 text-right font-mono text-sm text-primary"
        />

        {pending && (
          <span className="text-xs text-muted" role="status">
            recalcul…
          </span>
        )}
      </div>

      {/*
       * Who the banner is talking to.
       *
       * « tout ce que vous avez importé » is true for the person who imported
       * it and false for everyone else, and the site is public: a visitor read
       * it as a claim about their own files, which they have none of. The
       * control is identical either way — only the sentence changes.
       */}
      {atPresent && maxChapter > 0 && (
        <p className="border-t border-line px-6 py-1 text-center text-xs text-muted">
          {isOwner
            ? `Vue complète : tout ce que vous avez importé jusqu'au chapitre ${maxChapter}.`
            : `Vue complète : tout ce qui est publié, jusqu'au chapitre ${maxChapter}.`}{' '}
          Reculez le curseur pour retrouver un &eacute;tat ant&eacute;rieur des
          connaissances.
        </p>
      )}

      {!atPresent && (
        <p
          role="status"
          className="border-t border-[var(--accent-soft)] bg-[var(--accent-soft)] px-6 py-1.5 text-center text-sm text-[var(--text-primary)]"
        >
          Vous lisez ce que l&apos;on sait{' '}
          <strong>à la fin du chapitre {shown}</strong>. Tout ce qui est révélé
          après est masqué — y compris rétroactivement.
        </p>
      )}
    </div>
  )
}

/**
 * The boundary the page was rendered with, as the URL states it.
 *
 * Clamped the same way the server clamps it, so the control never shows a
 * position the page does not have. The server remains the authority — this is
 * about what the reader is told, and a control that disagrees with the page
 * under it is worse than no control.
 */
function fromUrl(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(Math.floor(value), max))
}
