import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { ingestionRuns, reviewItems } from '@/db/schema/ingestion.ts'
import { AUTO_ACCEPT_CONFIDENCE, confidentEnough } from './confidence.ts'
import { mismatchOf, resolveNodeTypes } from './queue.ts'
import {
  markChapterReviewed,
  publishDecisions,
  type Decision,
  type PublishResult,
} from './publish.ts'

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
 * Off unless asked for, and asked for per chapter or in configuration rather
 * than in code. The test suite encodes the opposite guarantee — a run produces
 * proposals, not canon — as blocking anti-spoiler scenarios, and a product
 * default that made twenty of them fail would not be a feature, it would be the
 * guarantee quietly withdrawn.
 *
 * Two ways to ask, and they mean different things. `AUTO_REVIEW_NAMES_ONLY=1`
 * is the whole instance, one line in an environment, as easy to take back.
 * `chapters.auto_review` is one import saying so: a batch of twenty asked to
 * run to the end without stopping at every chapter, while the single chapter
 * you paste tomorrow still arrives as a queue of proposals. The second is the
 * one the batch form sets, because "catch up on a hundred chapters" and "read
 * the one that came out this week" are not the same act and should not be the
 * same setting.
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
 *
 * And one about the model rather than about the category: a proposal the model
 * itself is unsure of is left standing too. `AUTO_ACCEPT_CONFIDENCE` is the line
 * — three quarters — and it is the same line the review board draws on screen.
 * Everything above it enters the graph unread, which is what this mode is for;
 * everything below it is exactly the handful of cards a person is worth being
 * asked about, so they wait, and the chapter waits with them.
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

/**
 * The confidence a proposal has to carry to be decided without a reader.
 *
 * `AUTO_ACCEPT_CONFIDENCE` is the answer, and the environment may move it —
 * read at call time, like the mode above, so a test or an instance can set it
 * without depending on the order modules happened to load in. A value outside
 * [0, 1], or one that is not a number at all, is ignored rather than obeyed: a
 * typo in an environment file must not silently accept everything.
 *
 * Zero is a legitimate setting and means what it says — accept whatever the
 * category rules allow, whatever the model thought of it. That is the behaviour
 * this pass had before the threshold existed, and the tests that pin the
 * category rules keep asking for it, because the synthetic provider has no
 * confidence to offer and its numbers say nothing about the rule under test.
 */
export function autoAcceptThreshold(): number {
  const raw = process.env.AUTO_ACCEPT_CONFIDENCE?.trim()
  if (raw === undefined || raw === '') return AUTO_ACCEPT_CONFIDENCE

  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) return AUTO_ACCEPT_CONFIDENCE
  return value
}

/**
 * Whether this chapter reviews itself: the instance says so, or its import did.
 *
 * The environment flag is checked first and without a query, so an instance
 * running in that mode costs nothing extra per run.
 */
export async function autoReviewsChapter(
  userId: string,
  chapterId: string,
): Promise<boolean> {
  if (autoReviewEnabled()) return true

  return withIngest(async (db) => {
    const [row] = await db
      .select({ autoReview: chapters.autoReview })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    return row?.autoReview ?? false
  })
}

/**
 * The same question asked from a run.
 *
 * The review centre holds a run id and never a chapter id, and the answer has
 * to be the chapter's: publishing an answer to the one held name must release
 * the rest for a chapter imported automatically, and must release nothing for a
 * chapter someone chose to read card by card.
 */
export async function autoReviewsRun(userId: string, runId: string): Promise<boolean> {
  if (autoReviewEnabled()) return true

  return withIngest(async (db) => {
    const [row] = await db
      .select({ autoReview: chapters.autoReview })
      .from(ingestionRuns)
      .innerJoin(chapters, eq(chapters.id, ingestionRuns.chapterId))
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.userId, userId)))
      .limit(1)
    return row?.autoReview ?? false
  })
}

/**
 * Mark chapters as reviewing themselves.
 *
 * Written at import, before anything is queued: the run reads the flag, and a
 * run that started a moment before the flag was set would review the chapter
 * the other way round with nothing to explain it.
 */
export async function enableAutoReview(
  userId: string,
  chapterIds: string[],
): Promise<number> {
  if (chapterIds.length === 0) return 0

  return withIngest(async (db) => {
    const updated = await db
      .update(chapters)
      .set({ autoReview: true, updatedAt: new Date() })
      .where(and(eq(chapters.userId, userId), inArray(chapters.id, chapterIds)))
      .returning({ id: chapters.id })
    return updated.length
  })
}

