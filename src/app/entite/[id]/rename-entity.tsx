'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { LABEL_KINDS, labelKindLabel, type LabelKind } from '@/domains/knowledge/label-kind.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { SheetLabel } from '@/domains/temporal/entity-sheet.ts'
import { renameEntityAction } from './actions.ts'

/**
 * Correct a name, from the page that shows it.
 *
 * Helmeppo is called Hermep in French, and the graph had no way to be told. The
 * naming question exists in the review queue, at the moment the entity is
 * proposed — miss it there, or change your mind about a convention forty
 * chapters later, and the wrong name was permanent.
 *
 * Three things this form says out loud, because each is a decision the reader
 * would otherwise have to guess at:
 *
 *   The revelation chapter does not move. It is printed next to the field: the
 *   corrected name is known from the chapter that gave the old one, not from
 *   today. Anything else would open a hole in the boundary slider where the
 *   character had no name.
 *
 *   The old wording stays findable. Illustration catalogues and scans are in
 *   English; « Helmeppo » is how the portrait was matched and how a reader will
 *   search. It becomes a search-only name — never displayed, still found — and
 *   the checkbox exists for the case where the old form was simply a typo worth
 *   forgetting.
 *
 *   It will not be asked again. The correction is recorded as vocabulary, so a
 *   later chapter writing « Helmeppo » proposes « Hermep » rather than starting
 *   the same argument.
 *
 * Owner-only, and rendered as such — but the action checks ownership itself,
 * because a button that is not rendered is not a permission.
 */
export function RenameEntity({
  labels,
  displayLabel,
}: {
  labels: SheetLabel[]
  displayLabel: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [labelId, setLabelId] = useState(labels[0]?.id ?? '')
  const [value, setValue] = useState(labels[0]?.label ?? '')
  const [kind, setKind] = useState<LabelKind>((labels[0]?.kind ?? 'alias') as LabelKind)
  const [keepPrevious, setKeepPrevious] = useState(true)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const selected = labels.find((label) => label.id === labelId) ?? labels[0]

  /*
   * The name the entity already carries under the form being typed.
   *
   * A later chapter reproposing « Helmeppo » on a character corrected to
   * « Hermep » at chapter 1 is the ordinary case, not the exotic one, and the
   * outcome — the two rows folded into one name — is worth announcing before
   * the click rather than explaining after it.
   */
  const duplicate = labels.find(
    (label) => label.id !== labelId && normalizeText(label.label) === normalizeText(value),
  )

  if (labels.length === 0) return null

  function choose(id: string): void {
    const label = labels.find((entry) => entry.id === id)
    if (!label) return
    setLabelId(id)
    setValue(label.label)
    setKind(label.kind as LabelKind)
    setError(null)
  }

  function submit(): void {
    setError(null)
    setDone(null)
    start(async () => {
      const response = await renameEntityAction({
        labelId,
        label: value,
        kind,
        keepPrevious,
      })

      if (!response.ok || !response.result) {
        setError(response.error ?? 'Renommage impossible.')
        return
      }

      const result = response.result
      setDone(
        (result.folded
          ? `« ${result.previousLabel} » et « ${result.label} » ne font plus ` +
            `qu'un seul nom, connu depuis le chapitre ${result.revealedInChapter}.`
          : `« ${result.previousLabel} » est désormais « ${result.label} », ` +
            `révélé au chapitre ${result.revealedInChapter}.`) +
          (result.proseRewritten > 0
            ? ` ${result.proseRewritten} événement(s) ou mystère(s) qui l’écrivaient` +
              ` en toutes lettres ont suivi.`
            : '') +
          (result.keptAsAlias
            ? ` L’ancienne forme reste trouvable par la recherche.`
            : '') +
          (result.glossaryTerms > 0
            ? ` Les prochains chapitres recevront ce nom comme acquis.`
            : ''),
      )
      setOpen(false)
      // The action revalidated the fiche, so its own re-render arrived with the
      // response. This is for the header above it, which was rendered by the
      // layout and holds the same name.
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="bouton !py-1 !text-sm"
          title={`Corriger l’orthographe ou la traduction de « ${displayLabel} »`}
        >
          Renommer
        </button>

        {done && (
          <p role="status" className="mt-2 text-sm text-[var(--epi-validated)]">
            {done}
          </p>
        )}
      </div>
    )
  }

  return (
    <section className="mt-4 rounded-sm border border-line bg-surface-raised p-4">
      <h2 className="text-lg font-semibold text-primary">Corriger un nom</h2>
      <p className="mt-1 text-sm text-secondary">
        Pour une traduction que le pipeline a devinée de travers — Helmeppo
        s&apos;appelle Hermep en français — ou une orthographe à reprendre. Le
        chapitre de révélation ne bouge pas&nbsp;: c&apos;est le même nom, mieux
        écrit. Les événements et les mystères qui l&apos;écrivent en toutes
        lettres suivent&nbsp;; le texte du chapitre, lui, n&apos;est jamais
        retouché — c&apos;est ce que la source dit.
      </p>

      {labels.length > 1 && (
        <label className="mt-4 block text-sm">
          <span className="font-medium text-primary">Nom à corriger</span>
          <select
            value={labelId}
            onChange={(event) => choose(event.target.value)}
            className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          >
            {labels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.label} — {labelKindLabel(label.kind)}, ch.{' '}
                {label.revealedInChapter}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-4 flex flex-wrap gap-4">
        <label className="block flex-1 text-sm">
          <span className="font-medium text-primary">Nom correct</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={200}
            autoFocus
            className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium text-primary">Nature</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as LabelKind)}
            className="mt-1.5 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          >
            {LABEL_KINDS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected && (
        <p className="mt-2 font-mono text-xs text-muted">
          révélé ch. {selected.revealedInChapter} — inchangé
        </p>
      )}

      <label className="mt-4 flex items-start gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          checked={keepPrevious}
          onChange={(event) => setKeepPrevious(event.target.checked)}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span>
          Garder «&nbsp;{selected?.label}&nbsp;» comme nom de recherche. À
          conserver pour une traduction&nbsp;: c&apos;est la forme que les
          catalogues d&apos;illustrations et les scans emploient. À décocher pour
          une faute de frappe.
          {duplicate && (
            <>
              {' '}
              Ici, cette ligne fera doublon avec «&nbsp;{duplicate.label}&nbsp;»
              que l&apos;entité porte déjà&nbsp;: les deux seront réunies en un
              seul nom.
            </>
          )}
        </span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending || value.trim().length === 0}
          className="bouton bouton-primaire !py-1.5 !text-sm"
        >
          {pending ? 'Enregistrement…' : 'Renommer'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          disabled={pending}
          className="bouton !py-1.5 !text-sm"
        >
          Annuler
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}
    </section>
  )
}
