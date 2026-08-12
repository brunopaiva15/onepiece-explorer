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
import { type Locale } from '@/lib/i18n/index.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'
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
  locale: Locale
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

export function SummaryForm({ suggestedNumber, locale }: Props) {
  const t = getDictFor(locale).importer
  const [state, submit, pending] = useActionState<SummaryActionResult | null, FormData>(
    importSummaryAction,
    null,
  )
  const [text, setText] = useState('')
  /*
   * The same chapter in the other language, held beside the text rather than
   * inside it. It is not part of the source: nothing cites it, and it is sent
   * to the model only so that a French name can be read off a translation
   * instead of guessed one chapter at a time.
   */
  const [parallel, setParallel] = useState('')
  const [language, setLanguage] = useState<SummaryLanguage | 'auto'>('auto')
  const [autoRun, setAutoRun] = useState(true)
  /*
   * The number to offer next, held here rather than recomputed from the server.
   *
   * There are more than a thousand chapters to enter, and the loop is: paste,
   * submit, paste the next one. Reloading the page between each to pick up a
   * fresh suggestion would be the slowest part of the whole product. After a
   * successful import the form clears itself and advances, so the next paste
   * needs no clicks at all.
   */
  const [nextNumber, setNextNumber] = useState(suggestedNumber)
  const [lastImport, setLastImport] = useState<SummaryActionResult | null>(null)

  const numberId = useId()
  const titleId = useId()
  const volumeId = useId()
  const summaryId = useId()

  /*
   * Clear and advance the moment an import lands.
   *
   * Adjusted during render rather than in an effect: React re-renders straight
   * away with the new values, so the emptied field is never painted holding the
   * text that was just stored. `useActionState` hands back a new object per
   * submission, which is what makes the identity check a reliable "this is a
   * result I have not reacted to yet".
   */
  if (state?.ok && state !== lastImport) {
    setLastImport(state)
    setText('')
    setParallel('')
    setLanguage('auto')
    setNextNumber((current) => current + 1)
  }

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

  /*
   * The other-language version, and the one mistake it can carry.
   *
   * Its language is not asked for: there are two, and the pair is the point.
   * What is checked is that it is not the *same* one — the same summary pasted
   * into both boxes teaches the model nothing about names and doubles what
   * every slice costs. Checked here as well as on the server so the answer
   * arrives while the paste is still on screen.
   */
  const parallelTrimmed = parallel.trim()
  const parallelGuess = useMemo(
    () =>
      parallelTrimmed.length >= MIN_SUMMARY_CHARS ? detectLanguage(parallelTrimmed) : null,
    [parallelTrimmed],
  )
  const parallelTooShort =
    parallelTrimmed.length > 0 && parallelTrimmed.length < MIN_SUMMARY_CHARS
  const parallelTooLong = parallelTrimmed.length > MAX_SUMMARY_CHARS
  const parallelSameLanguage =
    effective !== null &&
    parallelGuess !== null &&
    parallelGuess.confident &&
    parallelGuess.language === effective
  const otherLanguage = effective === null ? null : effective === 'fr' ? 'en' : 'fr'

  return (
    <form action={submit} className="mt-8 space-y-7">
      <fieldset disabled={pending} className="space-y-7">
        <div className="grid gap-4 sm:grid-cols-[7rem_1fr_7rem]">
          <label className="block">
            <span className="text-sm font-medium text-primary" id={numberId}>
              {t.labelChapter}
            </span>
            <input
              name="chapterNumber"
              type="number"
              min={0}
              step={1}
              required
              value={nextNumber}
              onChange={(event) => setNextNumber(Number(event.target.value))}
              aria-labelledby={numberId}
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-primary" id={titleId}>
              {t.labelTitle} <span className="font-normal text-muted">{t.optionalTag}</span>
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
              {t.labelVolume} <span className="font-normal text-muted">{t.optionalTag}</span>
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
            {t.summaryLabel}
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
            placeholder={t.summaryPlaceholder}
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
              <span className="cartouche">{t.unitCharacters}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="chiffre text-2xl">{passages.length}</span>
              <span className="cartouche">{t.unitCitablePassages}</span>
            </span>
            <span className="flex items-baseline gap-1.5" title={t.modelCallsTitle}>
              <span className="chiffre text-2xl">{passages.length === 0 ? 0 : calls}</span>
              <span className="cartouche">{t.modelCalls(calls)}</span>
            </span>
          </div>

          {tooShort && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink">
              {t.tooShort(MIN_SUMMARY_CHARS - trimmed.length)}
            </p>
          )}
          {tooLong && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
              {t.tooLong(MAX_SUMMARY_CHARS)}
            </p>
          )}
        </div>

        {/* --- Language ---------------------------------------------------- */}
        <fieldset className="rounded-sm border border-line p-4">
          <legend className="px-1.5 text-sm font-medium text-primary">
            {t.languageLegend}
          </legend>
          <div className="mt-1 flex flex-wrap gap-5">
            {(
              [
                ['auto', t.languageAuto],
                ['fr', t.languageFr],
                ['en', t.languageEn],
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
              {t.mustChooseLanguage(guess.french, guess.english)}
            </p>
          )}

          <p className="mt-2 text-sm text-muted">
            {t.languageNote}
          </p>
        </fieldset>

        {/* --- The same chapter, in the other language --------------------- */}
        <details className="rounded-sm border border-line p-4">
          <summary className="cursor-pointer text-sm font-medium text-primary">
            {t.parallelSummaryTitle}
            <span className="font-normal text-muted"> {t.optionalTag}</span>
            {parallelTrimmed.length > 0 && (
              <span className="badge badge-gris ml-2">
                {otherLanguage ?? t.parallelBadgeFallback}
              </span>
            )}
          </summary>

          <p className="mt-3 max-w-3xl text-sm text-secondary">
            {t.parallelIntro}{' '}
            <strong>{t.parallelIntroStrong}</strong>{t.parallelIntroRest}
          </p>

          <textarea
            name="parallelSummary"
            // Labelled here rather than by a <label>: the visible name sits in
            // the <summary> of the disclosure, which cannot label a control.
            aria-label={t.parallelSummaryTitle}
            value={parallel}
            onChange={(event) => setParallel(event.target.value)}
            maxLength={MAX_SUMMARY_CHARS}
            rows={8}
            spellCheck
            placeholder={
              otherLanguage === 'fr'
                ? t.parallelPlaceholderFr
                : otherLanguage === 'en'
                  ? t.parallelPlaceholderEn
                  : t.parallelPlaceholderOther
            }
            className="mt-3 w-full resize-y rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 font-sans text-primary placeholder:text-muted/70"
          />

          {parallelTrimmed.length > 0 && (
            <p className="mt-2 text-sm text-muted">
              {t.parallelChars(parallelTrimmed.length)}
            </p>
          )}

          {parallelTooShort && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink">
              {t.parallelTooShort(MIN_SUMMARY_CHARS - parallelTrimmed.length)}
            </p>
          )}
          {parallelTooLong && (
            <p className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white">
              {t.parallelTooLong(MAX_SUMMARY_CHARS)}
            </p>
          )}
          {parallelSameLanguage && (
            <p
              role="alert"
              className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white"
            >
              {t.parallelSameLanguage}
            </p>
          )}
        </details>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            disabled={
              tooShort ||
              tooLong ||
              mustChooseLanguage ||
              parallelTooShort ||
              parallelTooLong ||
              parallelSameLanguage
            }
            className="bouton bouton-primaire !text-lg"
          >
            {pending
              ? autoRun
                ? t.submitPendingRun
                : t.submitPendingOnly
              : autoRun
                ? t.submitRun
                : t.submitOnly}
          </button>

          {/*
           * On by default, because the alternative is eleven hundred trips
           * through a chapter page to press a second button. Still a choice:
           * re-pasting a corrected summary is a case where you may want the
           * text stored without paying to analyse it again straight away.
           */}
          <label className="flex items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              name="autoRun"
              value="on"
              checked={autoRun}
              onChange={(event) => setAutoRun(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            {t.autoRunLabel}
          </label>
        </div>
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
              ? t.successUnchanged
              : state.replaced
                ? t.successReplaced
                : t.successImported}{' '}
            — {t.successPassages(state.passageCount ?? 0)}
            {state.language === 'en' && t.successEnglishSource}.
          </p>
          {state.runError && (
            <p className="mt-2 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink">
              {t.runNotStarted}{' '}
              {state.runError}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {state.runId && (
              <Link href={`/runs/${state.runId}`} className="bouton bouton-primaire !py-1.5 !text-sm">
                {t.followRun}
              </Link>
            )}
            <Link href={`/chapitres/${state.chapterId}`} className="bouton !py-1.5 !text-sm">
              {t.viewChapter}
            </Link>
          </div>

          <p className="mt-3 text-sm text-muted">
            {t.readyForNext(nextNumber)}
          </p>
        </div>
      )}
    </form>
  )
}
