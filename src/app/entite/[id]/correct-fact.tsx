'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { EntityCandidate } from '@/domains/knowledge/candidates.ts'
import {
  alternativesFor,
  IDENTITY_PREDICATES,
  PREDICATE_BY_KEY,
} from '@/domains/knowledge/ontology.ts'
import { nodeTypeLabel, predicateLabel } from '@/domains/knowledge/predicate-label.ts'
import type { SheetFact } from '@/domains/temporal/entity-sheet.ts'
import { factTargetsAction, retractFactAction, reviseFactAction } from './actions.ts'

/**
 * Disagree with a fact, on the page that states it.
 *
 * « Baggy appartient à l'Équipage du Roux », affirmed, chapter 19, quoting a
 * flashback about the two of them sailing together — as cabin boys on Roger's
 * ship, in a crew Shanks has not founded yet. The fiche could rename the
 * entity and retype it and had nothing whatever to say about the sentence
 * printed between the two.
 *
 * Three corrections, because a fact goes wrong in three places, and the form
 * shows only the ones this fact has:
 *
 *   The relation. « appartient à » where « connaît » was meant. Only predicates
 *   the ontology accepts between these two types are offered — the others would
 *   be refused by the database on the way in (ADR 0004), and finding that out
 *   after clicking is what the review board's mismatch notice exists to spare.
 *
 *   The other end. Searched rather than typed, at the chapter the fiche is being
 *   read at: a target from four hundred chapters ahead is not an option, and
 *   when the right one does not exist yet — the Équipage de Roger, at chapter
 *   19 — the honest answer is the third gesture, not a worse target.
 *
 *   The wording, for a fact carrying a literal rather than a node.
 *
 * And « ce fait est faux », which replaces nothing. It asks twice: the record
 * keeps the row and its evidence, but the claim leaves every page at once and
 * nothing on the fiche will offer it back.
 *
 * Owner-only and rendered as such; all three actions check ownership again on
 * their own, because a button that is not rendered is not a permission.
 */
/** Widened once: the ontology types this as its own literals. */
const IDENTITY = new Set<string>(IDENTITY_PREDICATES)

