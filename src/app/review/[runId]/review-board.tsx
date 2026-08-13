'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import type { DuplicateInfo } from '@/domains/review/duplicates.ts'
import type { EvidenceView, ReviewItemView, ReviewQueue } from '@/domains/review/queue.ts'
import type { Decision, DecisionKind, PublishResult } from '@/domains/review/publish.ts'
import { markChapterReviewedAction, publishDecisionsAction } from './actions.ts'
import { predicateLabel } from '@/domains/knowledge/predicate-label.ts'

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

/** A name the reviewer replaced, and what they replaced it with. */
interface RenamePair {
  from: string
  to: string
}

/**
 * Carry a reviewer's renaming into the prose that used the old name.
 *
 * Exact, case-sensitive replacement: these are proper nouns, written by the
 * same model in the same call as the summary, so the spelling matches. A
 * case-insensitive or fuzzy pass would start rewriting words the reviewer never
 * touched, which is a worse failure than leaving a sentence alone — the fix is
 * always one keystroke away in the field above.
 */
function applyRenames(value: string, pairs: RenamePair[]): string {
  let out = value
  for (const pair of pairs) out = out.split(pair.from).join(pair.to)
  return out
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
  /*
   * Predicates the reviewer replaced, by item id.
   *
   * Beside the decisions for the same reason a rename is: choosing
   * « se trouve à » instead of « appartient à » is not yet an answer about
   * whether the relation is true. It becomes a 'correct' decision at publish
   * time, and only on an item that was accepted.
   */
  const [predicates, setPredicates] = useState<Map<string, string>>(new Map())
  const [cursor, setCursor] = useState(0)
  /**
   * Whether this card was chosen on purpose.
   *
   * Settled copies are stepped over while walking, but clicking one in the
   * strip has to land on it — overriding the automatic decision is exactly what
   * that click is for. The flag distinguishes "the walk put me here", which may
   * be corrected, from "I asked for this card", which may not.
   */
  const [pinned, setPinned] = useState(false)
  const [publishing, startPublishing] = useTransition()
  const [closing, startClosing] = useTransition()
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const items = queue.items
  const current = items[cursor]

  /*
   * Where each proposal's copies sit in the queue.
   *
   * A chapter is extracted in slices, so the same character is genuinely
   * proposed twice — and the two cards can be forty apart in a queue of eighty.
   * Nothing on screen used to connect them, which left "have I already accepted
   * this one?" to memory, across a sitting. It is the one question the interface
   * can answer outright.
   */
  const twinsByKey = useMemo(() => {
    const positions = new Map<string, number[]>()
    for (const [index, item] of items.entries()) {
      const key = item.duplicate?.key
      if (key === undefined) continue
      const known = positions.get(key)
      if (known) known.push(index)
      else positions.set(key, [index])
    }
    return positions
  }, [items])

  /*
   * Copies settled by a decision taken on one of their own.
   *
   * Once a copy is accepted, the others have no question left in them: the
   * entity is in the graph, and accepting a second would add a node nothing
   * will ever join back. Deciding them by hand, one card at a time, is asking
   * the reviewer to type the same answer to a question that has been answered.
   * So they are deferred — not rejected, because they are not wrong, and not
   * dropped, because nothing here writes anything without saying so.
   *
   * Derived rather than stored, which is what makes it undoable: unmark the
   * accept and the set recomputes without them on the next render. An explicit
   * decision always wins — accepting two copies is legitimate when you have
   * judged them to be two different things, and this must not stand in the way.
   */
  const autoDeferred = useMemo(() => {
    const settled = new Set<string>()

    for (const positions of twinsByKey.values()) {
      const claimed = positions.some(
        (position) =>
          decisions.get(items[position]!.id) === 'accept' ||
          // Accepted in an earlier batch: the entity is already in the graph,
          // and this run's remaining copies were only ever going to duplicate
          // it. That copy is not even in the queue any more.
          (items[position]!.duplicate?.others.accepted ?? 0) > 0,
      )
      if (!claimed) continue

      for (const position of positions) {
        const item = items[position]!
        // An explicit decision, whatever it is, is the reviewer's and stands.
        if (decisions.has(item.id)) continue
        settled.add(item.id)
      }
    }

    return settled
  }, [decisions, items, twinsByKey])

  const twinsOfCurrent = useMemo(() => {
    if (!current?.duplicate) return []
    return (twinsByKey.get(current.duplicate.key) ?? [])
      .filter((position) => position !== cursor)
      .map((position) => ({
        position,
        decision: decisions.get(items[position]!.id) ?? null,
        auto: autoDeferred.has(items[position]!.id),
      }))
  }, [autoDeferred, current, cursor, decisions, items, twinsByKey])

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

  /**
   * Walk to the next card that still has a question in it.
   *
   * Settled copies are stepped over rather than removed: the strip still shows
   * them, and clicking one goes there. What they no longer do is interrupt the
   * walk — which is the whole point of settling them.
   */
  const move = useCallback(
    (delta: number) => {
      setPinned(false)
      setCursor((from) => {
        const step = delta === 0 ? 0 : delta > 0 ? 1 : -1
        let next = from + delta
        while (next > 0 && next < items.length - 1 && autoDeferred.has(items[next]!.id)) {
          next += step
        }
        return Math.max(0, Math.min(items.length - 1, next))
      })
    },
    [autoDeferred, items],
  )

  /*
   * The names you retyped, ready to be applied to everything else in the batch.
   *
   * An event summary is prose the model wrote during extraction — before you
   * renamed anything — so it keeps the name the model chose. Correcting the
   * entity to « Monstre de la Baie » and then reading « Le Seigneur de la Côte
   * dévore Higuma » two cards later is the same name settled twice, and the
   * graph would keep the version you rejected: an event's label is its summary.
   *
   * Only from entities you are accepting, and only where the text differs.
   * A rename you have not committed to is not yet an answer.
   */
  const renamedLabels = useMemo(() => {
    const pairs: RenamePair[] = []
    for (const item of items) {
      if (item.category !== 'entity') continue
      if (decisions.get(item.id) !== 'accept') continue
      const to = renames.get(item.id)?.trim()
      const from = (item.payload as { label?: string }).label?.trim()
      if (!to || !from || to === from) continue
      pairs.push({ from, to })
    }
    // Longest first: a name that contains another must be replaced whole,
    // before the shorter one can eat part of it.
    return pairs.sort((a, b) => b.from.length - a.from.length)
  }, [decisions, items, renames])

  /** Go to a card because the reviewer asked for it, settled or not. */
  const jumpTo = useCallback((position: number) => {
    setPinned(true)
    setCursor(position)
  }, [])

  /*
   * Step off a settled card the walk landed on.
   *
   * Adjusted during render rather than in an effect, the same way the import
   * form advances itself: the settled card is never painted, so the queue
   * simply does not contain it as far as the reviewer is concerned. Deterministic
   * enough not to loop — the target is computed from the same inputs, so the
   * next render finds the cursor already there.
   */
  if (!pinned && current && autoDeferred.has(current.id)) {
    const forward = items.findIndex(
      (item, index) => index > cursor && !autoDeferred.has(item.id),
    )
    const backward = items.findLastIndex(
      (item, index) => index < cursor && !autoDeferred.has(item.id),
    )
    const target = forward !== -1 ? forward : backward
    if (target !== -1 && target !== cursor) setCursor(target)
  }

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
  const bulkEligible = useMemo(() => {
    /*
     * One copy per proposal, never two.
     *
     * Bulk accept used to sweep both halves of a duplicate — same confidence,
     * same flags, so both passed the filter — and published two nodes for one
     * character in a single click. A group is claimed by the first copy that
     * takes it: one already accepted in an earlier batch, one the reviewer has
     * marked by hand, or failing both, the first eligible copy here. The rest
     * are left undecided rather than rejected, because which copy to keep is a
     * judgement and this button does not make judgements.
     */
    const claimed = new Set<string>()
    for (const item of items) {
      const key = item.duplicate?.key
      if (key === undefined) continue
      if (item.duplicate!.others.accepted > 0) claimed.add(key)
      if (decisions.get(item.id) === 'accept') claimed.add(key)
    }

    const picked: ReviewItemView[] = []
    for (const item of items) {
      if (
        item.requiresExplicitReview ||
        item.confidence < 0.7 ||
        decisions.has(item.id) ||
        // Already settled by a copy of its own; nothing left to sweep up.
        autoDeferred.has(item.id) ||
        // The database would refuse it, and a bulk action must not queue up a
        // failure. Which predicate it should have carried is a judgement, and
        // this button does not make judgements.
        (item.typeMismatch !== null && !predicates.has(item.id))
      ) {
        continue
      }
      const key = item.duplicate?.key
      if (key !== undefined) {
        if (claimed.has(key)) continue
        claimed.add(key)
      }
      picked.push(item)
    }
    return picked
  }, [autoDeferred, items, decisions, predicates])

  /**
   * Relations marked « accepter » that the database is going to refuse.
   *
   * Shown next to the publish button rather than blocking it — publishing the
   * rest of the batch is still the right move, and this says how much of it
   * will bounce. Every one of these is a link missing from the graph, which is
   * the complaint this whole notice exists to answer.
   */
  const impossible = useMemo(
    () =>
      items.filter(
        (item) =>
          item.typeMismatch !== null &&
          decisions.get(item.id) === 'accept' &&
          !predicates.has(item.id),
      ).length,
    [decisions, items, predicates],
  )

  /**
   * Copies of one proposal marked "accept" more than once, right now.
   *
   * Shown next to the publish button rather than blocking it: publishing both is
   * a legitimate thing to want if the reviewer decided the two appearances are
   * two different characters. It just must not happen by inattention.
   */
  const doubleAccepted = useMemo(() => {
    let extra = 0
    for (const [, positions] of twinsByKey) {
      const first = items[positions[0]!]!
      const already = first.duplicate?.others.accepted ?? 0
      const marked = positions.filter(
        (position) => decisions.get(items[position]!.id) === 'accept',
      ).length
      if (already + marked > 1) extra += already + marked - 1
    }
    return extra
  }, [decisions, items, twinsByKey])

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
      /*
       * Copies settled by one of their own, written down as what they are.
       *
       * Sent as real 'defer' decisions rather than left out: an item nobody
       * decides stays proposed and comes back next time, which is the opposite
       * of settled. Deferring writes nothing against the proposal's
       * fingerprint, so re-processing the chapter still offers it — all that is
       * spent is a card the reviewer would have had to press D on.
       */
      const settled: Decision[] = [...autoDeferred].map((reviewItemId) => ({
        reviewItemId,
        decision: 'defer',
      }))

      const taken: Decision[] = [...decisions].map(([reviewItemId, decision]) => {
        const item = items.find((candidate) => candidate.id === reviewItemId)
        const payload = item?.payload as Record<string, unknown> | undefined

        if (decision !== 'accept' || !item || !payload) {
          return { reviewItemId, decision }
        }

        /*
         * The predicate you picked instead of the one that could not be written.
         *
         * 'correct' rather than 'accept', same as a rename: the relation is now
         * yours — user_validated, locked, proposed by you — which is the honest
         * record of what happened. The model found the fact and got the shape
         * wrong; you chose the shape.
         */
        if (item.category === 'assertion') {
          const chosen = predicates.get(reviewItemId)
          if (!chosen || chosen === payload.predicate) return { reviewItemId, decision }
          return {
            reviewItemId,
            decision: 'correct',
            correctedPayload: { ...payload, predicate: chosen },
          }
        }

        if (item.category === 'entity') {
          const renamed = renames.get(reviewItemId)?.trim()
          if (!renamed || renamed === payload.label) return { reviewItemId, decision }

          // 'correct', not 'accept': the label is now yours. Downstream that
          // difference decides whether the glossary learns the answer, and
          // whether the row is marked as proposed by you rather than by a model.
          return {
            reviewItemId,
            decision: 'correct',
            correctedPayload: { ...payload, label: renamed, naming_confident: true },
          }
        }

        /*
         * The same correction, carried into the prose that names it.
         *
         * An event's label in the graph *is* its summary, so a summary calling
         * the character by the name you replaced would keep that name on screen
         * forever, cited from a chapter where you had already answered. Only
         * the two fields that are free prose about entities; an assertion's
         * fields are ids and a predicate, and rewriting those would be a
         * different operation with a different meaning.
         */
        const field = item.category === 'event' ? 'summary' : item.category === 'mystery' ? 'question' : null
        if (field === null || renamedLabels.length === 0) return { reviewItemId, decision }

        const original = payload[field]
        if (typeof original !== 'string') return { reviewItemId, decision }
        const rewritten = applyRenames(original, renamedLabels)
        if (rewritten === original) return { reviewItemId, decision }

        return {
          reviewItemId,
          decision: 'correct',
          correctedPayload: { ...payload, [field]: rewritten },
        }
      })

      const response = await publishDecisionsAction(queue.runId, [...settled, ...taken])
      if (response.ok && response.published) {
        setResult(response.published)
        setDecisions(new Map())
        setRenames(new Map())
        setPredicates(new Map())
      } else {
        setError(response.error ?? 'Publication impossible.')
      }
    })
  }

  const decided = decisions.size + autoDeferred.size
  const counts = {
    accept: [...decisions.values()].filter((d) => d === 'accept').length,
    reject: [...decisions.values()].filter((d) => d === 'reject').length,
    // Settled copies counted with the ones deferred by hand: they are the same
    // decision, and hiding the automatic ones from the tally would make the
    // number next to "Publier" disagree with what publishing does.
    defer:
      [...decisions.values()].filter((d) => d === 'defer').length + autoDeferred.size,
  }

  if (items.length === 0) {
    return (
      <section className="panneau mt-8">
        <h2 className="panneau-titre panneau-titre-vedette">
          {queue.chapterPublished ? 'Chapitre relu' : 'File vide'}
        </h2>
        <div className="panneau-corps">
          <p className="text-primary">
            Rien à revoir pour ce traitement.
            {queue.counts.accepted > 0 &&
              ` ${queue.counts.accepted} proposition(s) déjà publiée(s).`}
          </p>

          {queue.chapterPublished ? (
            <p className="mt-2 text-sm text-secondary">
              Le chapitre {queue.chapterNumber} est ouvert : ses faits sont
              visibles dans le graphe jusqu’à votre position de lecture.
            </p>
          ) : (
            /*
             * The chapter is decided and invisible, and nothing said so.
             *
             * The reader's boundary is the highest *published* chapter number,
             * and publication used to end at the review items — so a queue
             * emptied before this existed left its facts in the database and
             * out of every view. One click closes it, under the same rule the
             * automatic path applies.
             */
            <div className="mt-3 border-[3px] border-ink bg-[var(--accent)] px-3 py-2">
              <p className="text-sm text-ink">
                Ce chapitre n’est pas encore marqué comme relu, et tant qu’il ne
                l’est pas ses faits restent invisibles dans le graphe : la
                frontière du lecteur ne compte que les chapitres relus.
              </p>
              <button
                type="button"
                disabled={closing}
                onClick={() => {
                  setError(null)
                  startClosing(async () => {
                    const response = await markChapterReviewedAction(queue.runId)
                    if (!response.ok) setError(response.error ?? 'Opération impossible.')
                  })
                }}
                className="bouton bouton-primaire mt-3 !py-1 !text-sm"
              >
                {closing ? 'En cours…' : `Marquer le chapitre ${queue.chapterNumber} comme relu`}
              </button>
              {error && (
                <p role="alert" className="mt-2 text-sm text-ink">
                  {error}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/chapitres/${queue.chapterId}`} className="bouton">
              Revenir au chapitre
            </Link>
            {queue.chapterPublished && (
              <Link href="/graph" className="bouton">
                Voir le graphe
              </Link>
            )}
          </div>
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

          {impossible > 0 && (
            <span
              className="badge badge-rouge"
              title="Le prédicat n’accepte pas ces types : la base refusera l’écriture. Choisissez-en un autre sur la carte, ou rejetez."
            >
              {impossible} relation{impossible > 1 ? 's' : ''} impossible
              {impossible > 1 ? 's' : ''}
            </span>
          )}

          {doubleAccepted > 0 && (
            <span
              className="badge badge-rouge"
              title="Deux copies d’une même proposition acceptées : le graphe recevra deux nœuds, que rien ne rapprochera ensuite."
            >
              {doubleAccepted} doublon{doubleAccepted > 1 ? 's' : ''} accepté
              {doubleAccepted > 1 ? 's' : ''}
            </span>
          )}

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
            const settled = autoDeferred.has(item.id)
            const d = decisions.get(item.id) ?? (settled ? 'defer' : undefined)
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
                  onClick={() => jumpTo(index)}
                  aria-label={
                    item.duplicate
                      ? `Proposition ${index + 1}, copie ${item.duplicate.rank} sur ${item.duplicate.total}` +
                        (settled ? ', reportée automatiquement' : '')
                      : `Proposition ${index + 1}`
                  }
                  title={
                    settled
                      ? `Doublon reporté d’office · copie ${item.duplicate?.rank}/${item.duplicate?.total} — cliquez pour décider vous-même`
                      : item.duplicate
                        ? `Doublon · copie ${item.duplicate.rank}/${item.duplicate.total}`
                        : undefined
                  }
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
          predicate={predicates.get(current.id) ?? null}
          onPredicate={(key) =>
            setPredicates((previous) => {
              const next = new Map(previous)
              if (key === '') next.delete(current.id)
              else next.set(current.id, key)
              return next
            })
          }
          twins={twinsOfCurrent}
          onJump={jumpTo}
          onJumpToItem={(itemId) => {
            const position = items.findIndex((candidate) => candidate.id === itemId)
            if (position >= 0) jumpTo(position)
          }}
          settled={autoDeferred.has(current.id)}
          renamedLabels={renamedLabels}
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
        {result.entitiesMerged > 0 && (
          <li>
            {result.entitiesMerged} rapprochée(s) avec une entité déjà connue —
            rien de créé, les faits du chapitre sont allés sur elle
          </li>
        )}
        {result.assertionsCreated > 0 && <li>{result.assertionsCreated} relation(s)</li>}
        {result.eventsCreated > 0 && <li>{result.eventsCreated} événement(s)</li>}
        {result.mysteriesCreated > 0 && <li>{result.mysteriesCreated} mystère(s)</li>}
        {result.rejected > 0 && <li>{result.rejected} rejetée(s)</li>}
        {result.deferred > 0 && <li>{result.deferred} reportée(s)</li>}
      </ul>

      {result.chapterPublished !== null && (
        <p className="mt-3 border-[3px] border-ink bg-[var(--epi-validated)] px-3 py-2 text-sm text-ink">
          Chapitre {result.chapterPublished} relu de bout en bout : il est
          maintenant ouvert, et ses faits apparaissent dans le graphe.
        </p>
      )}

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

/** A copy of the proposal on screen, and what has been decided about it. */
interface Twin {
  /** Its index in the queue, so the reviewer can jump to it. */
  position: number
  decision: DecisionKind | null
  /** Settled by an accept on one of its copies rather than by hand. */
  auto: boolean
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
  predicate,
  onPredicate,
  twins,
  onJump,
  onJumpToItem,
  settled,
  renamedLabels,
}: {
  item: ReviewItemView
  index: number
  total: number
  decision: DecisionKind | null
  onDecide: (decision: DecisionKind) => void
  onMove: (delta: number) => void
  rename: string | null
  onRename: (label: string) => void
  /** The predicate the reviewer chose in place of the one proposed. */
  predicate: string | null
  onPredicate: (key: string) => void
  twins: Twin[]
  onJump: (position: number) => void
  onJumpToItem: (itemId: string) => void
  /** Deferred by an accept on one of its copies rather than by hand. */
  settled: boolean
  renamedLabels: RenamePair[]
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
            {item.mergeSuggestion && (
              <MergeNotice
                suggestion={item.mergeSuggestion}
                onJumpToItem={onJumpToItem}
              />
            )}
            {item.duplicate && (
              <DuplicateNotice
                duplicate={item.duplicate}
                twins={twins}
                onJump={onJump}
                settled={settled}
              />
            )}
            {item.typeMismatch && (
              <TypeMismatchNotice
                mismatch={item.typeMismatch}
                names={item.names}
                payload={item.payload}
                chosen={predicate}
                onChoose={onPredicate}
              />
            )}
            <ProposalBody
              category={item.category}
              payload={item.payload}
              relatedLabel={item.relatedLabel}
              names={item.names}
              rename={rename}
              onRename={onRename}
              chosenPredicate={predicate}
              renamedLabels={renamedLabels}
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

/**
 * « C'est peut-être quelqu'un que vous connaissez déjà », said on the card.
 *
 * A chapter names again someone already in the graph — « Zoro » where you
 * settled « Roronoa Zoro » — and two cards are produced: this entity, and a
 * rapprochement asking whether they are the same. Deciding this one alone is
 * how a second Zoro is created, and the two can be forty apart in the queue.
 *
 * The notice does not decide anything and does not hide the buttons: judging
 * that the rapprochement is wrong and accepting a genuinely new character is a
 * legitimate answer. It says where the question that settles this one lives.
 */
function MergeNotice({
  suggestion,
  onJumpToItem,
}: {
  suggestion: NonNullable<ReviewItemView['mergeSuggestion']>
  onJumpToItem: (itemId: string) => void
}) {
  return (
    <div className="mb-3 border-[3px] border-ink bg-[var(--epi-hypothetical)] px-2 py-1.5 text-ink">
      <p className="font-display text-sm uppercase">
        Peut-être une entité déjà connue
      </p>
      <p className="mt-1 text-sm">
        Un rapprochement propose que ce soit
        {suggestion.existingLabel ? ` « ${suggestion.existingLabel} »` : ' une entité déjà publiée'}
        . C&apos;est là-bas que ça se décide : accepter le rapprochement rattache
        les faits de ce chapitre à l&apos;entité existante, sans créer de second
        nœud. Accepter cette carte-ci sans lui, c&apos;est créer le doublon.
      </p>
      <button
        type="button"
        onClick={() => onJumpToItem(suggestion.reviewItemId)}
        className="bouton mt-1.5 !py-0.5 !text-xs"
      >
        Aller au rapprochement
      </button>
    </div>
  )
}

/**
 * « La base va refuser celle-ci », said before publishing rather than after.
 *
 * A predicate carries the node types it accepts and the database enforces it,
 * so « Monkey D. Luffy member_of Village de Fuchsia » never reaches the graph:
 * member_of is for crews. That refusal was arriving in the red block *after*
 * « Publier », among twenty successes, with nothing to do about it — and every
 * one of them is a link missing from the graph afterwards.
 *
 * The list is not an error message but the repair. The fact is almost always
 * right and only the predicate is wrong: Luffy really does live in Fuchsia, and
 * `located_at` says so in a way the graph can hold. So every predicate that
 * accepts these two types is offered, in ontology order — grouped by meaning,
 * which puts the spatial ones first for a character and a place.
 *
 * Nothing is preselected. Choosing for the reviewer would make the correction
 * invisible, and « the model said member_of, the interface silently wrote
 * located_at » is exactly the kind of quiet rewriting this repository refuses.
 */
function TypeMismatchNotice({
  mismatch,
  names,
  payload,
  chosen,
  onChoose,
}: {
  mismatch: NonNullable<ReviewItemView['typeMismatch']>
  names: Record<string, string>
  payload: unknown
  chosen: string | null
  onChoose: (key: string) => void
}) {
  const record = (payload ?? {}) as Record<string, unknown>
  const nameOf = (id: unknown) =>
    typeof id === 'string' ? (names[id] ?? id) : 'cette entité'

  const culprit = !mismatch.objectAccepted
    ? {
        end: nameOf(record.object),
        type: mismatch.objectType,
        expected: mismatch.expectedObjectTypes,
        role: 'objet',
      }
    : {
        end: nameOf(record.subject),
        type: mismatch.subjectType,
        expected: mismatch.expectedSubjectTypes,
        role: 'sujet',
      }

  return (
    <div className="mb-3 border-[3px] border-ink bg-[var(--coral)] px-2 py-1.5 text-white">
      <p className="font-display text-sm uppercase">
        Relation impossible en l&apos;état
      </p>

      <p className="mt-1 text-sm">
        « {predicateLabel(mismatch.predicate)} » n&apos;accepte pas{' '}
        {culprit.role === 'objet' ? 'un objet' : 'un sujet'} de type «{' '}
        {culprit.type} » — or {culprit.end} en est un. Attendu :{' '}
        {culprit.expected.join(', ')}. Acceptée telle quelle, elle sera refusée à
        l&apos;écriture et le lien manquera dans le graphe.
      </p>

      {mismatch.alternatives.length > 0 ? (
        <label className="mt-2 block">
          <span className="font-display text-xs uppercase">
            Écrire plutôt
          </span>
          <select
            value={chosen ?? ''}
            onChange={(event) => onChoose(event.target.value)}
            className="mt-1 w-full border-[3px] border-ink bg-surface-raised px-2 py-1 text-base text-primary"
          >
            <option value="">— garder « {predicateLabel(mismatch.predicate)} » (sera refusée) —</option>
            {mismatch.alternatives.map((alternative) => (
              <option key={alternative.key} value={alternative.key}>
                {alternative.labelFr} ({alternative.key})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-1 text-sm">
          Aucun prédicat de l&apos;ontologie n&apos;accepte ces deux types. Il
          n&apos;y a rien à corriger ici : rejetez.
        </p>
      )}

      {chosen && (
        <p className="mt-1.5 text-sm">
          Enregistrée comme votre correction : la relation sera marquée validée
          par vous plutôt que proposée par le modèle.
        </p>
      )}
    </div>
  )
}

/**
 * "Have I already accepted this one?", answered on the card.
 *
 * The copies are listed with what was decided about each, and each is a button:
 * the reviewer can go and look rather than trust a summary. What it never does
 * is decide — two copies can legitimately both be accepted when the reviewer
 * judges the appearances to be two different characters, which is precisely the
 * case the extraction prompt is written to produce. This states the situation
 * and hands it back.
 */
function DuplicateNotice({
  duplicate,
  twins,
  onJump,
  settled,
}: {
  duplicate: DuplicateInfo
  twins: Twin[]
  onJump: (position: number) => void
  settled: boolean
}) {
  const published = duplicate.others.accepted
  const markedElsewhere = twins.some((twin) => twin.decision === 'accept')
  const discarded = duplicate.others.rejected + duplicate.others.deferred

  return (
    <div
      className={`mb-3 border-[3px] border-ink px-2 py-1.5 ${
        published > 0 || markedElsewhere
          ? 'bg-[var(--coral)] text-white'
          : 'bg-[var(--epi-hypothetical)] text-ink'
      }`}
    >
      <p className="font-display text-sm uppercase">
        Doublon · copie {duplicate.rank} sur {duplicate.total}
        {settled && ' · reportée d’office'}
      </p>

      <p className="mt-1 text-sm">
        {published > 0
          ? `${published} copie${published > 1 ? 's' : ''} déjà acceptée${
              published > 1 ? 's' : ''
            } et publiée${published > 1 ? 's' : ''} : accepter celle-ci ajouterait un ` +
            `second nœud au graphe, que rien ne rapprochera ensuite.`
          : markedElsewhere
            ? 'Une autre copie est déjà marquée « accepter ». Une seule suffit.'
            : 'Le chapitre est extrait par tranches, et la même proposition revient ' +
              'd’une tranche à l’autre. N’en acceptez qu’une — sauf si vous jugez ' +
              'qu’il s’agit de deux apparitions différentes.'}
      </p>

      {settled && (
        <p className="mt-1 text-sm">
          Celle-ci part en « reporter » sans que vous ayez à le dire, et ne vous
          sera plus présentée. Décidez-en quand même si vous jugez qu’il s’agit
          d’autre chose : votre choix l’emporte toujours.
        </p>
      )}

      {discarded > 0 && (
        <p className="mt-1 text-sm">
          {duplicate.others.rejected > 0 &&
            `${duplicate.others.rejected} rejetée(s)`}
          {duplicate.others.rejected > 0 && duplicate.others.deferred > 0 && ' · '}
          {duplicate.others.deferred > 0 &&
            `${duplicate.others.deferred} reportée(s)`}
          {' lors d’une publication précédente.'}
        </p>
      )}

      {twins.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {twins.map((twin) => (
            <li key={twin.position}>
              <button
                type="button"
                onClick={() => onJump(twin.position)}
                className="bouton !py-0.5 !text-xs"
              >
                n°{twin.position + 1} · {twinStateLabel(twin)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function twinStateLabel(twin: Twin): string {
  const labels: Partial<Record<DecisionKind, string>> = {
    accept: '✓ acceptée',
    reject: '✕ rejetée',
    defer: '⏸ reportée',
  }
  if (twin.decision) return labels[twin.decision] ?? twin.decision
  return twin.auto ? '⏸ reportée d’office' : 'pas encore décidée'
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

/**
 * One end of a relation: its name, or an admission that it has none.
 *
 * An identifier that resolved to nothing is shown truncated and marked as an
 * identifier, rather than dressed up as a name. The reviewer then knows the
 * card is incomplete — which is a decision they can take — instead of reading a
 * hex string as a character.
 */
function EntityEnd({ id, name }: { id: string; name: string | null }) {
  if (name !== null) return <span className="font-medium">{name}</span>

  return (
    <span
      className="font-mono text-sm text-muted"
      title={`Identifiant non résolu : ${id}`}
    >
      entité {id.slice(0, 8)}…
    </span>
  )
}

function ProposalBody({
  category,
  payload,
  relatedLabel,
  names,
  rename,
  onRename,
  chosenPredicate,
  renamedLabels,
}: {
  category: string
  payload: unknown
  relatedLabel: string | null
  names: Record<string, string>
  rename: string | null
  onRename: (label: string) => void
  chosenPredicate: string | null
  renamedLabels: RenamePair[]
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
    /*
     * Ends shown by name, and renamed with the rest of the batch.
     *
     * What is stored is an identifier — `e3` for an entity proposed in the same
     * response, a UUID for one already in the graph — and a card reading
     * « 9fdd1160-… capture 5da604bb-… » asks the reviewer to accept a relation
     * between two things they cannot see. The names come resolved from the
     * queue; the rename pass is applied on top, so an end renamed two cards
     * earlier reads as the name that will actually be stored.
     */
    const end = (id: unknown) => {
      const raw = typeof id === 'string' ? id : ''
      const known = names[raw]
      if (known === undefined) return null
      return applyRenames(known, renamedLabels)
    }

    const subject = String(record.subject ?? '')
    const object = record.object === null || record.object === undefined
      ? null
      : String(record.object)

    // Read under the predicate you chose, for the same reason an event is read
    // under the names you settled: this is the version that will be stored.
    const written = String(record.predicate ?? '')
    const shown = chosenPredicate ?? written

    return (
      <div className="mt-2">
        <p className="text-primary">
          <EntityEnd id={subject} name={end(record.subject)} />{' '}
          <span
            className={`text-sm ${shown !== written ? 'text-[var(--epi-validated)]' : 'text-accent'}`}
          >
            {predicateLabel(shown)}
          </span>{' '}
          {object !== null ? (
            <EntityEnd id={object} name={end(record.object)} />
          ) : (
            <span className="font-medium">{String(record.object_value ?? '')}</span>
          )}
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
    /*
     * Shown under the names you have settled, not the ones the model chose.
     *
     * The summary was written during extraction, before any decision, so it
     * carries the model's first attempt at every name — and an event's label in
     * the graph *is* its summary. Reading « Le Seigneur de la Côte » on this
     * card after renaming that entity two cards earlier is being shown a name
     * you have already replaced, and accepting it would store it.
     */
    const written = String(record.summary ?? '')
    const shown = applyRenames(written, renamedLabels)

    return (
      <div className="mt-2">
        <p className="text-primary">{shown}</p>
        {shown !== written && (
          <p className="mt-1.5 text-sm text-[var(--epi-validated)]">
            Récrit avec les noms que vous avez tranchés dans ce lot — c’est cette
            version qui sera enregistrée.
          </p>
        )}
        {record.is_flashback === true && (
          <p className="mt-1 text-sm text-[var(--epi-hypothetical)]">
            Présenté comme un souvenir : montré ici, survenu plus tôt.
          </p>
        )}
      </div>
    )
  }

  if (category === 'mystery') {
    const written = String(record.question ?? '')
    const shown = applyRenames(written, renamedLabels)

    return (
      <div className="mt-2">
        <p className="text-primary">{shown}</p>
        {shown !== written && (
          <p className="mt-1.5 text-sm text-[var(--epi-validated)]">
            Récrit avec les noms que vous avez tranchés dans ce lot.
          </p>
        )}
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
