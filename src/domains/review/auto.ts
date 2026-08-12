import 'server-only'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import { publishDecisions, type Decision, type PublishResult } from './publish.ts'

/**
 * Decide everything a name does not depend on, and leave the names.
 *
 * A deliberate narrowing of "the AI proposes, the human decides", chosen by the
 * owner of this library for a reason the numbers make plain: one chapter is
 * eighty-six cards, there are more than a thousand chapters, and the decisions
 * that actually need a person are the handful where the model says it does not
 * know what to call something. Everything else was being accepted by a reflex,
 * and a reflex is not review — it is the appearance of review, which is worse
 * than admitting the work is automatic.
 *
 * What that costs is stated rather than hidden: identity claims, deaths, hidden
 * affiliations and mystery resolutions now enter the graph unread. Those are the
 * proposals `requiresExplicitReview` was built to hold back, and a wrong one
 * rewrites what the reader knew at every earlier chapter with nothing on screen
 * to reveal it. The counterweight is that nothing here is destructive: every
 * assertion keeps its evidence, the boundary still dates it by revelation, and
 * a mistake is visible on the entity's own sheet and reversible from it.
 *
 * Off unless asked for, and asked for in configuration rather than in code. The
 * test suite encodes the opposite guarantee — a run produces proposals, not
 * canon — as blocking anti-spoiler scenarios, and a product default that made
 * twenty of them fail would not be a feature, it would be the guarantee quietly
 * withdrawn. `AUTO_REVIEW_NAMES_ONLY=1` is one line in an environment, states
 * exactly what it does, and is as easy to take back.
 *
 * Two things this must get right, both about ordering rather than policy:
 *
 *   A relation whose subject is held back for a naming question has to wait with
 *   it. Publishing it now would fail — its entity does not exist yet — and the
 *   failure would be silent in an automatic pass.
 *
 *   A contradiction cannot be accepted at all: publication has no path for one,
 *   so an "accept" would leave it proposed for ever and the chapter would never
 *   count as read. Those are deferred, and the note says so.
 *
 *   A rapprochement is neither accepted nor deferred but left standing, with
 *   the proposal it is about. It is publishable now — accepting one folds the
 *   proposal into the entity you already have — and it is the last question
 *   this pass refuses to take on its own.
 */

/**
 * Whether this instance reviews only the names.
 *
 * Read at call time rather than at import: a test that turns it on for one
 * scenario must not depend on the order modules happened to load in.
 */
export function autoReviewEnabled(): boolean {
  return process.env.AUTO_REVIEW_NAMES_ONLY === '1'
}

export interface AutoReviewResult {
  /** Proposals accepted without a human reading them. */
  accepted: number
  /** Naming questions left for the reviewer. */
  heldForNaming: number
  /** Identity questions left for the reviewer, with what they hold up. */
  heldForIdentity: number
  /** Relations left waiting on one of those names. */
  heldByName: number
  /** Categories publication cannot apply, parked rather than accepted. */
  deferred: number
  published: PublishResult | null
}

interface Pending {
  id: string
  category: string
  payload: Record<string, unknown>
  fingerprint: string
}

/** The one category nothing knows how to publish. See the note above. */
const UNPUBLISHABLE = new Set(['conflict'])

