'use client'

import { useId, useOptimistic, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

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
  boundaryChapter: number
  maxChapter: number
  /** Chapters actually imported, for the tick marks. */
  chapters: number[]
  locale: Locale
}

export function BoundarySlider({
  boundaryChapter,
  maxChapter,
  chapters,
  locale,
}: Props) {
  const t = getDictFor(locale).shell
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()
  const listId = useId()
  const inputId = useId()

  // Optimistic so dragging feels immediate while the server re-projects. The
  // value shown is always the one the user chose, never a stale round-trip.
  const [shown, setShown] = useOptimistic(boundaryChapter)

  function commit(value: number): void {
    startTransition(() => {
      setShown(value)
      const next = new URLSearchParams(params.toString())
      next.set('ch', String(value))
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    })
  }

  const atPresent = shown >= maxChapter

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-surface-base/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
        <label htmlFor={inputId} className="shrink-0 text-sm font-medium text-primary">
          {t.boundaryLabel}
        </label>

        <input
          id={inputId}
          type="range"
          min={0}
          max={Math.max(maxChapter, 1)}
          step={1}
          value={shown}
          list={listId}
          onChange={(event) => commit(Number(event.target.value))}
          aria-valuetext={t.boundaryValue(shown, maxChapter)}
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
          value={shown}
          onChange={(event) => commit(Number(event.target.value))}
          aria-label={t.boundaryInputLabel}
          className="w-20 rounded-sm border border-line-strong bg-surface-overlay px-2 py-1 text-right font-mono text-sm text-primary"
        />

        {pending && (
          <span className="text-xs text-muted" role="status">
            {t.boundaryRecomputing}
          </span>
        )}
      </div>

      {atPresent && maxChapter > 0 && (
        <p className="border-t border-line px-6 py-1 text-center text-xs text-muted">
          {t.boundaryFullView(maxChapter)}
        </p>
      )}

      {!atPresent && (
        <p
          role="status"
          className="border-t border-[var(--accent-soft)] bg-[var(--accent-soft)] px-6 py-1.5 text-center text-sm text-[var(--text-primary)]"
        >
          {t.boundaryRewoundLead}{' '}
          <strong>{t.boundaryRewoundStrong(shown)}</strong>
          {t.boundaryRewoundTail}
        </p>
      )}
    </div>
  )
}
