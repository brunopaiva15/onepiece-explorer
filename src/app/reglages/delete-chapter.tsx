'use client'

import { useState, useTransition } from 'react'
import type { DeletionPreview, DeletionResult } from '@/domains/chapters/delete.ts'
import type { Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'
import { deleteChapterAction, previewDeletionAction } from './actions.ts'

/**
 * Chapter deletion, in two deliberate steps.
 *
 * Preview first, then a typed confirmation. Not ceremony: the counts in the
 * preview are information the reader cannot get any other way — "eleven facts
 * will stop being verifiable" is not derivable from "delete chapter 40?" — and
 * typing the number rather than clicking a red button is what stops a
 * misdirected click from removing files they may have no other copy of.
 *
 * The confirmation is also checked on the server. A guard that only exists in
 * the browser is a suggestion.
 */

interface Chapter {
  id: string
  number: number
  title: string | null
  pageCount: number
}

export function DeleteChapter({
  chapters,
  locale,
}: {
  chapters: Chapter[]
  locale: Locale
}) {
  const t = getDictFor(locale).settings
  const [selected, setSelected] = useState<string>('')
  const [preview, setPreview] = useState<DeletionPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [keepKnowledge, setKeepKnowledge] = useState(true)
  const [result, setResult] = useState<DeletionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function choose(chapterId: string): void {
    setSelected(chapterId)
    setPreview(null)
    setConfirmation('')
    setResult(null)
    setError(null)

    if (!chapterId) return
    start(async () => {
      const response = await previewDeletionAction(chapterId)
      if (response.ok && response.preview) setPreview(response.preview)
      else setError(response.error ?? t.previewFailed)
    })
  }

  function confirm(): void {
    setError(null)
    start(async () => {
      const response = await deleteChapterAction(selected, confirmation, keepKnowledge)
      if (response.ok && response.result) {
        setResult(response.result)
        setPreview(null)
        setSelected('')
        setConfirmation('')
      } else {
        setError(response.error ?? t.deleteFailed)
      }
    })
  }

  return (
    <div className="mt-4">
      <label className="block text-sm">
        <span className="font-medium text-primary">{t.deleteSelectLabel}</span>
        <select
          value={selected}
          onChange={(event) => choose(event.target.value)}
          className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
        >
          <option value="">—</option>
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              {t.deleteOption(chapter.number, chapter.title, chapter.pageCount)}
            </option>
          ))}
        </select>
      </label>

      {pending && !preview && (
        <p className="mt-2 text-sm text-muted" role="status">
          {t.deleteComputing}
        </p>
      )}

      {preview && (
        <div className="mt-4 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4">
          <p className="font-medium text-primary">
            {t.deleteWillErase(preview.chapterNumber)}
          </p>
          <ul className="mt-2 space-y-0.5 text-sm text-secondary">
            <li>{t.deletePagesObjects(preview.pageCount, preview.storageKeys)}</li>
            <li>{t.deletePanelsBlocks(preview.panelCount, preview.textBlockCount)}</li>
          </ul>

          <p className="mt-3 text-sm text-primary">
            {keepKnowledge ? (
              <>
                {t.deleteKeptLead(preview.assertionsRevealed)}{' '}
                <strong>{t.deleteKeptStrong}</strong>
                {t.deleteKeptTail}
              </>
            ) : (
              <>
                {t.deletePurgedLead(
                  preview.assertionsRevealed,
                  preview.entitiesIntroduced,
                )}{' '}
                <strong>{t.deletePurgedStrong}</strong>
                {t.deletePurgedTail}
              </>
            )}
          </p>

          <label className="mt-3 flex items-start gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={!keepKnowledge}
              onChange={(event) => setKeepKnowledge(!event.target.checked)}
              className="mt-0.5 accent-[var(--epi-contradicted)]"
            />
            <span>{t.deleteAlsoLabel}</span>
          </label>

          <label className="mt-4 block text-sm">
            <span className="text-primary">
              {t.deleteTypeLead} <strong>{preview.chapterNumber}</strong>{' '}
              {t.deleteTypeTail}
            </span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              inputMode="numeric"
              className="mt-1.5 w-24 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-center font-mono text-primary"
            />
          </label>

          <button
            type="button"
            onClick={confirm}
            disabled={pending || confirmation.trim() !== String(preview.chapterNumber)}
            className="mt-4 rounded-sm bg-[var(--epi-contradicted)] px-4 py-2 text-sm font-medium text-inverted disabled:opacity-40"
          >
            {pending ? t.deleting : t.deleteConfirmButton}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}

      {result && (
        <div
          role="status"
          className="mt-4 rounded-sm border border-line bg-surface-raised p-4 text-sm"
        >
          <p className="font-medium text-primary">
            {t.deleteDone(result.chapterNumber)}
          </p>
          <ul className="mt-2 space-y-0.5 text-secondary">
            <li>
              {t.deleteDonePagesObjects(result.pagesDeleted, result.objectsDeleted)}
            </li>
            {result.assertionsOrphaned > 0 && (
              <li>{t.deleteDoneOrphaned(result.assertionsOrphaned)}</li>
            )}
            {result.assertionsStillSourced > 0 && (
              <li>{t.deleteDoneStillSourced(result.assertionsStillSourced)}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