export async function autoReview(
  userId: string,
  runId: string,
): Promise<AutoReviewResult> {
  const pending = await withIngest(async (db) => {
    const rows = await db
      .select({
        id: reviewItems.id,
        category: reviewItems.category,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          eq(reviewItems.status, 'proposed'),
        ),
      )
    return rows as Pending[]
  })

  const result: AutoReviewResult = {
    accepted: 0,
    heldForNaming: 0,
    heldForIdentity: 0,
    heldByName: 0,
    deferred: 0,
    published: null,
  }

  if (pending.length === 0) return result

  /*
   * The one question that stays human: what do we call this?
   *
   * `naming_confident: false` is the model raising its hand — it knows the
   * entity is there and does not know whether the French form is a translation
   * or the source wording kept. That is a convention held by the reader, not a
   * fact in the text, and a model left to decide it decides differently each
   * chapter: two labels, honestly derived, and one person split in two.
   */
  const heldLocalIds = new Set<string>()
  for (const item of pending) {
    if (item.category !== 'entity') continue
    if (item.payload.naming_confident !== false) continue
    const localId = typeof item.payload.local_id === 'string' ? item.payload.local_id : ''
    if (localId.length > 0) heldLocalIds.add(localId)
  }

  /*
   * The other question that stays human: is this someone we already know?
   *
   * A rapprochement is now publishable — accepting it folds the proposal into
   * the entity you already have — which makes deferring it the wrong answer
   * rather than the only one. It is also the last question this pass may take
   * on its own: accepting the entity while its rapprochement sleeps is how a
   * second Zoro enters a graph that will never join the two back, and no score
   * routes an identity past a human.
   *
   * So the rapprochement is held, and so are the proposal it is about and the
   * relations naming it. The chapter stays in review until it is answered —
   * which is correct: it has not been read to the end while the question of who
   * this is remains open.
   */
  const contested = new Set<string>()
  for (const item of pending) {
    if (item.category !== 'resolution') continue
    const fingerprint = item.payload.candidateFingerprint
    if (typeof fingerprint === 'string') contested.add(fingerprint)
  }

  for (const item of pending) {
    if (item.category !== 'entity') continue
    if (!contested.has(item.fingerprint)) continue
    const localId = typeof item.payload.local_id === 'string' ? item.payload.local_id : ''
    if (localId.length > 0) heldLocalIds.add(localId)
  }

  const decisions: Decision[] = []

  for (const item of pending) {
    if (UNPUBLISHABLE.has(item.category)) {
      decisions.push({ reviewItemId: item.id, decision: 'defer' })
      result.deferred++
      continue
    }

    if (item.category === 'resolution') {
      result.heldForIdentity++
      continue
    }

    if (item.category === 'entity' && contested.has(item.fingerprint)) {
      // Held with its rapprochement, not counted twice: the question is the
      // rapprochement's, and this card follows it.
      continue
    }

    if (item.category === 'entity' && item.payload.naming_confident === false) {
      result.heldForNaming++
      continue
    }

    if (item.category === 'assertion') {
      const subject = typeof item.payload.subject === 'string' ? item.payload.subject : ''
      const object = typeof item.payload.object === 'string' ? item.payload.object : ''
      if (heldLocalIds.has(subject) || heldLocalIds.has(object)) {
        // Waits for the name. Published now it would fail on a subject that
        // does not exist, and an automatic pass has nobody to show that to.
        result.heldByName++
        continue
      }
    }

    decisions.push({ reviewItemId: item.id, decision: 'accept' })
    result.accepted++
  }

  if (decisions.length === 0) return result

  result.published = await publishDecisions(userId, runId, decisions)
  return result
}

/** One line for the run's progress view, or for the note after a publication. */
export function autoReviewNote(result: AutoReviewResult): string {
  const parts = [`${result.accepted} proposition(s) acceptées d'office`]

  if (result.heldForNaming > 0) {
    parts.push(
      `${result.heldForNaming} question(s) de nom laissée(s) à trancher` +
        (result.heldByName > 0 ? ` (+ ${result.heldByName} relation(s) en attente)` : ''),
    )
  }
  if (result.heldForIdentity > 0) {
    parts.push(
      `${result.heldForIdentity} rapprochement(s) laissé(s) à trancher — ` +
        `personne d'autre ne décide d'une identité`,
    )
  }
  if (result.deferred > 0) {
    parts.push(
      `${result.deferred} contradiction(s) reportée(s) — ` +
        `leur publication n'est pas implémentée`,
    )
  }
  if (result.published && result.published.failures.length > 0) {
    parts.push(`${result.published.failures.length} non appliquée(s)`)
  }
  if (result.published?.chapterPublished !== null && result.published !== null) {
    parts.push(`chapitre ${result.published.chapterPublished} ouvert`)
  }

  return parts.join(' · ')
}
