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
  /** Bytes this request can actually carry, in MB — not what the pipeline accepts. */
  maxUploadMb: number
  maxPages: number
  /** True when the ceiling comes from the host and cannot be raised. */
  limitIsHostImposed: boolean
}

const ACCEPT = '.pdf,.cbz,.zip,.jpg,.jpeg,.png,.webp,.avif'

export function ImportForm({
  suggestedNumber,
  defaultDirection,
  maxUploadMb,
  maxPages,
  limitIsHostImposed,
}: Props) {
  const [state, submit, pending] = useActionState<ImportActionResult | null, FormData>(
    importChapterAction,
    null,
  )
  const [selected, setSelected] = useState<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
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

        {/*
         * A drop zone, not a file input.
         *
         * This was `<input type="file">` with a dashed border painted around
         * it: no drop target, no preview, and the selection reported as one
         * line of grey text. Dragging a chapter onto the page is how anyone
         * expects to give a file to a web application, and seeing the files
         * land is how they check they grabbed the right ones before spending
         * money on them.
         */}
        <div>
          <label htmlFor={fileId} className="font-display text-lg uppercase text-primary">
            Le fichier
          </label>

          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              const dropped = Array.from(event.dataTransfer.files)
              if (dropped.length === 0) return
              // The input stays the source of truth: the form posts from it.
              const transfer = new DataTransfer()
              for (const file of dropped) transfer.items.add(file)
              if (inputRef.current) inputRef.current.files = transfer.files
              setSelected(dropped)
            }}
            className={`mt-2 border-[3px] border-dashed p-6 text-center transition-colors ${
              dragging ? 'border-ink bg-[var(--accent-soft)]' : 'border-ink/40 bg-surface-raised'
            }`}
          >
            <p className="font-display text-xl uppercase text-primary">
              Déposez le chapitre ici
            </p>
            <p className="mt-1 text-sm text-muted">
              PDF, archive CBZ/ZIP, ou les images de pages
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="bouton bouton-primaire mt-3"
            >
              Choisir un fichier
            </button>
            <input
              ref={inputRef}
              id={fileId}
              name="file"
              type="file"
              multiple
              required
              accept={ACCEPT}
              onChange={(event) => setSelected(Array.from(event.target.files ?? []))}
              className="sr-only"
            />
            <p className="mt-3 text-xs text-muted">
              Un PDF avec couche texte évite l&apos;OCR : l&apos;extraction est
              alors exacte et gratuite.
            </p>
          </div>

          {selected.length > 0 && (
            <div className="mt-3 border-[3px] border-ink bg-surface-raised">
              <p className="flex items-baseline gap-2 border-b-[3px] border-ink bg-[var(--sea-deep)] px-3 py-1.5 text-white">
                <span className="chiffre text-2xl leading-none">{selected.length}</span>
                <span className="font-display text-sm uppercase">
                  fichier{selected.length > 1 ? 's' : ''}
                </span>
                <span className="tabular ml-auto text-sm">{totalMb.toFixed(1)} Mo</span>
              </p>
              <ul className="max-h-40 overflow-y-auto px-3 py-2 text-sm">
                {selected.slice(0, 40).map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex gap-2 text-secondary">
                    <span className="tabular text-muted">{index + 1}</span>
                    <span className="truncate">{file.name}</span>
                  </li>
                ))}
                {selected.length > 40 && (
                  <li className="text-muted">… et {selected.length - 40} autre(s)</li>
                )}
              </ul>
            </div>
          )}

          {tooBig && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
              {totalMb.toFixed(1)} Mo, au-delà des {maxUploadMb} Mo que cette
              requête peut transporter — l&apos;import échouerait sans message
              exploitable.
              {limitIsHostImposed
                ? " Cette limite vient de l'hébergeur, pas de la configuration : elle n'est pas réglable. Importez depuis une machine qui fait tourner l'application."
                : ' Ajustez MAX_UPLOAD_BYTES si votre machine peut la porter.'}
            </p>
          )}
          {tooMany && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
              {selected.length} fichiers, au-delà de la limite de {maxPages} pages.
            </p>
          )}
        </div>

        <button
          type="submit"
          className="bouton bouton-primaire !text-lg"
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
            href={`/admin/chapitres/${state.chapterId}`}
            className="mt-3 inline-block rounded-sm border border-line-strong px-4 py-2 text-sm font-medium text-primary hover:bg-surface-raised"
          >
            Voir les pages
          </Link>
        </div>
      )}
    </form>
  )
}