export interface AutoReviewResult {
  /** Proposals accepted without a human reading them. */
  accepted: number
  /** Naming questions left for the reviewer. */
  heldForNaming: number
  /** Identity questions left for the reviewer, with what they hold up. */
  heldForIdentity: number
  /** Proposals the model was not sure enough of, left for the reviewer. */
  heldByConfidence: number
  /**
   * Relations and scenes left waiting on a proposal that is itself held.
   *
   * For its name or for its confidence, and the two are the same problem from
   * here: publishing a relation whose subject stayed behind fails on an entity
   * that does not exist, and an automatic pass has nobody to show that to.
   */
  heldByName: number
  /** Relations the ontology refuses as written, left for a human to reshape. */
  heldByTypes: number
  /** Categories publication cannot apply, parked rather than accepted. */
  deferred: number
  published: PublishResult | null
  /**
   * The chapter this pass opened without publishing anything.
   *
   * A run can legitimately queue nothing at all: every proposal it made was
   * already decided under the same fingerprint — a re-import, or a chapter
   * whose content repeats one you have answered — so extraction re-applies the
   * decisions and leaves an empty queue. Nothing to publish is not nothing to
   * do: "no proposal left" is the exact condition for a chapter being read to
   * the end, and without this the chapter stayed in review for ever and a lot
   * chaining on publications stopped dead at it, with nothing on screen naming
   * the reason.
   *
   * Null when a publication opened it instead — `published.chapterPublished`
   * carries that one — or when it is not open.
   */
  chapterOpened: number | null
}

interface Pending {
  id: string
  category: string
  payload: Record<string, unknown>
  fingerprint: string
  confidence: number
}

/**
 * Open the chapter — but only if there was ever anything to review.
 *
 * "Nothing left proposed" has two causes and they are opposites. A review that
 * happened and is finished leaves decided cards behind it; an extraction that
 * produced *nothing* leaves the same empty queue and means the chapter has not
 * been read at all — the model refused, or every proposal it made was
 * quarantined for evidence nobody could verify.
 *
 * Opening on the second is how thirty-six chapters entered a library marked as
 * published with nothing in them: no proposal, therefore nothing to decide,
 * therefore — by a rule written for the first case — read to the end. Each one
 * then released the next, so the mistake did not stop at one chapter, it walked
 * the whole lot.
 *
 * So the chapter must carry at least one review item, in any state and from any
 * run of it. That is the trace a review leaves and the thing an empty
 * extraction cannot fake. A chapter that has none stays where it is, and the
 * lot stops on it and says so — `batchStatus` calls it `empty`, which is a
 * sentence someone can act on.
 */
