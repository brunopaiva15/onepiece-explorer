'use client'

import { useId, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  splitPassages,
} from '@/domains/ingestion/passages.ts'
import { MAX_RANGE_LENGTH } from '@/domains/ingestion/fandom.ts'
import {
  fetchFandomRangeAction,
  importBatchAction,
  type BatchActionResult,
  type FandomRangeEntryResult,
} from './actions.ts'

/**
 * Ten chapters, fetched together and processed in order.
 *
 * The screen is built around the one thing that would otherwise be invisible:
 * these chapters do not all run now. The first one does; the rest wait for the
 * chapter before them to be published, because entity resolution can only match
 * a proposal against what is already in the graph — and an alias named one
 * chapter later is a question only it can raise. Told once, plainly, next to the
 * button — not discovered later from a queue that seems stuck.
 *
 * What comes back from the wiki is shown as text you can still correct. Ten
 * chapters is more than anyone reads word by word, so the figures do the
 * reading: characters, passages, whether the naming aid arrived. A chapter with
 * nothing behind it says so and is simply not submitted.
 */

interface Editable {
  chapterNumber: number
  /** Empty when the wiki had nothing; the row then shows its reason instead. */
  text: string
  parallelText: string
  language: 'fr' | 'en' | null
  url: string | null
  /** Chapter notes folded into `text`. Zero when the page has no such section. */
  noteLines: number
  problems: string[]
  error: string | null
  /** Unticked rows are not imported. */
  include: boolean
}

function toEditable(entry: FandomRangeEntryResult): Editable {
  return {
    chapterNumber: entry.chapterNumber,
    text: entry.primary?.text ?? '',
    parallelText: entry.parallel?.text ?? '',
    language: entry.primary?.language ?? null,
    url: entry.primary?.url ?? null,
    noteLines: entry.primary?.noteLines ?? 0,
    problems: entry.problems ?? [],
    error: entry.error ?? null,
    include: entry.primary !== undefined,
  }
}

