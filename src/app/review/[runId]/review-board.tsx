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
        [...decisions].map(([reviewItemId, decision]) => ({ reviewItemId, decision })),
      )
      if (response.ok && response.published) {
        setResult(response.published)
        setDecisions(new Map())
      } else {
        setError(response.error ?? 'Publication impossible.')
      }
    })
  }

  if (items.length === 0) {
    return (
      <section className="mt-10 rounded-sm border border-line bg-surface-raised p-6">
        <p className="text-primary">
          Rien à revoir pour ce traitement.
          {queue.counts.accepted > 0 &&
            ` ${queue.counts.accepted} proposition(s) déjà publiée(s).`}
        </p>
        <Link
          href={`/chapitres/${queue.chapterId}`}
          className="mt-4 inline-block rounded-sm border border-line-strong px-4 py-2 text-sm text-primary hover:bg-surface-raised"
        >
          Revenir au chapitre
        </Link>
      </section>
    )
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <p className="text-sm text-secondary">
          {items.length} en attente · {decisions.size} décidée
          {decisions.size === 1 ? '' : 's'}
        </p>
        {queue.counts.requiringExplicitReview > 0 && (
          <p className="text-sm text-[var(--epi-hypothetical)]">
            {queue.counts.requiringExplicitReview} exige(nt) une revue explicite
          </p>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {bulkEligible.length > 0 && (
            <button
              type="button"
              onClick={acceptBulk}
              className="rounded-sm border border-line-strong px-3 py-1.5 text-sm text-primary hover:bg-surface-raised"
              title="Uniquement les propositions sûres : ni identité, ni révélation, ni contradiction"
            >
              Accepter les {bulkEligible.length} cas sûrs
            </button>
          )}
          <button
            type="button"
            onClick={publish}
            disabled={decisions.size === 0 || publishing}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-medium text-inverted hover:bg-accent-strong disabled:opacity-40"
          >
            {publishing ? 'Publication…' : `Publier ${decisions.size || ''}`}
          </button>
        </div>
      </div>

      <p className="mt-3 text-sm text-muted">
        <kbd className="font-mono">a</kbd> accepter ·{' '}
        <kbd className="font-mono">r</kbd> rejeter ·{' '}
        <kbd className="font-mono">d</kbd> reporter ·{' '}
        <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> naviguer.
        Rien n&apos;est écrit avant « Publier ».
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-sm border border-[var(--epi-contradicted)] bg-surface-raised p-3 text-sm text-primary">
          {error}
        </p>
      )}

      {result && <PublishSummary result={result} chapterId={queue.chapterId} />}

      <ol className="mt-6 space-y-4">
        {items.map((item, index) => (
          <li key={item.id}>
            <ProposalCard
              item={item}
              active={index === cursor}
              decision={decisions.get(item.id) ?? null}
              onFocus={() => setCursor(index)}
              onDecide={(decision) => decide(item.id, decision)}
            />
          </li>
        ))}
      </ol>
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
  active,
  decision,
  onFocus,
  onDecide,
}: {
  item: ReviewItemView
  active: boolean
  decision: DecisionKind | null
  onFocus: () => void
  onDecide: (decision: DecisionKind) => void
}) {
  return (
    <article
      tabIndex={0}
      onFocus={onFocus}
      aria-current={active}
      className={`grid gap-5 rounded-sm border bg-surface-raised p-4 md:grid-cols-2 ${
        active ? 'border-accent ring-1 ring-[var(--accent)]' : 'border-line'
      } ${decision ? 'opacity-90' : ''}`}
    >
      <div>
        <header className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs uppercase tracking-wider text-muted">
            {categoryLabel(item.category)}
          </span>
          {item.requiresExplicitReview && (
            <span
              className="rounded-sm border border-[var(--epi-hypothetical)] px-1.5 text-[0.65rem] text-[var(--epi-hypothetical)]"
              title="Identité, révélation, mort, affiliation cachée ou contradiction : jamais acceptable en lot"
            >
              revue explicite
            </span>
          )}
          <span className="ml-auto font-mono text-xs text-muted">
            confiance {Math.round(item.confidence * 100)} %
          </span>
        </header>

        <ProposalBody category={item.category} payload={item.payload} relatedLabel={item.relatedLabel} />

        <div className="mt-4 flex flex-wrap gap-2">
          {(['accept', 'reject', 'defer'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onDecide(kind)}
              aria-pressed={decision === kind}
              className={`rounded-sm border px-3 py-1.5 text-sm transition-colors ${
                decision === kind
                  ? 'border-accent bg-accent text-inverted'
                  : 'border-line-strong text-primary hover:bg-surface-overlay'
              }`}
            >
              {kind === 'accept' ? 'Accepter' : kind === 'reject' ? 'Rejeter' : 'Reporter'}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-line pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
        <h3 className="text-sm font-medium text-primary">Preuve</h3>
        {item.evidence.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--epi-contradicted)]">
            Aucune preuve rattachée — cette proposition ne devrait pas être ici.
          </p>
        ) : (
          <ul className="mt-2 space-y-4">
            {item.evidence.map((evidence, index) => (
              <li key={`${evidence.ref}-${index}`}>
                <EvidencePanel evidence={evidence} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

function EvidencePanel({ evidence }: { evidence: EvidenceView }) {
  return (
    <div>
      <p className="font-mono text-xs text-muted">
        {evidence.ref}
        {evidence.pageIndex !== null && ` · page ${evidence.pageIndex + 1}`}
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
          className="mt-1.5 block max-h-64 w-auto rounded-sm border border-line"
        />
      )}

      <blockquote className="mt-1.5 border-l-2 border-accent pl-2.5 text-sm text-primary">
        {evidence.excerpt}
      </blockquote>

      {evidence.blockText && evidence.blockText !== evidence.excerpt && (
        <p className="mt-1 text-xs text-muted">
          Bloc complet : {evidence.blockText}
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
}: {
  category: string
  payload: unknown
  relatedLabel: string | null
}) {
  const record = (payload ?? {}) as Record<string, unknown>

  if (category === 'entity') {
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
