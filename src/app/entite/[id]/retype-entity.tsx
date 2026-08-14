'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { NODE_TYPES } from '@/domains/knowledge/ontology.ts'
import { nodeTypeLabel, predicateLabel } from '@/domains/knowledge/predicate-label.ts'
import type { RetypeConflict } from '@/domains/knowledge/retype.ts'
import { retypeEntityAction } from './actions.ts'

/**
 * Say what this thing is, from the page that says it wrongly.
 *
 * The Bara Bara no Mi is a fruit and the graph called it a power, next to the
 * Bara Bara no Hou, which is the technique — same chapter, same name, and only
 * one of the two is a power. The type was decided by the extraction and there
 * was nowhere at all to disagree with it afterwards.
 *
 * Two things this form does that a plain select would not:
 *
 *   It asks before it costs anything. The ontology types both ends of every
 *   relation, so a new type can make an existing fact impossible — « Baggy
 *   possède le Bara Bara no Mi » is fine for an object and refused for a power,
 *   and the reverse exists too. The first submission writes nothing and comes
 *   back with the list; the button then changes its name to say what it will
 *   do, because « rejeter 3 faits » is not something to discover afterwards.
 *
 *   It refuses rather than cascades. A node carrying an event summary or a
 *   mystery's question cannot become an object, and the message says so — the
 *   alternative would be deleting a sentence nobody asked it to delete.
 *
 * Owner-only and rendered as such, and the action checks ownership again on its
 * own: a button that is not rendered is not a permission.
 */

/**
 * A chapter, a page and a case are the documents themselves — the domain
 * refuses them in both directions, and offering them here would be offering a
 * refusal.
 */
const CHOOSABLE = NODE_TYPES.filter(
  (type) => !['chapter', 'page', 'panel'].includes(type.key),
)

export function RetypeEntity({
  entityId,
  nodeType,
  displayLabel,
}: {
  entityId: string
  nodeType: string
  displayLabel: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [wanted, setWanted] = useState(nodeType)
  const [conflicts, setConflicts] = useState<RetypeConflict[] | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  /*
   * The confirmation belongs to the type it was given for.
   *
   * Reading a list of three facts that « possède » would lose and then picking
   * a different type in the same open form must not carry the agreement over to
   * a change nobody has been shown the cost of.
   */
  function choose(key: string): void {
    setWanted(key)
    setConflicts(null)
    setError(null)
  }

  function submit(confirm: boolean): void {
    setError(null)
    setDone(null)
    start(async () => {
      const response = await retypeEntityAction({
        entityId,
        nodeType: wanted,
        confirm,
      })

      if (!response.ok || !response.result) {
        setError(response.error ?? 'Changement de type impossible.')
        return
      }

      const result = response.result
      if (!result.applied) {
        setConflicts(result.conflicts)
        return
      }

      setDone(
        `« ${displayLabel} » est désormais un ${nodeTypeLabel(
          result.nodeType,
        ).toLowerCase()}.` +
          (result.entityIds.length > 1
            ? ` Les ${result.entityIds.length} nœuds fusionnés en cette entité ont suivi.`
            : '') +
          (result.rejected > 0
            ? ` ${result.rejected} fait(s) que ce type ne permet plus ont été rejetés ;` +
              ` leurs lignes et leurs preuves restent en base.`
            : ''),
      )
      setConflicts(null)
      setOpen(false)
      // The action revalidated the fiche, so its own re-render came back with
      // the response. This is for the header above it, which carries the badge.
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="bouton !py-1 !text-sm"
          title={`Changer le type de « ${displayLabel} », actuellement ${nodeTypeLabel(nodeType)}`}
        >
          Changer le type
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
    <section className="w-full rounded-sm border border-line bg-surface-raised p-4">
      <h2 className="text-lg font-semibold text-primary">Changer le type</h2>
      <p className="mt-1 text-sm text-secondary">
        Pour une classification que le pipeline a devinée de travers : le Bara
        Bara no Mi est un fruit, donc un objet, et le Bara Bara no Hou est le
        pouvoir qu&apos;il donne. Le type décide de ce que l&apos;ontologie
        autorise autour de cette entité&nbsp;: si des faits déjà publiés
        deviennent impossibles, ils vous sont montrés avant tout changement.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="block text-sm">
          <span className="font-medium text-primary">Type</span>
          <select
            value={wanted}
            onChange={(event) => choose(event.target.value)}
            className="mt-1.5 rounded-sm border border-line-strong bg-surface-overlay px-3 py-2 text-primary"
          >
            {CHOOSABLE.map((type) => (
              <option key={type.key} value={type.key}>
                {type.labelFr}
              </option>
            ))}
          </select>
        </label>

        <p className="font-mono text-xs text-muted">
          actuellement {nodeTypeLabel(nodeType)}
        </p>
      </div>

      {CHOOSABLE.find((type) => type.key === wanted)?.description && (
        <p className="mt-2 text-sm text-muted">
          {CHOOSABLE.find((type) => type.key === wanted)!.description}
        </p>
      )}

      {conflicts !== null && conflicts.length > 0 && (
        /* Nothing has been written at this point. The list is what the change
           would cost, said before it is paid. */
        <div className="mt-4 rounded-sm border border-[var(--epi-contradicted)] p-3">
          <p className="text-sm text-[var(--epi-contradicted)]">
            {conflicts.length} fait(s) ne sont pas possibles pour un{' '}
            {nodeTypeLabel(wanted).toLowerCase()}. Continuer les rejettera :
            leurs lignes, leurs preuves et leur provenance restent en base, et
            elles cessent d&apos;être affichées.
          </p>
          <ul className="mt-2 space-y-1.5">
            {conflicts.map((conflict, index) => (
              <li key={`${conflict.assertionId}-${index}`} className="text-sm">
                {/* Written out as the sentence it is: the end at fault is this
                    entity, and the reader is deciding about a fact, not about a
                    row in a table. */}
                <span className="text-primary">
                  {conflict.role === 'subject'
                    ? displayLabel
                    : (conflict.otherLabel ?? 'entité sans nom révélé')}
                </span>{' '}
                <span className="text-accent">
                  {predicateLabel(conflict.predicate)}
                </span>{' '}
                <span className="text-primary">
                  {conflict.role === 'subject'
                    ? (conflict.otherLabel ?? 'entité sans nom révélé')
                    : displayLabel}
                </span>
                <span className="ml-2 font-mono text-xs text-muted">
                  {conflict.role === 'subject' ? 'sujet' : 'objet'} attendu&nbsp;:{' '}
                  {conflict.accepts.map((key) => nodeTypeLabel(key)).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => submit(conflicts !== null && conflicts.length > 0)}
          disabled={pending || wanted === nodeType}
          className="bouton bouton-primaire !py-1.5 !text-sm"
        >
          {pending
            ? 'Enregistrement…'
            : conflicts !== null && conflicts.length > 0
              ? `Changer et rejeter ${conflicts.length} fait(s)`
              : 'Changer le type'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setConflicts(null)
            setWanted(nodeType)
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
