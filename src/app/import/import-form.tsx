'use client'

import { useActionState, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { importChapterAction, type ImportActionResult } from './actions.ts'

/**
 * The import form.
 *
 * Kept to one screen on purpose. A wizard with steps would be more ceremonious
 * and slower for the thing the user does most: import the next chapter, which
 * is almost always "the number after the last one, same settings as before".
 * The number is prefilled with exactly that.
 */

interface Props {
  suggestedNumber: number
  defaultDirection: 'rtl' | 'ltr'
  maxUploadMb: number
  maxPages: number
}

const ACCEPT = '.pdf,.cbz,.zip,.jpg,.jpeg,.png,.webp,.avif'

export function ImportForm({
  suggestedNumber,
  defaultDirection,
  maxUploadMb,
  maxPages,
}: Props) {
  const [state, submit, pending] = useActionState<ImportActionResult | null, FormData>(
    importChapterAction,
    null,
  )
  const [selected, setSelected] = useState<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const numberId = useId()
  const titleId = useId()
  const volumeId = useId()
  const fileId = useId()

  const totalMb = selected.reduce((sum, f) => sum + f.size, 0) / 1_048_576
  const tooBig = totalMb > maxUploadMb
  const tooMany = selected.length > maxPages

  return (
    <form action={submit} className="mt-10 space-y-8">
      <fieldset disabled={pending} className="space-y-8">
        <div className="grid gap-5 sm:grid-cols-[8rem_1fr_8rem]">
          <label className="block">
            <span className="text-sm font-medium text-primary" id={numberId}>
              Chapitre
            </span>
            <input
              name="chapterNumber"
              type="number"
              min={0}
              step={1}
              required
              defaultValue={suggestedNumber}
              aria-labelledby={numberId}
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-primary" id={titleId}>
              Titre <span className="font-normal text-muted">(facultatif)</span>
            </span>
            <input
              name="title"
              type="text"
              maxLength={200}
              aria-labelledby={titleId}
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-primary" id={volumeId}>
              Tome <span className="font-normal text-muted">(facultatif)</span>
            </span>
            <input
              name="volume"
              type="number"
              min={1}
              step={1}
              aria-labelledby={volumeId}
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>
        </div>

        <fieldset className="rounded-sm border border-line p-4">
          <legend className="px-1.5 text-sm font-medium text-primary">
            Sens de lecture
          </legend>
          {/*
            An explicit setting, never inferred. Getting it wrong reverses
            every conversation on the page, which produces a knowledge graph
            that is confidently backwards rather than obviously broken.
          */}
          <div className="mt-1 flex gap-6">
            {(['rtl', 'ltr'] as const).map((value) => (
              <label key={value} className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="radio"
                  name="readingDirection"
                  value={value}
                  defaultChecked={value === defaultDirection}
                  className="accent-[var(--accent)]"
                />
                {value === 'rtl' ? 'Droite à gauche (manga)' : 'Gauche à droite'}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor={fileId} className="text-sm font-medium text-primary">
            Fichier du chapitre
          </label>
          <p className="mt-1 text-sm text-muted">
            PDF, archive CBZ/ZIP, ou les images de pages. Un PDF avec couche
            texte évite l&apos;OCR : l&apos;extraction est alors exacte et
            gratuite.
          </p>
          <input
            ref={inputRef}
            id={fileId}
            name="file"
            type="file"
            multiple
            required
            accept={ACCEPT}
            onChange={(event) => setSelected(Array.from(event.target.files ?? []))}
            className="mt-3 block w-full cursor-pointer rounded-sm border border-dashed border-line-strong bg-surface-raised px-4 py-6 text-sm text-secondary file:mr-4 file:cursor-pointer file:rounded-sm file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-inverted"
          />

          {selected.length > 0 && (
            <p className="mt-2 text-sm text-secondary">
              {selected.length === 1
                ? selected[0]!.name
                : `${selected.length} fichiers`}{' '}
              — {totalMb.toFixed(1)} Mo
            </p>
          )}

          {tooBig && (
            <p className="mt-2 text-sm text-[var(--epi-contradicted)]">
              Au-delà de la limite de {maxUploadMb} Mo. L&apos;import sera refusé.
            </p>
          )}
          {tooMany && (
            <p className="mt-2 text-sm text-[var(--epi-contradicted)]">
              {selected.length} fichiers, au-delà de la limite de {maxPages} pages.
            </p>
          )}
        </div>

        <button
          type="submit"
          className="rounded-sm bg-accent px-5 py-2.5 text-sm font-medium text-inverted transition-colors hover:bg-accent-strong disabled:opacity-50"
        >
          {pending ? 'Import en cours…' : 'Importer'}
        </button>

        {pending && (
          <p className="text-sm text-muted" role="status">
            Extraction et normalisation des pages. Un chapitre de vingt pages
            prend quelques secondes ; ne fermez pas l&apos;onglet.
          </p>
        )}
      </fieldset>

      {state && !state.ok && state.error && (
        <div
          role="alert"
          className="rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4"
        >
          <p className="font-medium text-primary">{state.error.message}</p>
          {state.error.hint && (
            <p className="mt-1 text-sm text-secondary">{state.error.hint}</p>
          )}
        </div>
      )}

      {state?.ok && state.chapterId && (
        <div
          role="status"
          className="rounded-sm border border-[var(--epi-explicit)] bg-surface-raised p-4"
        >
          <p className="font-medium text-primary">
            {state.replaced ? 'Chapitre remplacé' : 'Chapitre importé'} —{' '}
            {state.pageCount} page{(state.pageCount ?? 0) > 1 ? 's' : ''}.
          </p>
          <p className="mt-1 text-sm text-secondary">
            {state.hasTextLayer
              ? 'Couche texte détectée : la transcription sera exacte, sans OCR ni appel de modèle.'
              : "Pas de couche texte : les pages passeront par l'OCR."}
            {state.unchanged && ' Fichier identique au précédent import.'}
          </p>
          <Link
            href={`/chapitres/${state.chapterId}`}
            className="mt-3 inline-block rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Voir les pages
          </Link>
        </div>
      )}
    </form>
  )
}
