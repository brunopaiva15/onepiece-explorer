'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import type { EvidenceView, ReviewItemView, ReviewQueue } from '@/domains/review/queue.ts'
import type { DecisionKind, PublishResult } from '@/domains/review/publish.ts'
import { publishDecisionsAction } from './actions.ts'

/**
 * The review centre.
 *
 * The layout is the argument: the proposal on the left, its evidence on the
 * right, always both. A review screen that shows a claim without its source
 * turns "is this right" into "do I trust the model today", which is the question
 * this whole product exists to avoid asking.
 *
 * Decisions stay local until published. Two reasons — one for the reviewer, one
 * for correctness. The reviewer can change their mind for free, which matters
 * across a queue of fifty. And entities must be published in the same
 * transaction as the assertions referencing them, so per-click publishing would
 * leave windows where a relation cannot resolve its own subject.
 *
 * Keyboard first: a — accept, r — reject, d — defer, then j/k or the arrows to
 * move. Reviewing a chapter is a repetitive task done in one sitting, and the
 * mouse is what makes it slow enough to start skimming.
 */

const KEYS: Record<string, DecisionKind> = {
  a: 'accept',
  r: 'reject',
  d: 'defer',
}

interface Props {
  queue: ReviewQueue
}

export function ReviewBoard({ queue }: Props) {
  const [decisions, setDecisions] = useState<Map<string, DecisionKind>>(new Map())
  /*
   * Names the reviewer rewrote, by item id.
   *
   * Held beside the decisions rather than inside them because a rename is not a
   * decision: you can retype a label, change your mind about accepting, and
   * retype it again. It becomes a 'correct' decision only at publish time, and
   * only if the item was accepted — which is also when the answer is written to
   * the glossary and stops being asked.
   */
  const [renames, setRenames] = useState<Map<string, string>>(new Map())
  const [cursor, setCursor] = useState(0)
  const [publishing, startPublishing] = useTransition()
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const items = queue.items
  const current = items[cursor]

  const decide = useCallback(
    (id: string, decision: DecisionKind) => {
      setDecisions((previous) => {
        const next = new Map(previous)
        if (next.get(id) === decision) next.delete(id)
        else next.set(id, decision)
        return next
      })
    },
    [],
  )

  const move = useCallback(
    (delta: number) => {
      setCursor((c) => Math.max(0, Math.min(items.length - 1, c + delta)))
    },
    [items.length],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Never steal a keystroke from a field the reviewer is typing in.
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }

      const decision = KEYS[event.key.toLowerCase()]
      if (decision && current) {
        event.preventDefault()
        decide(current.id, decision)
        // Advance after deciding: the queue is meant to be walked, and stopping
        // on each item to reach for the arrow key is what makes fifty items feel
        // like a chore.
        move(1)
        return
      }

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, decide, move])

  /*
   * Bulk accept covers only what is safe to accept in bulk.
   *
   * Identity, revelation, death, hidden affiliation, mystery resolution and
   * contradiction are excluded whatever their confidence — those are exactly the
   * claims whose premature acceptance spoils the story rather than merely being
   * wrong, and a button that swept them up would make the "explicit review"
   * flag decorative.
   */
  const bulkEligible = useMemo(
    () =>
      items.filter(
        (item) =>
          !item.requiresExplicitReview &&
          item.confidence >= 0.7 &&
          !decisions.has(item.id),
      ),
    [items, decisions],
  )

  function acceptBulk(): void {
    setDecisions((previous) => {
      const next = new Map(previous)
      for (const item of bulkEligible) next.set(item.id, 'accept')
      return next
    })
  }

  function publish(): void {
    setError(null)
    startPublishing(async () => {
      const response = await publishDecisionsAction(
        queue.runId,
        [...decisions].map(([reviewItemId, decision]) => {
          const renamed = renames.get(reviewItemId)?.trim()
          const item = items.find((candidate) => candidate.id === reviewItemId)
          const payload = item?.payload as { label?: string } | undefined

          if (decision !== 'accept' || !renamed || renamed === payload?.label) {
            return { reviewItemId, decision }
          }

          // 'correct', not 'accept': the label is now yours. Downstream that
          // difference decides whether the glossary learns the answer, and
          // whether the row is marked as proposed by you rather than by a model.
          return {
            reviewItemId,
            decision: 'correct' as DecisionKind,
            correctedPayload: { ...(payload ?? {}), label: renamed, naming_confident: true },
          }
        }),
      )
      if (response.ok && response.published) {
        setResult(response.published)
        setDecisions(new Map())
        setRenames(new Map())
      } else {
        setError(response.error ?? 'Publication impossible.')
      }
    })
  }

  const decided = decisions.size
  const counts = {
    accept: [...decisions.values()].filter((d) => d === 'accept').length,
    reject: [...decisions.values()].filter((d) => d === 'reject').length,
    defer: [...decisions.values()].filter((d) => d === 'defer').length,
  }

  if (items.length === 0) {
    return (
      <section className="panneau mt-8">
        <h2 className="panneau-titre panneau-titre-vedette">File vide</h2>
        <div className="panneau-corps">
          <p className="text-primary">
            Rien à revoir pour ce traitement.
            {queue.counts.accepted > 0 &&
              ` ${queue.counts.accepted} proposition(s) déjà publiée(s).`}
          </p>
          <Link href={`/chapitres/${queue.chapterId}`} className="bouton mt-4">
            Revenir au chapitre
          </Link>
        </div>
      </section>
    )
  }

  /*
   * One proposal, not eighty-seven.
   *
   * This was a scrolling list of every item in the queue, with the "current"
   * one merely outlined — so the screen showed you forty things you were not
   * deciding on, and the thing you were deciding on was the same size as the
   * rest. Triage is a different job from reading: it needs the evidence big
   * enough to judge, the decision under your fingers, and nothing else
   * competing. The queue is still there, as a strip of squares you can click,
   * because knowing there are sixty left is part of the job too.
   */
  return (
    <section className="mt-4">
      {/* --- Progress and publication, pinned ------------------------------ */}
      <div className="sticky top-[3.25rem] z-20 border-[3px] border-ink bg-surface-raised">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2">
          <span className="chiffre text-3xl leading-none">{cursor + 1}</span>
          <span className="font-display text-sm uppercase text-muted">/ {items.length}</span>

          <div className="flex gap-1.5">
            {counts.accept > 0 && <span className="badge badge-vert">{counts.accept} ✓</span>}
            {counts.reject > 0 && <span className="badge badge-rouge">{counts.reject} ✕</span>}
            {counts.defer > 0 && <span className="badge badge-gris">{counts.defer} ⏸</span>}
          </div>

          <div className="ml-auto flex flex-wrap gap-2">
            {bulkEligible.length > 0 && (
              <button
                type="button"
                onClick={acceptBulk}
                className="bouton !py-1 !text-sm"
                title="Uniquement les propositions sûres : ni identité, ni révélation, ni contradiction"
              >
                Accepter {bulkEligible.length} sûres
              </button>
            )}
            <button
              type="button"
              onClick={publish}
              disabled={decided === 0 || publishing}
              className="bouton bouton-primaire !py-1 !text-sm"
            >
              {publishing ? 'Publication…' : `Publier ${decided || ''}`}
            </button>
          </div>
        </div>

        {/* The queue as a strip: position, decisions taken, and a way back. */}
        <ol className="flex flex-wrap gap-[3px] border-t-[3px] border-ink px-3 py-2">
          {items.map((item, index) => {
            const d = decisions.get(item.id)
            const tint =
              d === 'accept'
                ? 'var(--epi-validated)'
                : d === 'reject'
                  ? 'var(--coral)'
                  : d === 'defer'
                    ? 'var(--text-muted)'
                    : 'var(--surface-sunken)'
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setCursor(index)}
                  aria-label={`Proposition ${index + 1}`}
                  aria-current={index === cursor}
                  className={`block h-3 w-3 border-2 ${
                    index === cursor ? 'border-ink ring-2 ring-[var(--accent)]' : 'border-ink/40'
                  }`}
                  style={{ background: tint }}
                />
              </li>
            )
          })}
        </ol>
      </div>

      {error && (
        <p role="alert" className="mt-4 border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-white">
          {error}
        </p>
      )}

      {result && <PublishSummary result={result} chapterId={queue.chapterId} />}

      {current && (
        <ProposalCard
          key={current.id}
          item={current}
          index={cursor}
          total={items.length}
          decision={decisions.get(current.id) ?? null}
          onDecide={(decision) => {
            decide(current.id, decision)
            move(1)
          }}
          onMove={move}
          rename={renames.get(current.id) ?? null}
          onRename={(label) =>
            setRenames((previous) => new Map(previous).set(current.id, label))
          }
        />
      )}
    </section>
  )
}

