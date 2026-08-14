import 'server-only'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import type { withIngest } from '@/db/boundary.ts'
import { entities, entityLabels } from '@/db/schema/knowledge.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { tokenOverlap } from '@/domains/resolution/scoring.ts'

/**
 * Has this chapter already told us this?
 *
 * `duplicates.ts` answers a neighbouring question and deliberately answers only
 * that one: whether two proposals *of the same run* are word-for-word the same.
 * It is exact on purpose, and it should stay exact — a similarity score in the
 * grouping key would train the reviewer to dismiss the signal.
 *
 * This is the other half, and the one a real library hit. A chapter processed
 * twice produces two runs, and the model does not phrase a scene identically
 * twice: « Kuina meurt en tombant dans les escaliers ; Zoro obtient son sabre et
 * jure de réaliser leur rêve à sa place » and « … le lendemain ; … et jure
 * d'honorer leur promesse à sa place » are the same memory, written twice. The
 * within-run grouping never sees them (different runs), the exact twin check at
 * publication never sees them (different words), and each accepted copy becomes
 * its own entity — because an event *is* an entity here, with a side table. Two
 * nodes for one scene, and nothing will ever join them back.
 *
 * Two thresholds rather than one, because the two mistakes are not symmetric.
 * Telling a reviewer « this resembles something you already have » costs a
 * glance and is worth making early. Refusing to publish costs them a real
 * event, so it waits until the texts are practically the same. In between —
 * where the second version adds « le lendemain », genuinely new information —
 * nobody but the reader can say whether that is one memory or two, and the
 * design has an answer for that: show it, do not decide it.
 */

/*
 * Both numbers are measured, not chosen. Word overlap on the pairs that
 * prompted this, punctuation stripped:
 *
 *   0.10  « Zoro affronte Morgan » / « Zoro promet à Koby » — two scenes that
 *         merely share a cast, which is the case a looser floor would ruin
 *   0.67  Kuina's death, told twice, the second adding « le lendemain » and
 *         swapping « leur rêve » for « leur promesse »
 *   0.83  the same sentence with one adverb inserted
 *   0.86  Luffy's human shield, the second version adding « face aux Marines »
 *
 * The floor sits below the rephrasing, the ceiling above the pairs that differ
 * by a few words and below the rephrasing that carries new information. The gap
 * between them is where the reviewer, and only the reviewer, can answer.
 */

/** Shown on the card. Below this, resemblance is coincidence of vocabulary. */
export const ECHO_WORTH_SHOWING = 0.6

/** Refused at publication. Above this, the two texts say the same thing. */
export const ECHO_TOO_CLOSE = 0.8

/**
 * Sentences, not names.
 *
 * `tokens()` splits on spaces and keeps whatever punctuation is attached, which
 * is harmless for the labels it was written for — a name rarely ends in a full
 * stop. An event summary always does, and « humain. » failing to match
 * « humain » cost a tenth of the score on the very pair this exists to catch.
 * Stripped here rather than in `tokens()`, because that function is what entity
 * resolution scores names with and its thresholds are tuned against its current
 * behaviour.
 */
function asSentence(value: string): string {
  return value.replace(/[.,;:!?«»"()[\]…]/g, ' ')
}

export interface Echo {
  /** The entity already in the graph. */
  entityId: string
  /** Its text — an event's summary, a mystery's question. */
  label: string
  /** Where the reader met it. */
  chapterNumber: number
  /** Word overlap, 0 to 1. */
  overlap: number
}

/**
 * Trigram first, words second.
 *
 * The blocking query is the same idiom `steps/resolve.ts` uses, and for the same
 * reason: an index scan narrows a whole work's events to a handful, and only
 * then is anything scored. Scoring every stored event against every proposal
 * would be quadratic in the size of the library, to answer a question about one
 * chapter.
 */
const TRIGRAM_FLOOR = 0.3

export async function findEcho(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: {
    workId: string
    userId: string
    /**
     * The node types whose label is their text: the three occurrence types for
     * an event, `mystery` for a mystery.
     *
     * A list rather than one, because a scene told twice may be stored under a
     * different occurrence type each time — as an `event` before the extraction
     * could classify one and as a `battle` after. Asking about a single type
     * would let exactly those two copies past.
     */
    nodeTypes: readonly string[]
    text: string
    chapterNumber: number
    /** Already matched exactly and handled elsewhere; never echoes of itself. */
    excludeEntityIds?: string[]
  },
): Promise<Echo | null> {
  const normalized = normalizeText(input.text.slice(0, 200))
  if (normalized.length === 0) return null

  const exclude = new Set(input.excludeEntityIds ?? [])

  const candidates = await db
    .select({
      entityId: entityLabels.entityId,
      label: entityLabels.label,
      revealedInChapter: entityLabels.revealedInChapter,
    })
    .from(entityLabels)
    .innerJoin(entities, eq(entities.id, entityLabels.entityId))
    .where(
      and(
        eq(entities.workId, input.workId),
        eq(entities.userId, input.userId),
        inArray(entities.nodeType, [...input.nodeTypes]),
        eq(entities.reviewStatus, 'accepted'),
        lte(entities.firstSeenChapter, input.chapterNumber),
        lte(entityLabels.revealedInChapter, input.chapterNumber),
        sql`similarity(${entityLabels.normalizedLabel}, ${normalized}) >= ${TRIGRAM_FLOOR}`,
      ),
    )
    .orderBy(sql`similarity(${entityLabels.normalizedLabel}, ${normalized}) DESC`)
    .limit(20)

  let best: Echo | null = null
  for (const candidate of candidates) {
    if (exclude.has(candidate.entityId)) continue
    // The `lte` above already drops a name no chapter gives — an echo is a
    // scene the reader has read, and one with no chapter is not. Restated here
    // because the type is what tells the next reader the case exists.
    if (candidate.revealedInChapter === null) continue
    const overlap = tokenOverlap(asSentence(input.text), asSentence(candidate.label))
    if (overlap < ECHO_WORTH_SHOWING) continue
    if (best === null || overlap > best.overlap) {
      best = {
        entityId: candidate.entityId,
        label: candidate.label,
        chapterNumber: candidate.revealedInChapter,
        overlap,
      }
    }
  }

  return best
}