export function BatchForm({ suggestedNumber }: { suggestedNumber: number }) {
  const [from, setFrom] = useState(String(suggestedNumber))
  const [to, setTo] = useState(String(suggestedNumber + 9))
  const [entries, setEntries] = useState<Editable[] | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [result, setResult] = useState<BatchActionResult | null>(null)
  const [fetching, startFetching] = useTransition()
  const [importing, startImporting] = useTransition()

  const fromId = useId()
  const toId = useId()

  function retrieve(): void {
    setResult(null)
    setFetchError(null)
    startFetching(async () => {
      const fetched = await fetchFandomRangeAction(from, to)
      if (!fetched.ok || !fetched.entries) {
        setFetchError(fetched.error ?? 'Récupération impossible.')
        setEntries(null)
        return
      }
      setEntries(fetched.entries.map(toEditable))
    })
  }

  function update(chapterNumber: number, patch: Partial<Editable>): void {
    setEntries(
      (current) =>
        current?.map((entry) =>
          entry.chapterNumber === chapterNumber ? { ...entry, ...patch } : entry,
        ) ?? null,
    )
  }

  const selected = useMemo(
    () =>
      (entries ?? []).filter(
        (entry) =>
          entry.include &&
          entry.text.trim().length >= MIN_SUMMARY_CHARS &&
          entry.text.trim().length <= MAX_SUMMARY_CHARS,
      ),
    [entries],
  )

  function submit(): void {
    if (selected.length === 0) return
    startImporting(async () => {
      const outcome = await importBatchAction(
        selected.map((entry) => ({
          chapterNumber: entry.chapterNumber,
          text: entry.text,
          ...(entry.parallelText.trim().length > 0
            ? { parallelText: entry.parallelText }
            : {}),
          ...(entry.language ? { language: entry.language } : {}),
        })),
      )
      setResult(outcome)
      if (outcome.ok) setEntries(null)
    })
  }

  return (
    <section className="mt-8">
      <div
        className="border-[3px] border-ink bg-surface-raised p-4"
        style={{ boxShadow: 'var(--shadow-hard)' }}
      >
        <h2 className="font-display text-lg uppercase text-primary">
          Récupérer plusieurs chapitres
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-secondary">
          Jusqu’à {MAX_RANGE_LENGTH} d’un coup. Ils sont tous stockés&nbsp;; le
          premier est traité tout de suite et <strong>chacun des suivants démarre
          à la publication du précédent</strong>. C’est ce qui permet au chapitre
          13 de vous demander si « Kaelo Renn » est l’homme au tablier de cuir
          rencontré au 12 — question qui ne se pose qu’une fois, et seulement
          contre ce qui est déjà dans le graphe.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-sm font-medium text-primary" id={fromId}>
              Du chapitre
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              aria-labelledby={fromId}
              className="mt-1.5 w-28 border-[3px] border-ink bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-primary" id={toId}>
              au
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-labelledby={toId}
              className="mt-1.5 w-28 border-[3px] border-ink bg-surface-overlay px-3 py-2 text-primary"
            />
          </label>
          <button
            type="button"
            onClick={retrieve}
            disabled={fetching || from.trim().length === 0 || to.trim().length === 0}
            className="bouton bouton-primaire"
          >
            {fetching ? 'Récupération…' : 'Récupérer'}
          </button>
        </div>

        {fetchError && (
          <p
            role="alert"
            className="mt-3 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-sm text-white"
          >
            {fetchError}
          </p>
        )}
      </div>

      {entries && entries.length > 0 && (
        <div className="mt-6">
          <ul className="divide-y divide-[var(--border)] border-y border-line">
            {entries.map((entry) => (
              <BatchRow
                key={entry.chapterNumber}
                entry={entry}
                onChange={(patch) => update(entry.chapterNumber, patch)}
              />
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={submit}
              disabled={importing || selected.length === 0}
              className="bouton bouton-primaire !text-lg"
            >
              {importing
                ? 'Import…'
                : `Importer ${selected.length} chapitre${selected.length > 1 ? 's' : ''}`}
            </button>
            {selected.length > 0 && (
              <p className="text-sm text-muted">
                Le {selected[0]!.chapterNumber} est traité maintenant
                {selected.length > 1 &&
                  `, les ${selected.length - 1} autres à la publication du précédent`}
                .
              </p>
            )}
          </div>
        </div>
      )}

      {entries && entries.length === 0 && (
        <p className="mt-4 text-sm text-muted">Rien à afficher pour cet intervalle.</p>
      )}

      {result && <BatchOutcome result={result} />}
    </section>
  )
}

function BatchRow({
  entry,
  onChange,
}: {
  entry: Editable
  onChange: (patch: Partial<Editable>) => void
}) {
  const trimmed = entry.text.trim()
  const passages = useMemo(() => splitPassages(entry.text), [entry.text])
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_SUMMARY_CHARS
  const tooLong = trimmed.length > MAX_SUMMARY_CHARS
  const empty = trimmed.length === 0

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={entry.include}
            disabled={empty || tooShort || tooLong}
            onChange={(event) => onChange({ include: event.target.checked })}
            className="accent-[var(--accent)]"
            aria-label={`Importer le chapitre ${entry.chapterNumber}`}
          />
          <span className="chiffre text-lg">{entry.chapterNumber}</span>
        </label>

        {empty ? (
          <span className="text-sm text-[var(--coral)]">
            {entry.error ?? 'Aucun résumé.'}
          </span>
        ) : (
          <>
            <span className="badge badge-gris">{entry.language}</span>
            <span className="text-sm text-secondary">
              {trimmed.length} caractères · {passages.length} passage
              {passages.length > 1 ? 's' : ''}
            </span>
            <span className="text-sm text-muted">
              {entry.noteLines > 0
                ? `${entry.noteLines} note${entry.noteLines > 1 ? 's' : ''} de chapitre`
                : 'pas de notes'}
            </span>
            <span className="text-sm text-muted">
              {entry.parallelText.trim().length > 0
                ? 'version en regard pour les noms'
                : 'pas de seconde langue'}
            </span>
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm text-accent hover:underline"
              >
                wiki
              </a>
            )}
          </>
        )}
      </div>

      {tooShort && (
        <p className="mt-2 text-sm text-[var(--coral)]">
          Trop court pour être une source ({MIN_SUMMARY_CHARS} caractères
          minimum) — ce chapitre ne sera pas importé.
        </p>
      )}
      {tooLong && (
        <p className="mt-2 text-sm text-[var(--coral)]">
          Au-delà de {MAX_SUMMARY_CHARS} caractères — ce chapitre ne sera pas
          importé.
        </p>
      )}
      {entry.problems.length > 0 && !empty && (
        <ul className="mt-1 list-disc pl-6 text-sm text-muted">
          {entry.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {!empty && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-accent">
            Relire ou corriger le texte
          </summary>
          <textarea
            value={entry.text}
            onChange={(event) => onChange({ text: event.target.value })}
            maxLength={MAX_SUMMARY_CHARS}
            rows={10}
            spellCheck
            aria-label={`Texte du chapitre ${entry.chapterNumber}`}
            className="mt-2 w-full resize-y rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 font-sans text-primary"
          />
          <label className="mt-2 block text-sm text-secondary">
            Le même chapitre dans l’autre langue — pour les noms, jamais comme
            preuve.
            <textarea
              value={entry.parallelText}
              onChange={(event) => onChange({ parallelText: event.target.value })}
              maxLength={MAX_SUMMARY_CHARS}
              rows={5}
              spellCheck
              className="mt-1.5 w-full resize-y rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 font-sans text-primary"
            />
          </label>
        </details>
      )}
    </li>
  )
}

function BatchOutcome({ result }: { result: BatchActionResult }) {
  if (!result.outcomes) {
    return (
      <div
        role="alert"
        className="mt-4 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-4"
      >
        <p className="font-medium text-primary">{result.error?.message}</p>
        {result.error?.hint && (
          <p className="mt-1 text-sm text-secondary">{result.error.hint}</p>
        )}
      </div>
    )
  }

  const failed = result.outcomes.filter((outcome) => !outcome.ok)

  return (
    <div
      role="status"
      className="mt-4 rounded-sm border border-[var(--epi-explicit)] bg-surface-raised p-4"
    >
      <p className="font-medium text-primary">
        {result.outcomes.filter((outcome) => outcome.ok).length} chapitre(s)
        importé(s) · {result.queuedCount ?? 0} en attente de leur tour.
      </p>

      {result.runError && (
        <p className="mt-2 border-[3px] border-ink bg-[var(--accent)] px-3 py-2 text-sm text-ink">
          Les textes sont enregistrés, mais le premier traitement n’a pas
          démarré&nbsp;: {result.runError}
        </p>
      )}

      {result.runId && (
        <div className="mt-3">
          <Link href={`/runs/${result.runId}`} className="bouton bouton-primaire !py-1.5 !text-sm">
            Suivre le premier traitement
          </Link>
        </div>
      )}

      {failed.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {failed.map((outcome) => (
            <li key={outcome.chapterNumber} className="text-[var(--coral)]">
              Chapitre {outcome.chapterNumber} : {outcome.error?.message}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-sm text-muted">
        Chaque chapitre en attente démarre à la publication du précédent. Rien
        n’entre dans le graphe sans votre accord, comme pour un import unique.
      </p>
    </div>
  )
}