function PublishSummary({
  result,
  chapterId,
}: {
  result: PublishResult
  chapterId: string
}) {
  const created =
    result.entitiesCreated +
    result.assertionsCreated +
    result.eventsCreated +
    result.mysteriesCreated

  return (
    <div
      role="status"
      className="mt-4 rounded-sm border border-[var(--epi-explicit)] bg-surface-raised p-4"
    >
      <p className="font-medium text-primary">
        {created} élément(s) ajouté(s) au graphe.
      </p>
      <ul className="mt-2 space-y-0.5 text-sm text-secondary">
        {result.entitiesCreated > 0 && <li>{result.entitiesCreated} entité(s)</li>}
        {result.assertionsCreated > 0 && <li>{result.assertionsCreated} relation(s)</li>}
        {result.eventsCreated > 0 && <li>{result.eventsCreated} événement(s)</li>}
        {result.mysteriesCreated > 0 && <li>{result.mysteriesCreated} mystère(s)</li>}
        {result.rejected > 0 && <li>{result.rejected} rejetée(s)</li>}
        {result.deferred > 0 && <li>{result.deferred} reportée(s)</li>}
      </ul>

      {result.failures.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-sm font-medium text-[var(--epi-contradicted)]">
            {result.failures.length} n&apos;ont pas pu être appliquée(s) :
          </p>
          <ul className="mt-1 space-y-1 text-sm text-secondary">
            {result.failures.map((failure) => (
              <li key={failure.reviewItemId}>{failure.reason}</li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/chapitres/${chapterId}`}
        className="mt-3 inline-block rounded-sm border border-line-strong px-4 py-2 text-sm text-primary hover:bg-surface-raised"
      >
        Revenir au chapitre
      </Link>
    </div>
  )
}

function ProposalCard({
  item,
  index,
  total,
  decision,
  onDecide,
  onMove,
  rename,
  onRename,
}: {
  item: ReviewItemView
  index: number
  total: number
  decision: DecisionKind | null
  onDecide: (decision: DecisionKind) => void
  onMove: (delta: number) => void
  rename: string | null
  onRename: (label: string) => void
}) {
  return (
    <article className="mt-4 grid gap-4 lg:grid-cols-[3fr_2fr]">
      {/* --- The evidence, at a size you can actually judge ---------------- */}
      <div className="panneau">
        <h2 className="panneau-titre">
          La preuve
          <span className="font-sans text-xs normal-case opacity-80">
            {item.evidence.length} élément{item.evidence.length > 1 ? 's' : ''}
          </span>
        </h2>
        <div className="panneau-corps">
          {item.evidence.length === 0 ? (
            <p className="border-[3px] border-ink bg-[var(--coral)] px-3 py-2 text-white">
              Aucune preuve rattachée — cette proposition ne devrait pas être ici.
            </p>
          ) : (
            <ul className="space-y-5">
              {item.evidence.map((evidence, i) => (
                <li key={`${evidence.ref}-${i}`}>
                  <EvidencePanel evidence={evidence} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --- The claim, and the four ways out ----------------------------- */}
      <div className="flex flex-col gap-4">
        <div className="panneau">
          <h2 className="panneau-titre panneau-titre-vedette">
            {categoryLabel(item.category)}
            <span className="font-sans text-xs normal-case">
              confiance {Math.round(item.confidence * 100)} %
            </span>
          </h2>
          <div className="panneau-corps">
            {item.requiresExplicitReview && (
              <p
                className="mb-3 border-[3px] border-ink bg-[var(--epi-hypothetical)] px-2 py-1 font-display text-sm uppercase text-ink"
                title="Identité, révélation, mort, affiliation cachée ou contradiction : jamais acceptable en lot"
              >
                Revue explicite obligatoire
              </p>
            )}
            <ProposalBody
              category={item.category}
              payload={item.payload}
              relatedLabel={item.relatedLabel}
              rename={rename}
              onRename={onRename}
            />
          </div>
        </div>

        <div className="panneau lg:sticky lg:top-[9.5rem]">
          <div className="panneau-corps">
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['accept', 'Accepter', 'a', 'bouton-primaire'],
                  ['reject', 'Rejeter', 'r', 'bouton-danger'],
                  ['defer', 'Reporter', 'd', ''],
                ] as const
              ).map(([kind, label, key, tone]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => onDecide(kind)}
                  aria-pressed={decision === kind}
                  className={`bouton ${decision === kind ? tone || 'bouton-mer' : ''} !flex-col !gap-0 !py-2`}
                >
                  <span>{label}</span>
                  <kbd className="font-sans text-[0.65rem] font-bold opacity-70">{key}</kbd>
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <button type="button" onClick={() => onMove(-1)} className="bouton !py-1 !text-xs">
                ‹ k
              </button>
              <span className="tabular text-xs text-muted">
                {index + 1} / {total}
              </span>
              <button type="button" onClick={() => onMove(1)} className="bouton !py-1 !text-xs">
                j ›
              </button>
            </div>

            <p className="mt-3 text-xs text-muted">
              Rien n&apos;est écrit avant « Publier ». Une décision déplace
              automatiquement à la suivante.
            </p>
          </div>
        </div>
      </div>
    </article>
  )
}

function EvidencePanel({ evidence }: { evidence: EvidenceView }) {
  return (
    <div>
      {/*
       * A citation names where it came from, in the vocabulary of the source.
       *
       * `b3` is what the model was given and what the anchoring check verified,
       * but a reviewer deciding whether a fact is true needs "passage 3" — the
       * number they can count down to in the chapter they wrote. A page-less
       * block is a passage of a written chapter; there is no other way to
       * produce one.
       */}
      <p className="font-mono text-xs text-muted">
        {evidence.pageIndex !== null
          ? `${evidence.ref} · page ${evidence.pageIndex + 1}`
          : `passage ${evidence.ref.replace(/^b/, '')}`}
        {' · '}
        {evidence.kind === 'text' ? 'texte' : 'visuel'}
      </p>

      {evidence.panelImageUrl && (
        // Signed, short-lived URL from a private bucket. Not run through
        // next/image, which would cache a copy of a private page on disk under
        // a stable public path.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={evidence.panelImageUrl}
          alt={`Case source ${evidence.ref}`}
          loading="lazy"
          className="mt-2 block max-h-[26rem] w-full border-[3px] border-ink object-contain"
        />
      )}

      <blockquote className="mt-2 border-l-[6px] border-[var(--accent)] bg-surface-sunken px-3 py-2 text-base text-primary">
        {evidence.excerpt}
      </blockquote>

      {evidence.blockText && evidence.blockText !== evidence.excerpt && (
        <p className="mt-1 text-xs text-muted">
          {evidence.pageIndex === null ? 'Passage complet' : 'Bloc complet'} :{' '}
          {evidence.blockText}
        </p>
      )}

      {evidence.panelDescription && (
        <p className="mt-1 text-xs text-muted">{evidence.panelDescription}</p>
      )}
    </div>
  )
}

function ProposalBody({
  category,
  payload,
  relatedLabel,
  rename,
  onRename,
}: {
  category: string
  payload: unknown
  relatedLabel: string | null
  rename: string | null
  onRename: (label: string) => void
}) {
  const record = (payload ?? {}) as Record<string, unknown>

  if (category === 'entity') {
    const sourceTerm =
      typeof record.source_term === 'string' && record.source_term.length > 0
        ? record.source_term
        : null
    const unsure = record.naming_confident === false

    /*
     * When the model does not know what to call something, ask.
     *
     * The field is editable in place rather than behind a "corriger" mode,
     * because on a flagged item renaming *is* the review — the question is not
     * "is this entity real" but "what do we call it". Answering here writes the
     * decision to the glossary, and every later chapter of this work is handed
     * it instead of being asked again.
     */
    if (unsure || sourceTerm) {
      return (
        <div className="mt-2">
          {sourceTerm && (
            <p className="text-sm text-secondary">
              <span className="cartouche block">Dans la source</span>
              <span className="text-base text-primary">« {sourceTerm} »</span>
            </p>
          )}

          <label className="mt-3 block">
            <span className="cartouche block">
              {unsure ? 'Comment on l’appelle en français' : 'Nom dans le graphe'}
            </span>
            <input
              type="text"
              value={rename ?? String(record.label ?? '')}
              onChange={(event) => onRename(event.target.value)}
              maxLength={200}
              className="mt-1 w-full border-[3px] border-ink bg-surface-raised px-2.5 py-1.5 text-lg text-primary"
            />
          </label>

          <p className="mt-1.5 text-sm text-secondary">
            {String(record.node_type ?? '')} ·{' '}
            {labelKindLabel(String(record.label_kind ?? ''))}
          </p>

          {unsure && (
            <p className="mt-2 text-sm text-muted">
              Le modèle ne sait pas trancher — traduire ou garder tel quel est une
              convention, pas un fait du texte. Votre réponse est enregistrée pour
              toute l’œuvre : la question ne sera plus posée.
            </p>
          )}
        </div>
      )
    }

    return (
      <div className="mt-2">
        <p className="text-lg text-primary">{String(record.label ?? '')}</p>
        <p className="mt-1 text-sm text-secondary">
          {String(record.node_type ?? '')} · {labelKindLabel(String(record.label_kind ?? ''))}
        </p>
      </div>
    )
  }

  if (category === 'assertion') {
    return (
      <div className="mt-2">
        <p className="text-primary">
          <span className="font-medium">{String(record.subject ?? '')}</span>{' '}
          <span className="font-mono text-sm text-accent">
            {String(record.predicate ?? '')}
          </span>{' '}
          <span className="font-medium">
            {String(record.object ?? record.object_value ?? '')}
          </span>
        </p>
        <p className="mt-1 text-sm text-secondary">
          {epistemicLabel(String(record.epistemic_status ?? ''))}
        </p>
      </div>
    )
  }

  if (category === 'resolution') {
    const signals = Array.isArray(record.signals)
      ? (record.signals as Array<{ key: string; reason: string; score: number }>)
      : []

    return (
      <div className="mt-2">
        <p className="text-primary">
          « {String(record.candidateLabel ?? '')} » est-il la même entité que
          {' '}
          <span className="font-medium">
            {relatedLabel ?? String(record.existingEntityId ?? '')}
          </span>{' '}
          ?
        </p>
        <p className="mt-1 text-sm text-secondary">
          Score {Math.round(Number(record.score ?? 0) * 100)} % ·{' '}
          {suggestionLabel(String(record.suggestion ?? ''))}
        </p>

        {/* Every signal, including the ones that found nothing. A score shown
            with only its supporting reasons is an argument, not evidence. */}
        <ul className="mt-2 space-y-1 text-sm">
          {signals.map((signal) => (
            <li key={signal.key} className="flex gap-2">
              <span
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    signal.score > 0.5
                      ? 'var(--epi-explicit)'
                      : signal.score > 0
                        ? 'var(--epi-hypothetical)'
                        : 'var(--epi-refuted)',
                }}
                aria-hidden
              />
              <span className="text-secondary">{signal.reason}</span>
            </li>
          ))}
        </ul>

        {typeof record.modelReasoning === 'string' && (
          <p className="mt-2 rounded-sm bg-surface-overlay p-2 text-sm text-secondary">
            Avis du modèle ({String(record.modelVerdict ?? '')}) :{' '}
            {record.modelReasoning}
          </p>
        )}
      </div>
    )
  }

  if (category === 'conflict') {
    const options = Array.isArray(record.options)
      ? (record.options as Array<{ key: string; label: string }>)
      : []

    return (
      <div className="mt-2">
        <p className="text-primary">{String(record.explanation ?? '')}</p>
        <p className="mt-2 text-sm text-secondary">
          Trois lectures possibles, et le système n&apos;en choisit aucune :
        </p>
        <ul className="mt-1 space-y-1 text-sm text-secondary">
          {options.map((option) => (
            <li key={option.key}>• {option.label}</li>
          ))}
        </ul>
      </div>
    )
  }

  if (category === 'event') {
    return (
      <div className="mt-2">
        <p className="text-primary">{String(record.summary ?? '')}</p>
        {record.is_flashback === true && (
          <p className="mt-1 text-sm text-[var(--epi-hypothetical)]">
            Présenté comme un souvenir : montré ici, survenu plus tôt.
          </p>
        )}
      </div>
    )
  }

  if (category === 'mystery') {
    return (
      <div className="mt-2">
        <p className="text-primary">{String(record.question ?? '')}</p>
      </div>
    )
  }

  return (
    <pre className="mt-2 overflow-x-auto rounded-sm bg-surface-overlay p-2 text-xs text-secondary">
      {JSON.stringify(payload, null, 2)}
    </pre>
  )
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    entity: 'entité',
    assertion: 'relation',
    resolution: 'rapprochement',
    conflict: 'contradiction',
    event: 'événement',
    mystery: 'mystère',
  }
  return labels[category] ?? category
}

function labelKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    placeholder: 'désignation provisoire, tirée de l’image',
    alias: 'surnom ou désignation',
    true_name: 'vrai nom',
    epithet: 'épithète',
    translation: 'traduction',
  }
  return labels[kind] ?? kind
}

function epistemicLabel(status: string): string {
  const labels: Record<string, string> = {
    explicit: 'affirmé ou montré directement',
    inferred_strong: 'déduit des pages, sans y être dit',
    hypothetical: 'lecture possible — revue explicite requise',
  }
  return labels[status] ?? status
}

function suggestionLabel(suggestion: string): string {
  const labels: Record<string, string> = {
    likely_same: 'probablement la même',
    worth_checking: 'à vérifier',
    likely_different: 'probablement différentes',
  }
  return labels[suggestion] ?? suggestion
}