export function CorrectFact({
  fact,
  entityIds,
  entityLabel,
  entityNodeType,
  boundary,
}: {
  fact: SheetFact
  /**
   * Every row this fiche is: a merged entity is several, and a fact read from
   * here hangs off whichever one the chapter proposed.
   */
  entityIds: string[]
  /** This fiche's entity, as the sentence names it. */
  entityLabel: string
  entityNodeType: string
  boundary: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [predicate, setPredicate] = useState(fact.predicate)
  const [value, setValue] = useState(fact.literalValue ?? '')
  const [query, setQuery] = useState('')
  /*
   * The answers, with the question they answer.
   *
   * Kept together so a list can never outlive its query: the reader who types
   * one more letter must not be shown, for a beat, the entities that matched
   * the shorter word — and picking one of those is a correction aimed at
   * something they did not search for.
   */
  const [results, setResults] = useState<{ query: string; items: EntityCandidate[] } | null>(
    null,
  )
  const [target, setTarget] = useState<EntityCandidate | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const [searching, startSearch] = useTransition()

  /*
   * Which end is which, from the direction the sheet computed.
   *
   * An incoming fact — « Baggy appartient à ceci », read on the crew's page — is
   * the same row seen from the other side. Its object is *this* entity, so the
   * end a correction moves is the same end in both cases, and only the sentence
   * changes.
   */
  const outgoing = fact.direction === 'outgoing'
  const subjectType = outgoing ? entityNodeType : fact.otherType
  const objectType = outgoing ? fact.otherType : entityNodeType
  const subjectLabel = outgoing ? entityLabel : (fact.otherLabel ?? 'cette entité')
  const objectLabel = outgoing
    ? (fact.otherLabel ?? fact.literalValue ?? 'cette entité')
    : entityLabel
  /*
   * The end a correction moves, whichever side the fiche is on. Read from the
   * crew's page, « Baggy appartient à ceci » has *this* entity as its object,
   * so replacing the object is how the reader says « ce n'est pas de nous
   * qu'il s'agit » — and every row this fiche is made of is then a non-answer,
   * merged halves included.
   */
  const notAnAnswer = outgoing
    ? fact.otherId === null
      ? []
      : [fact.otherId]
    : entityIds

  // An incoming fact is one this entity is the object of, so it always has one.
  const pointsAtEntity = outgoing ? fact.otherId !== null : true
  /*
   * Every relation the ontology accepts here, minus the ones that fold two
   * entities into one.
   *
   * `same_as` is not a relation between two things, it is the statement that
   * there are not two things — the projection runs a union-find over it and the
   * whole graph re-reads itself. That belongs to the review queue's
   * rapprochement card, which shows both sides and what merging costs. Turning
   * « connaît » into it from a one-line select would be a merge nobody was
   * shown. The reverse gesture is still here: a wrong merge is a fact like any
   * other on this list, and « ce fait est faux » unmakes it.
   */
  const relations =
    subjectType === null
      ? []
      : alternativesFor(subjectType, objectType ?? null).filter(
          (entry) => !IDENTITY.has(entry.key),
        )
  /*
   * The current relation belongs in its own list. It can be missing from the
   * alternatives — a fact published before a retype, or under an ontology since
   * edited — and a `select` whose value matches no option shows the reader the
   * first one instead, which is a silent proposal to change something they did
   * not ask about.
   */
  const relationOptions = relations.some((entry) => entry.key === fact.predicate)
    ? relations
    : [{ key: fact.predicate, labelFr: predicateLabel(fact.predicate) }, ...relations]
  const accepts = PREDICATE_BY_KEY.get(predicate)?.objectTypes ?? []

  const asked = query.trim()
  const candidates = results !== null && results.query === asked ? results.items : null

  useEffect(() => {
    if (!open || !pointsAtEntity || asked.length < 2) return undefined

    /*
     * Searched as you type, one request per pause.
     *
     * The timer is cleared by the cleanup on every keystroke, so a name typed
     * in one go costs one round trip rather than one per letter — and the
     * result that lands is always the last query asked for, because no earlier
     * one was ever sent.
     */
    const timer = setTimeout(() => {
      startSearch(async () => {
        const response = await factTargetsAction({
          query: asked,
          boundary,
          accepts: [...accepts],
          exclude: notAnAnswer,
        })
        setResults({ query: asked, items: response.ok ? (response.candidates ?? []) : [] })
        if (!response.ok) setError(response.error ?? 'Recherche impossible.')
      })
    }, 300)

    return () => clearTimeout(timer)
    // `accepts` and `notAnAnswer` are derived from `predicate` and from props
    // already in the list; naming the arrays themselves would re-run this on
    // every render, since each is a new reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, open, predicate, boundary, pointsAtEntity])

  function reset(): void {
    setPredicate(fact.predicate)
    setValue(fact.literalValue ?? '')
    setQuery('')
    setResults(null)
    setTarget(null)
    setConfirming(false)
    setError(null)
  }

  const changesRelation = predicate !== fact.predicate
  const changesTarget = target !== null
  const changesValue = !pointsAtEntity && value.trim() !== (fact.literalValue ?? '')
  const changed = changesRelation || changesTarget || changesValue

  function save(): void {
    setError(null)
    setDone(null)
    start(async () => {
      const response = await reviseFactAction({
        assertionId: fact.assertionId,
        predicate: changesRelation ? predicate : undefined,
        objectEntityId: changesTarget ? target.entityId : undefined,
        objectValue: changesValue ? value.trim() : undefined,
      })

      if (!response.ok || !response.result) {
        setError(response.error ?? 'Correction impossible.')
        return
      }

      const result = response.result
      setDone(
        result.alreadyDone
          ? 'Ce fait avait déjà été corrigé ailleurs.'
          : `Corrigé : ${subjectLabel} ${predicateLabel(result.predicate)} ` +
            `${target?.label ?? result.value ?? objectLabel}. La ligne d’origine et ` +
            `ses preuves restent en base, remplacées par la vôtre.`,
      )
      setOpen(false)
      reset()
      // The action revalidated this fiche, so its re-render came back with the
      // response. This is for the header above it and for the summary sections,
      // which were rendered by the layout and read the same facts.
      router.refresh()
    })
  }

  function retract(): void {
    setError(null)
    setDone(null)
    start(async () => {
      const response = await retractFactAction({ assertionId: fact.assertionId })

      if (!response.ok || !response.result) {
        setError(response.error ?? 'Retrait impossible.')
        return
      }

      setDone(
        'Fait retiré. Il ne paraît plus nulle part ; sa ligne, ses preuves et sa ' +
          'provenance restent en base, et un réimport du chapitre ne le ' +
          'reproposera pas.',
      )
      setOpen(false)
      reset()
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => {
            reset()
            setDone(null)
            setOpen(true)
          }}
          className="bouton !py-0.5 !text-xs"
          title="Ce fait est faux, ou parle d’autre chose"
        >
          Corriger
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
    <section className="mt-3 rounded-sm border border-line-strong bg-surface-overlay p-3">
      <h4 className="font-semibold text-primary">Corriger ce fait</h4>
      <p className="mt-1 text-sm text-secondary">
        Le chapitre où vous l&apos;avez appris ne bouge pas, et la preuve citée
        non plus&nbsp;: c&apos;est la même page, mal lue. Votre version remplace
        celle du modèle et sera marquée comme vôtre : un réimport du chapitre ne
        la défera pas.
      </p>

      <p className="mt-2 font-mono text-xs text-muted">
        {subjectLabel} · {predicateLabel(fact.predicate)} · {objectLabel}
      </p>

      {relationOptions.length > 1 && (
        <label className="mt-3 block text-sm">
          <span className="font-medium text-primary">Relation</span>
          <select
            value={predicate}
            onChange={(event) => {
              setPredicate(event.target.value)
              // The target was chosen under the old relation, which may accept
              // other types than the new one does. Asking again is cheaper than
              // sending a pair the database will refuse.
              setTarget(null)
              setResults(null)
              setError(null)
            }}
            className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-primary"
          >
            {relationOptions.map((relation) => (
              <option key={relation.key} value={relation.key}>
                {relation.labelFr}
              </option>
            ))}
          </select>
          {subjectType !== null && objectType !== null && (
            <span className="mt-1 block text-xs text-muted">
              Seules les relations que l&apos;ontologie accepte entre un{' '}
              {nodeTypeLabel(subjectType).toLowerCase()} et un{' '}
              {nodeTypeLabel(objectType).toLowerCase()} sont proposées.
            </span>
          )}
        </label>
      )}

      {pointsAtEntity ? (
        <div className="mt-3">
          <label className="block text-sm">
            <span className="font-medium text-primary">
              {outgoing ? 'Ce fait vise en réalité' : 'Ce fait parle en réalité de'}
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Chercher une entité par son nom…"
              autoFocus
              className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-primary"
            />
          </label>

          <p className="mt-1 text-xs text-muted">
            Cherché dans ce que vous avez lu jusqu&apos;au chapitre {boundary}.
            Actuellement&nbsp;: {objectLabel}.
          </p>

          {target && (
            <p className="mt-2 text-sm text-[var(--epi-validated)]">
              Nouvelle cible&nbsp;: {target.label} ({nodeTypeLabel(target.nodeType)}
              {target.revealedInChapter !== null && `, ch. ${target.revealedInChapter}`}
              ).{' '}
              <button
                type="button"
                onClick={() => setTarget(null)}
                className="underline decoration-dotted"
              >
                annuler ce choix
              </button>
            </p>
          )}

          {searching && <p className="mt-2 text-sm text-muted">Recherche…</p>}

          {!searching && candidates !== null && candidates.length === 0 && (
            /* Not a failure of the search. At this chapter the right entity may
               simply not exist yet, and that is an answer: the fact is not
               about something else, it is not a fact. */
            <p className="mt-2 text-sm text-secondary">
              Aucune entité de ce nom à ce chapitre. Si celle qu&apos;il faudrait
              n&apos;est pas encore apparue, c&apos;est que ce fait est à
              retirer.
            </p>
          )}

          {!searching && candidates !== null && candidates.length > 0 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {candidates.map((candidate) => (
                <li key={candidate.entityId}>
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(candidate)
                      setError(null)
                    }}
                    className="w-full rounded-sm border border-line px-2 py-1 text-left text-sm text-primary hover:border-accent"
                  >
                    {candidate.label}
                    <span className="ml-2 font-mono text-xs text-muted">
                      {nodeTypeLabel(candidate.nodeType)}
                      {candidate.revealedInChapter !== null &&
                        ` · ch. ${candidate.revealedInChapter}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <label className="mt-3 block text-sm">
          <span className="font-medium text-primary">Ce fait devrait dire</span>
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={2}
            maxLength={500}
            autoFocus
            className="mt-1.5 w-full rounded-sm border border-line-strong bg-surface-raised px-3 py-2 text-primary"
          />
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending || !changed}
          className="bouton bouton-primaire !py-1 !text-sm"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer la correction'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            reset()
          }}
          disabled={pending}
          className="bouton !py-1 !text-sm"
        >
          Annuler
        </button>
      </div>

      {/*
       * The other answer, kept apart from the first.
       *
       * « Ce fait est faux » is not a correction with an empty target — it says
       * the sentence should never have been written, and nothing on this page
       * will offer it back afterwards. So it asks twice, and says what survives
       * the click.
       */}
      <div className="mt-3 border-t border-line pt-3">
        {confirming ? (
          <>
            <p className="text-sm text-[var(--epi-contradicted)]">
              Ce fait cessera de paraître partout : fiche, graphe, recherche,
              chronologie. Sa ligne, ses preuves et sa provenance restent en
              base, et un réimport du chapitre ne le reproposera pas.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={retract}
                disabled={pending}
                className="bouton !py-1 !text-sm"
                style={{ color: 'var(--epi-contradicted)' }}
              >
                {pending ? 'Retrait…' : 'Retirer définitivement'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="bouton !py-1 !text-sm"
              >
                Garder le fait
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="text-sm text-secondary underline decoration-dotted hover:text-[var(--epi-contradicted)]"
          >
            Ou bien&nbsp;: ce fait est faux, le retirer
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--epi-contradicted)]">
          {error}
        </p>
      )}
    </section>
  )
}
