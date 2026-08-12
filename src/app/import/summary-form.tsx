'use client'

import { useActionState, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  detectLanguage,
  splitPassages,
  type SummaryLanguage,
} from '@/domains/ingestion/passages.ts'
import { importSummaryAction, type SummaryActionResult } from './actions.ts'

/**
 * Import a chapter by writing it out.
 *
 * The form this replaces asked for a file and then explained, in three notes,
 * what would happen to it: OCR, panels, cost. This one asks for the thing the
 * pipeline actually consumes, and can therefore show — before you spend
 * anything — exactly what it will be cut into.
 *
 * The preview is not decoration. `splitPassages` runs here, in the browser, and
 * again on the server at insert time; the same function, so the count shown is
 * the count stored. Passages are the unit of citation, so seeing them is seeing
 * what a fact will be able to point at. A summary written as one unbroken block
 * becomes a handful of coarse passages and the preview says so, which is a
 * better moment to learn it than during review.
 */

interface Props {
  suggestedNumber: number
}

/**
 * Roughly how many passages fit in one extraction call.
 *
 * Mirrors SLICE_PASSAGES in the extraction step. Duplicated rather than
 * imported because that module is server-only, and shown as an approximation
 * for that reason — it answers "one call or several", which is the question,
 * and would be a bad thing to state precisely from a copy that can drift.
 */
const PASSAGES_PER_CALL = 15

export function SummaryForm({ suggestedNumber }: Props) {
  const [state, submit, pending] = useActionState<SummaryActionResult | null, FormData>(
    importSummaryAction,
    null,
  )
  const [text, setText] = useState('')
  const [language, setLanguage] = useState<SummaryLanguage | 'auto'>('auto')

  const numberId = useId()
  const titleId = useId()
  const volumeId = useId()
  const summaryId = useId()

  const trimmed = text.trim()
  const passages = useMemo(() => splitPassages(text), [text])
  const guess = useMemo(
    () => (trimmed.length >= MIN_SUMMARY_CHARS ? detectLanguage(trimmed) : null),
    [trimmed],
  )

  /*
   * An unconfident guess is a question, not a default.
   *
   * The language decides which language every excerpt from this chapter is
   * quoted in. Guessing wrong is invisible afterwards — the excerpts still
   * anchor, the graph still builds, and the only trace is a column nobody
   * reads — so the one moment it can be caught is here, before the paste is
   * stored. `null` means the form has nothing to submit and says so.
   */
  const effective: SummaryLanguage | null =
    language === 'auto' ? (guess?.confident ? guess.language : null) : language
  const mustChooseLanguage = language === 'auto' && guess !== null && !guess.confident

  const tooShort = trimmed.length > 0 && trimmed.length < MIN_SUMMARY_CHARS
  const tooLong = trimmed.length > MAX_SUMMARY_CHARS
  const calls = Math.max(1, Math.ceil(passages.length / PASSAGES_PER_CALL))

  return (
    <form action={submit} className="mt-8 space-y-7">
      <fieldset disabled={pending} className="space-y-7">
        <div className="grid gap-4 sm:grid-cols-[7rem_1fr_7rem]">
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

        <div>
          <label
            htmlFor={summaryId}
            className="font-display text-lg uppercase text-primary"
          >
            Le chapitre, raconté
          </label>
          <textarea
            id={summaryId}
            name="summary"
            required
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_SUMMARY_CHARS}
            rows={16}
            spellCheck
            placeholder={
              'Collez ici le résumé le plus détaillé que vous ayez du chapitre.\n\n' +
              'Un paragraphe par scène. Les noms tels que le chapitre les donne — ' +
              "et seulement ceux qu'il donne.\n\n" +
              'Chaque fait du graphe devra citer une phrase de ce texte : ' +
              "ce qui n'y est pas écrit n'entrera pas."
            }
            className="mt-2 w-full resize-y border-[3px] border-ink bg-surface-raised px-3 py-2.5 font-sans text-primary placeholder:text-muted/70"
            style={{ boxShadow: 'var(--shadow-hard)' }}
          />

          {/*
           * Counts as figures, live.
           *
           * What it costs is a function of how much you paste, and this is the
           * one moment where that is still adjustable. A number that moves as
           * you type says it better than a paragraph explaining slicing.
           */}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="flex items-baseline gap-1.5">
              <span className="chiffre text-2xl">{trimmed.length}</span>
              <span className="cartouche">caractères</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="chiffre text-2xl">{passages.length}</span>
              <span className="cartouche">passages citables</span>
            </span>
            <span className="flex items-baseline gap-1.5" title="Une tranche d'extraction par groupe de passages">
              <span className="chiffre text-2xl">{passages.length === 0 ? 0 : calls}</span>
              <span className="cartouche">appel{calls > 1 ? 's' : ''} au modèle</span>
            </span>
          </div>

          {tooShort && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink">
              Encore {MIN_SUMMARY_CHARS - trimmed.length} caractères. Un résumé
              trop court produit un graphe vide : chaque fait doit pouvoir citer
              une phrase.
            </p>
          )}
          {tooLong && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
              Au-delà de {MAX_SUMMARY_CHARS} caractères. Coupez le texte, ou
              importez-le en deux chapitres.
            </p>
          )}
        </div>

        {/* --- Language ---------------------------------------------------- */}
        <fieldset className="rounded-sm border border-line p-4">
          <legend className="px-1.5 text-sm font-medium text-primary">
            Langue de la source
          </legend>
          <div className="mt-1 flex flex-wrap gap-5">
            {(
              [
                ['auto', 'Détecter'],
                ['fr', 'Français'],
                ['en', 'English'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="radio"
                  name="languageChoice"
                  value={value}
                  checked={language === value}
                  onChange={() => setLanguage(value)}
                  className="accent-[var(--accent)]"
                />
                {label}
                {value === 'auto' && guess?.confident && (
                  <span className="badge badge-gris">{guess.language}</span>
                )}
              </label>
            ))}
          </div>
          {/* The resolved value is what the action reads; the radio above is a
              control over it, not the field itself. */}
          <input type="hidden" name="language" value={effective ?? ''} />

          {mustChooseLanguage && (
            <p
              role="status"
              className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink"
            >
              Je n&apos;arrive pas à trancher — {guess.french} marqueurs
              français contre {guess.english} anglais, c&apos;est trop serré
              pour décider à votre place. Choisissez ci-dessus.
            </p>
          )}

          <p className="mt-2 text-sm text-muted">
            Le graphe reste en français quelle que soit la réponse. Seuls les
            extraits cités gardent la langue de la source&nbsp;: une citation est
            une copie, vérifiée caractère par caractère — la traduire la
            rendrait invérifiable.
          </p>
        </fieldset>

        <button
          type="submit"
          disabled={tooShort || tooLong || mustChooseLanguage}
          className="bouton bouton-primaire !text-lg"
        >
          {pending ? 'Enregistrement…' : 'Importer le chapitre'}
        </button>
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
            {state.unchanged
              ? 'Texte identique au précédent import — rien n’a été réécrit.'
              : state.replaced
                ? 'Chapitre remplacé'
                : 'Chapitre importé'}{' '}
            — {state.passageCount} passage{(state.passageCount ?? 0) > 1 ? 's' : ''}
            {state.language === 'en' && ', source en anglais'}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/chapitres/${state.chapterId}`} className="bouton !py-1.5 !text-sm">
              Voir le chapitre
            </Link>
          </div>
        </div>
      )}
    </form>
  )
}
