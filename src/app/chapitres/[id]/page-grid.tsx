'use client'

import { useMemo, useState, useTransition } from 'react'
import type { PageView } from '@/domains/chapters/queries.ts'
import { reorderPagesAction } from '@/app/import/actions.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'
import type { Locale } from '@/lib/i18n/index.ts'

/**
 * Page preview and reordering.
 *
 * Automatic ordering is a guess — from filenames, or from PDF page order —
 * and it is wrong often enough that correcting it must not mean re-importing.
 * A scrambled chapter is the worst kind of error here, because the resulting
 * knowledge graph looks entirely plausible while being narratively backwards.
 *
 * Reordering is keyboard-first rather than drag-first. Drag-and-drop is the
 * obvious gesture and the least accessible one; moving a page with the arrow
 * keys works with a screen reader, on a trackpad, and while holding a phone.
 * Nothing is saved until the user says so, so an experiment costs nothing.
 */

interface Props {
  chapterId: string
  chapterNumber: number
  readingDirection: 'rtl' | 'ltr'
  pages: PageView[]
  locale: Locale
}

interface Draft {
  page: PageView
  excluded: boolean
}

export function PageGrid({ chapterId, chapterNumber, readingDirection, pages, locale }: Props) {
  const dict = getDictFor(locale)
  const t = dict.chapters
  const initial = useMemo(
    () => pages.map((page) => ({ page, excluded: page.excluded })),
    [pages],
  )

  const [draft, setDraft] = useState<Draft[]>(initial)
  const [focused, setFocused] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  const dirty = useMemo(() => {
    if (draft.length !== initial.length) return true
    return draft.some(
      (entry, index) =>
        entry.page.id !== initial[index]!.page.id ||
        entry.excluded !== initial[index]!.excluded,
    )
  }, [draft, initial])

  function move(pageId: string, delta: number): void {
    setDraft((current) => {
      const from = current.findIndex((entry) => entry.page.id === pageId)
      const to = from + delta
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved!)
      return next
    })
    setFocused(pageId)
  }

  function toggleExcluded(pageId: string): void {
    setDraft((current) =>
      current.map((entry) =>
        entry.page.id === pageId ? { ...entry, excluded: !entry.excluded } : entry,
      ),
    )
  }

  function save(): void {
    startSaving(async () => {
      const result = await reorderPagesAction(
        chapterId,
        draft.map((entry, index) => ({
          pageId: entry.page.id,
          index,
          excluded: entry.excluded,
        })),
      )
      setMessage(result.ok ? t.orderSaved : (result.error ?? t.orderFailed))
    })
  }

  const kept = draft.filter((entry) => !entry.excluded).length

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <p className="text-sm text-secondary">
          {t.keptCount(kept)}
          {kept !== draft.length && ` · ${t.excludedCount(draft.length - kept)}`}
        </p>

        <p className="text-sm text-muted">
          {readingDirection === 'rtl' ? t.readingRtl : t.readingLtr}
        </p>

        <div className="ml-auto flex items-center gap-3">
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setDraft(initial)
                setMessage(null)
              }}
              className="rounded-sm border border-line-strong px-3 py-1.5 text-sm text-primary hover:bg-surface-raised"
            >
              {dict.common.cancel}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-medium text-inverted hover:bg-accent-strong disabled:opacity-40"
          >
            {saving ? t.savingEllipsis : t.saveOrder}
          </button>
        </div>
      </div>

      {message && (
        <p role="status" className="mt-3 text-sm text-secondary">
          {message}
        </p>
      )}

      <p className="mt-3 text-sm text-muted">{t.gridHelp}</p>

      <ol className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {draft.map((entry, index) => (
          <li key={entry.page.id}>
            <div
              tabIndex={0}
              role="button"
              aria-label={t.pageAria(index + 1, entry.excluded)}
              onFocus={() => setFocused(entry.page.id)}
              onKeyDown={(event) => {
                // Arrow semantics follow the reading direction so "left" means
                // "earlier" in a right-to-left chapter too.
                const earlier = readingDirection === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
                const later = readingDirection === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
                if (event.key === earlier) {
                  event.preventDefault()
                  move(entry.page.id, -1)
                } else if (event.key === later) {
                  event.preventDefault()
                  move(entry.page.id, 1)
                } else if (event.key === 'x' || event.key === 'X') {
                  event.preventDefault()
                  toggleExcluded(entry.page.id)
                }
              }}
              className={`group relative block w-full overflow-hidden rounded-sm border bg-surface-raised transition-opacity ${
                focused === entry.page.id
                  ? 'border-accent ring-1 ring-[var(--accent)]'
                  : 'border-line'
              } ${entry.excluded ? 'opacity-40' : ''}`}
            >
              {entry.page.thumbUrl ? (
                // Signed, short-lived URL from a private bucket. Not run
                // through next/image: the optimiser would cache a copy of a
                // private page on disk under a stable public path.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.page.thumbUrl}
                  alt={t.pageAlt(index + 1, chapterNumber)}
                  width={entry.page.width}
                  height={entry.page.height}
                  loading="lazy"
                  className="block h-auto w-full"
                />
              ) : (
                <div className="flex aspect-2/3 items-center justify-center text-sm text-muted">
                  {t.noPreview}
                </div>
              )}

              <div className="flex items-center gap-1.5 border-t border-line bg-surface-overlay px-2 py-1.5">
                <span className="font-mono text-xs text-secondary">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {entry.page.isDoubleSpread && (
                  <span
                    title={t.doubleSpreadTitle}
                    className="rounded-sm bg-surface-sunken px-1 text-[0.65rem] text-secondary"
                  >
                    {t.doubleSpreadBadge}
                  </span>
                )}
                {entry.page.textBlockCount > 0 && (
                  <span
                    title={t.textBlocksTitle(entry.page.textBlockCount)}
                    className="rounded-sm bg-surface-sunken px-1 text-[0.65rem] text-secondary"
                  >
                    {entry.page.textBlockCount} txt
                  </span>
                )}

                <span className="ml-auto flex gap-0.5">
                  <button
                    type="button"
                    onClick={() => move(entry.page.id, -1)}
                    disabled={index === 0}
                    aria-label={t.moveEarlier(index + 1)}
                    className="px-1.5 text-secondary hover:text-primary disabled:opacity-30"
                  >
                    {readingDirection === 'rtl' ? '→' : '←'}
                  </button>
                  <button
                    type="button"
                    onClick={() => move(entry.page.id, 1)}
                    disabled={index === draft.length - 1}
                    aria-label={t.moveLater(index + 1)}
                    className="px-1.5 text-secondary hover:text-primary disabled:opacity-30"
                  >
                    {readingDirection === 'rtl' ? '←' : '→'}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleExcluded(entry.page.id)}
                    aria-pressed={entry.excluded}
                    aria-label={t.toggleExcludeAria(index + 1, entry.excluded)}
                    className="px-1.5 text-secondary hover:text-primary"
                  >
                    {entry.excluded ? '+' : '×'}
                  </button>
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