async function openIfSomethingWasReviewed(
  userId: string,
  runId: string,
): Promise<number | null> {
  const everProposed = await withIngest(async (db) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reviewItems)
      .innerJoin(ingestionRuns, eq(ingestionRuns.chapterId, reviewItems.chapterId))
      .where(and(eq(ingestionRuns.id, runId), eq(reviewItems.userId, userId)))
    return Number(row?.count ?? 0)
  })

  if (everProposed === 0) return null
  return markChapterReviewed(userId, runId)
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
        confidence: reviewItems.confidence,
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
    heldByConfidence: 0,
    heldByName: 0,
    heldByTypes: 0,
    deferred: 0,
    published: null,
    chapterOpened: null,
  }

  if (pending.length === 0) {
    result.chapterOpened = await openIfSomethingWasReviewed(userId, runId)
    return result
  }

  /*
   * Relations the ontology cannot express as written.
   *
   * « Monkey D. Luffy member_of Village de Fuchsia » — a true fact carrying a
   * predicate meant for crews, which the database refuses (ADR 0004). Accepting
   * it here would spend a publication on a failure nobody is watching, and the
   * red block listing it would appear on a screen this pass never shows anyone.
   *
   * So it is left proposed rather than deferred: the review card knows how to
   * offer the predicates that *would* accept these two ends, and choosing one
   * is a judgement about meaning. That is precisely the kind of question this
   * pass hands back.
   */
  const nodeTypes = await resolveNodeTypes(pending, pending)

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

  /*
   * And the question the model asks about itself: how sure was it?
   *
   * Below the threshold nothing is accepted, whatever the category. A scene is
   * held here as well as an entity, and for the reason the naming rule holds
   * entities: both are pointed at by relations, both would publish a card whose
   * end does not exist, and an event fails silently where a relation at least
   * fails. So a doubtful one joins the held set and takes its dependants with
   * it, rather than leaving half a chapter written against a scene nobody kept.
   */
  const threshold = autoAcceptThreshold()
  for (const item of pending) {
    if (item.category !== 'entity' && item.category !== 'event') continue
    if (confidentEnough(item.confidence, threshold)) continue
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

    /*
     * The model's own doubt, taken at face value.
     *
     * Counted before the dependency checks below, so a card held on its own
     * merit is reported as such: « en dessous du seuil » is something the
     * reviewer can act on, « en attente d'un nom » about a card whose own score
     * is 0.3 would send them looking for a naming question that does not exist.
     */
    if (!confidentEnough(item.confidence, threshold)) {
      result.heldByConfidence++
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
      if (mismatchOf(item.payload, nodeTypes) !== null) {
        result.heldByTypes++
        continue
      }
    }

    if (item.category === 'event') {
      /*
       * An event waits for its cast, for the same reason a relation waits for
       * its subject.
       *
       * Publishing it now records the presence of whoever already exists and
       * silently records nothing for the rest — and unlike a relation, there is
       * no failure to show for it: the event publishes cleanly, one name short,
       * and nobody ever learns which. Held, it publishes complete once the
       * naming question is answered.
       */
      const cast = Array.isArray(item.payload.participants)
        ? item.payload.participants
        : []
      if (cast.some((id) => typeof id === 'string' && heldLocalIds.has(id))) {
        result.heldByName++
        continue
      }
    }

    decisions.push({ reviewItemId: item.id, decision: 'accept' })
    result.accepted++
  }

  /*
   * Nothing to accept is still an answer about the chapter.
   *
   * Either everything left is held for a person — in which case the rule finds
   * proposals outstanding and opens nothing, which is right — or what remained
   * was deferred, and a chapter whose last cards were parked has been read to
   * the end as surely as one whose cards were accepted.
   */
  if (decisions.length === 0) {
    result.chapterOpened = await openIfSomethingWasReviewed(userId, runId)
    return result
  }

  result.published = await publishDecisions(userId, runId, decisions)

  /*
   * The same sweep after publishing, for the run whose decisions all failed.
   *
   * `publishDecisions` opens the chapter itself when its own batch leaves
   * nothing proposed. It cannot when every decision landed in `failures`: those
   * items keep their `proposed` status, so the chapter is legitimately not
   * open — and this call finds the same thing and writes nothing. It matters
   * for the case in between, where a deferred item was the last card.
   */
  if (result.published.chapterPublished === null) {
    result.chapterOpened = await openIfSomethingWasReviewed(userId, runId)
  }

  return result
}

/** One line for the run's progress view, or for the note after a publication. */
export function autoReviewNote(result: AutoReviewResult): string {
  const parts = [`${result.accepted} proposition(s) acceptées d'office`]

  if (result.heldForNaming > 0) {
    parts.push(`${result.heldForNaming} question(s) de nom laissée(s) à trancher`)
  }
  /*
   * Its own line rather than a parenthesis behind the naming count: a name is
   * no longer the only thing a relation can be waiting on, and a « (+ 12
   * relations en attente) » printed behind « 0 question de nom » — which is
   * what the parenthesis did once a card could be held for its confidence —
   * names the wrong cause for twelve cards.
   */
  if (result.heldByName > 0) {
    parts.push(`${result.heldByName} carte(s) en attente d'une proposition retenue`)
  }
  if (result.heldByConfidence > 0) {
    parts.push(
      `${result.heldByConfidence} proposition(s) sous le seuil de confiance ` +
        `(${Math.round(autoAcceptThreshold() * 100)} %) laissée(s) à trancher`,
    )
  }
  if (result.heldByTypes > 0) {
    parts.push(
      `${result.heldByTypes} relation(s) au prédicat incompatible — ` +
        `la carte propose ceux qui conviennent`,
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
  } else if (result.chapterOpened !== null) {
    parts.push(`chapitre ${result.chapterOpened} ouvert — rien ne restait à décider`)
  }

  return parts.join(' · ')
}
