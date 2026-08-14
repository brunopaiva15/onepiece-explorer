import 'server-only'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { LABEL_PRECEDENCE } from '@/db/schema/enums.ts'
import {
  auditLog,
  entities,
  entityLabels,
  events,
  glossaryTerms,
  mysteries,
} from '@/db/schema/knowledge.ts'
import { LABEL_KINDS, type LabelKind } from './label-kind.ts'
import { normalizeText } from './normalize.ts'

/**
 * Correct a name the graph got wrong.
 *
 * Helmeppo is called Hermep in French. Nothing in the chapter says so — it is a
 * translation convention held by the reader, and until now the only place to
 * express it was the review queue, at the exact moment the entity was proposed.
 * Miss it there and the wrong name is permanent: it is on the fiche, on every
 * edge of the graph, in the assistant's answers, and the only recourse was to
 * delete the chapter and import it again.
 *
 * So a rename is an **update in place**, and the three things it must not do are
 * the reason this is a domain function rather than three lines in a server
 * action:
 *
 *   It must not move the revelation chapter. « Hermep » is not learnt today; it
 *   is the same name, spelt properly, learnt when the chapter that gave it was
 *   read. Inserting a new label dated now would leave the entity nameless
 *   between its first appearance and this afternoon — the boundary slider would
 *   show a hole that never existed in the reading.
 *
 *   It must not lose the old wording. The catalogues that illustrate this graph
 *   are English to the last row, and they match on labels: rename « Helmeppo »
 *   to « Hermep » and delete the first, and the portrait stops being findable.
 *   A reader who read a scan and searches the name they saw is in the same
 *   position. So the previous form stays as a name of its own, below every
 *   displayed kind — findable, never displayed. That is the precedence-5
 *   convention publication already uses for source wordings.
 *
 *   It must not have to be done twice. The extraction step receives your
 *   settled vocabulary from `glossary_terms`; without an entry there, the next
 *   chapter naming this character proposes « Helmeppo » again, you correct it
 *   again, and the two forms eventually become two entities. The correction is
 *   therefore recorded against the wording it corrects — and against the source
 *   wordings the entity carries, because those are what a later chapter will
 *   actually contain.
 *
 *   It must not stop at the label. An event is named by its own summary and a
 *   mystery by its question — prose the pipeline wrote with the name spelt out
 *   inside it. Correcting the label alone leaves the fiche saying « Hermep »
 *   and the timeline under it saying Helmeppo, three beats down, next to the
 *   corrected portrait. See rewriteProse() for what that covers and what it
 *   refuses to touch.
 *
 * Bounded like everything else: the glossary entry is dated by the label's own
 * revelation chapter, so a name settled at chapter 3 reaches chapter 4's
 * extraction and never reaches chapter 2's.
 */

export interface RenameInput {
  /** The label row to rewrite — a name the reader can see at their boundary. */
  labelId: string
  label: string
  /** Left alone when absent: a rename is a spelling, not a reclassification. */
  kind?: LabelKind
  /** Keep the previous wording as a search-only name. Default true. */
  keepPrevious?: boolean
}

export interface RenameResult {
  entityId: string
  previousLabel: string
  label: string
  kind: LabelKind
  /**
   * The surviving name's own revelation — the earlier of the two on a fold.
   *
   * Null when no chapter gives this name: a SBS answer, a databook entry. Such
   * a row is never displayed at any boundary, so a rename of one corrects a
   * spelling the reader will not see until the manga itself says it.
   */
  revealedInChapter: number | null
  /** The entity already carried this name: the two rows became one. */
  folded: boolean
  keptAsAlias: boolean
  /** Source wordings now mapped to this name for later extractions. */
  glossaryTerms: number
  /** Event summaries and mystery questions that spelt it the old way. */
  proseRewritten: number
}

/**
 * Below every kind in LABEL_PRECEDENCE, so such a row can never become the
 * displayed name. Same value, and the same reason, as the source wordings
 * publication stores next to a label it translated.
 *
 * Exported because « can never be displayed » is a fact other readers of the
 * table need. The story thread announces a name landing on someone who already
 * had one, and it announced these too — « Yasopp » and « Yassop » on the same
 * chapter, twice the same reveal at one letter's distance.
 */
export const SEARCH_ONLY_PRECEDENCE = 5

/** Long enough for « Village de Fuchsia », short enough to stay a name. */
const MAX_LABEL = 200

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function renameEntityLabel(
  userId: string,
  input: RenameInput,
): Promise<RenameResult> {
  // Collapse the whitespace a paste brings with it; keep the case and the
  // accents, which are the whole point of the correction.
  const label = input.label.trim().replace(/\s+/g, ' ')
  if (label.length === 0) throw new Error('Un nom ne peut pas être vide.')
  if (label.length > MAX_LABEL) {
    throw new Error(`Un nom ne dépasse pas ${MAX_LABEL} caractères.`)
  }
  if (!UUID_RE.test(input.labelId)) throw new Error('Ce nom est introuvable.')

  /*
   * The kind, checked here rather than by the column.
   *
   * TypeScript says `LabelKind` and the browser says whatever it likes: this
   * arrives through a POST endpoint. Left to the enum, an unknown value fails as
   * a driver exception mid-transaction — after the glossary rows, which would
   * then roll back with it — and reaches the reader as « Refusée par la base ».
   */
  if (input.kind !== undefined && !LABEL_KINDS.some((e) => e.kind === input.kind)) {
    throw new Error(`Nature de nom inconnue : ${input.kind}.`)
  }

  const normalized = normalizeText(label)
  if (normalized.length === 0) {
    throw new Error('Ce nom ne contient aucun caractère indexable.')
  }

  const keepPrevious = input.keepPrevious ?? true

  return withIngest(async (db) => {
    /*
     * The row, read by id *and* by owner.
     *
     * A server action is a POST endpoint; the id arrives from a browser and
     * proves nothing. Ownership is not checked by the interface that offered
     * the button, it is checked here — `withIngest` runs as the ingestion role,
     * which is exempt from row-level security, so every clause that scopes this
     * to one library has to be written out.
     */
    const [row] = await db
      .select({
        id: entityLabels.id,
        entityId: entityLabels.entityId,
        label: entityLabels.label,
        normalizedLabel: entityLabels.normalizedLabel,
        kind: entityLabels.kind,
        precedence: entityLabels.precedence,
        revealedInChapter: entityLabels.revealedInChapter,
        revealSource: entityLabels.revealSource,
        workId: entities.workId,
      })
      .from(entityLabels)
      .innerJoin(entities, eq(entities.id, entityLabels.entityId))
      .where(
        and(
          eq(entityLabels.id, input.labelId),
          eq(entityLabels.userId, userId),
          eq(entities.userId, userId),
        ),
      )
      .limit(1)

    if (!row) throw new Error('Ce nom est introuvable.')

    const kind = input.kind ?? row.kind
    if (row.label === label && kind === row.kind) {
      throw new Error('Ce nom est déjà celui-là.')
    }

    /*
     * The entity's other names, read once — three questions turn on them.
     *
     * Which name is in the way, which wordings a later chapter will contain, and
     * whether the row being corrected is the one the entity is *called* by. A
     * character carries a handful of labels, so one read is cheaper than three
     * queries and gives all three answers from the same snapshot.
     */
    const siblings = await db
      .select({
        id: entityLabels.id,
        label: entityLabels.label,
        normalizedLabel: entityLabels.normalizedLabel,
        kind: entityLabels.kind,
        precedence: entityLabels.precedence,
        revealedInChapter: entityLabels.revealedInChapter,
        revealSource: entityLabels.revealSource,
      })
      .from(entityLabels)
      .where(
        and(
          eq(entityLabels.entityId, row.entityId),
          eq(entityLabels.userId, userId),
          ne(entityLabels.id, row.id),
        ),
      )

    // A rename must not renumber a precedence publication or a merge chose
    // deliberately; a change of kind is exactly the case where it should.
    const wanted = kind === row.kind ? row.precedence : LABEL_PRECEDENCE[kind]

    /*
     * The entity already carries this name — so the two are one name.
     *
     * This used to be a refusal, and the refusal was useless in the case that
     * produces it. Chapter 3 reproposes « Helmeppo » as a second label of a
     * character already corrected to « Hermep » at chapter 1: the reader asks
     * for the same correction again and is told « corrigez plutôt celui-là » —
     * about a row that is already right, with nothing to do to it. The message
     * was accurate and left the duplicate exactly where it was.
     *
     * Saying « this row and that row are the same name » *is* the answer, so it
     * is applied rather than argued with. The two fold into one: the surviving
     * row keeps the strongest precedence of the pair, so a display the reader
     * chose is never demoted by a fold, and the **earliest** revelation of the
     * pair, because the entity really was named this at that chapter — in a
     * spelling now corrected. Anything later would hide a name the reader had.
     */
    const clash = siblings.find((sibling) => sibling.normalizedLabel === normalized)
    const precedence = clash ? Math.max(clash.precedence, wanted) : wanted
    const differs = normalized !== row.normalizedLabel

    /** What the surviving row says once the two have folded into one. */
    const survivingKind = clash && clash.precedence >= wanted ? clash.kind : kind
    const reveal = clash ? earliestReveal(clash, row) : row

    if (clash) {
      await db
        .update(entityLabels)
        .set({
          // The wording as it was just typed: the reader retyped the name they
          // want to see, and « hermep » corrected to « Hermep » is the whole
          // point of some of these corrections.
          label,
          normalizedLabel: normalized,
          kind: survivingKind,
          precedence,
          revealedInChapter: reveal.revealedInChapter,
          revealSource: reveal.revealSource,
        })
        .where(eq(entityLabels.id, clash.id))
    } else {
      await db
        .update(entityLabels)
        .set({
          label,
          normalizedLabel: normalized,
          kind,
          ...(precedence === row.precedence ? {} : { precedence }),
        })
        .where(eq(entityLabels.id, row.id))
    }

    /*
     * The previous wording, kept as a name nothing displays.
     *
     * Skipped when the correction is an accent or a capital — « hermep » and
     * « Hermep » normalise to the same string, so the row would be a duplicate
     * of the one just rewritten and would add nothing to find it by.
     *
     * On a fold there is no row to insert: the one being folded already carries
     * that wording, so it is demoted in place rather than duplicated — and
     * dropped outright when the reader unticked the box, which is the only way
     * this function ever deletes a name.
     */
    const keptAsAlias = keepPrevious && differs
    if (clash) {
      if (keptAsAlias) {
        await db
          .update(entityLabels)
          .set({ kind: 'alias', precedence: SEARCH_ONLY_PRECEDENCE })
          .where(eq(entityLabels.id, row.id))
      } else {
        await db.delete(entityLabels).where(eq(entityLabels.id, row.id))
      }
    } else if (keptAsAlias) {
      await db.insert(entityLabels).values({
        entityId: row.entityId,
        userId,
        label: row.label,
        normalizedLabel: row.normalizedLabel,
        kind: 'alias',
        // The chapter that used it, unchanged. A name is dated by when it was
        // read, and this one was read exactly when the corrected one was — the
        // source with it, since a row with no chapter has to keep saying where
        // it came from.
        revealedInChapter: row.revealedInChapter,
        revealSource: row.revealSource,
        precedence: SEARCH_ONLY_PRECEDENCE,
      })
    }

    /*
     * Vocabulary is only settled by the name the entity is called by.
     *
     * `glossary_terms` answers « what do we call this term in French », and the
     * answer is the displayed name — the highest precedence the entity carries.
     * Correcting a search-only wording, one of the English forms kept so a
     * catalogue can match, changes nothing about what the character is called,
     * and recording it as the French term would hand the next extraction an
     * alias to display.
     */
    const isDisplayedName = siblings.every(
      (sibling) => sibling.precedence <= precedence,
    )

    /*
     * The wordings a later chapter will contain.
     *
     * The label being corrected is one of them, and often not the useful one:
     * publication stores the source's own wording beside a label it translated,
     * precisely so an English catalogue and an English scan still find the
     * character. Those are the forms a future extraction reads, so those are the
     * forms that have to point at the corrected name — mapping only the French
     * guess would let the source wording produce that guess all over again.
     */
    /*
     * A name no chapter gives settles no vocabulary.
     *
     * `glossary_terms` hands its answer to the extraction of every *later*
     * chapter, and « later » has no meaning for a name that sits outside the
     * chapter axis. Recording one would have to invent the date this correction
     * exists to refuse — and it would hand the next chapter a name the reader
     * has not read, which is the leak migration 0016 bounded the glossary to
     * prevent.
     */
    let recorded = 0
    if (differs && isDisplayedName && reveal.revealedInChapter !== null) {
      const seen = new Set<string>()
      const wordings = [
        { label: row.label, normalizedLabel: row.normalizedLabel },
        ...siblings.filter(
          (sibling) => sibling.precedence <= SEARCH_ONLY_PRECEDENCE,
        ),
      ]

      for (const wording of wordings) {
        // A term that already reads as the corrected name maps to itself.
        if (wording.normalizedLabel === normalized) continue
        if (seen.has(wording.normalizedLabel)) continue
        seen.add(wording.normalizedLabel)

        await db
          .insert(glossaryTerms)
          .values({
            workId: row.workId,
            userId,
            sourceTerm: wording.label,
            normalizedSource: wording.normalizedLabel,
            frenchTerm: label,
            decidedInChapter: reveal.revealedInChapter,
          })
          .onConflictDoUpdate({
            target: [glossaryTerms.workId, glossaryTerms.normalizedSource],
            // Correcting a correction replaces the answer, as it does when the
            // answer comes from the review queue.
            set: { frenchTerm: label, updatedAt: new Date() },
          })
        recorded++
      }
    }

    const proseRewritten = isDisplayedName
      ? await rewriteProse(db, {
          userId,
          workId: row.workId,
          from: row.label,
          to: label,
        })
      : 0

    await db.insert(auditLog).values({
      userId,
      action: 'entity_renamed',
      subjectKind: 'entity',
      subjectId: row.entityId,
      detail: {
        labelId: row.id,
        from: row.label,
        to: label,
        fromKind: row.kind,
        kind: survivingKind,
        revealedInChapter: reveal.revealedInChapter,
        folded: clash !== undefined,
        keptAsAlias,
        glossaryTerms: recorded,
        proseRewritten,
      },
    })

    return {
      entityId: row.entityId,
      previousLabel: row.label,
      label,
      kind: survivingKind,
      revealedInChapter: reveal.revealedInChapter,
      folded: clash !== undefined,
      keptAsAlias,
      glossaryTerms: recorded,
      proseRewritten,
    }
  })
}

/**
 * Of two names that turn out to be one, the one the reader met first.
 *
 * A chapter always wins over no chapter, and it is not a tie-break: the entity
 * really was named this at that chapter, in a spelling now corrected, and a
 * fold that kept the NULL would hide from the reader a name they have read.
 * Two chapter-less rows fold to a chapter-less row, which is the same rule with
 * nothing to choose between.
 *
 * The source travels with the chapter, so the surviving row never claims to
 * come from a SBS column while carrying a chapter that came from the page.
 */
function earliestReveal<
  T extends { revealedInChapter: number | null; revealSource: string | null },
>(a: T, b: T): { revealedInChapter: number | null; revealSource: string | null } {
  if (a.revealedInChapter === null) return b
  if (b.revealedInChapter === null) return a
  return a.revealedInChapter <= b.revealedInChapter ? a : b
}

/**
 * The sentences that spelt it the old way.
 *
 * A name is not only a label. An event is *named by its own summary* — the
 * pipeline has no better title for « Helmeppo détruit les boulettes de riz de
 * Rika » than that sentence — and a mystery by its question, so the story mode
 * reads prose in which the name was written out in full. Correct the label
 * alone and the fiche says « Hermep » while the timeline underneath it still
 * says Helmeppo, three beats down, with the corrected portrait beside it.
 *
 * The review queue already does this for the batch being decided: a name
 * retyped there is carried into the event summaries and mystery questions
 * written before your decision. This is the same rule for what is already
 * published, which is where a correction made forty chapters later lands.
 *
 * Whole words only, and case-sensitively. « Ace » must not fire inside
 * « Aces » — the lookarounds are the ones the story mode uses to place faces in
 * a sentence, for the same reason.
 *
 * **What is deliberately not touched:** the chapter text. `text_blocks` holds
 * what the source says, evidence is anchored by finding an excerpt inside it,
 * and rewriting a word there would either break every quote that cites the
 * block or — worse — quietly succeed and leave the graph claiming the source
 * used a wording it never used. The prose rewritten here is ours: summaries and
 * questions the pipeline composed, never a quotation.
 */
async function rewriteProse(
  db: Parameters<Parameters<typeof withIngest>[0]>[0],
  input: { userId: string; workId: string; from: string; to: string },
): Promise<number> {
  const { userId, workId, from, to } = input
  if (from === to || from.trim() === '') return 0

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`,
    'gu',
  )
  const swap = (text: string | null): string | null => {
    if (text === null || !text.includes(from)) return null
    const next = text.replace(pattern, to)
    return next === text ? null : next
  }

  let rewritten = 0

  const eventRows = await db
    .select({ entityId: events.entityId, summary: events.summary })
    .from(events)
    .where(and(eq(events.workId, workId), eq(events.userId, userId)))

  for (const event of eventRows) {
    const summary = swap(event.summary)
    if (summary === null) continue
    await db
      .update(events)
      .set({ summary })
      .where(eq(events.entityId, event.entityId))
    rewritten++
  }

  const mysteryRows = await db
    .select({ entityId: mysteries.entityId, question: mysteries.question })
    .from(mysteries)
    .where(and(eq(mysteries.workId, workId), eq(mysteries.userId, userId)))

  for (const mystery of mysteryRows) {
    const question = swap(mystery.question)
    if (question === null) continue
    await db
      .update(mysteries)
      .set({ question })
      .where(eq(mysteries.entityId, mystery.entityId))
    rewritten++
  }

  /*
   * And the copy of that sentence kept as a label.
   *
   * An event carries its summary twice: once in `events`, once truncated in
   * `entity_labels`, which is what search indexes and what the story mode falls
   * back to when the summary is empty. Left behind, the old spelling comes back
   * through the search box.
   *
   * Restricted to event and mystery nodes, and that restriction is the whole
   * safety of this: labels of *characters* are names, and rewriting another
   * character's name because it contains this wording is precisely the silent
   * damage a rename must not do.
   */
  const labelRows = await db
    .select({ id: entityLabels.id, label: entityLabels.label })
    .from(entityLabels)
    .innerJoin(entities, eq(entities.id, entityLabels.entityId))
    .where(
      and(
        eq(entities.workId, workId),
        eq(entities.userId, userId),
        eq(entityLabels.userId, userId),
        inArray(entities.nodeType, ['event', 'mystery']),
      ),
    )

  for (const copy of labelRows) {
    const next = swap(copy.label)
    if (next === null) continue
    await db
      .update(entityLabels)
      .set({ label: next, normalizedLabel: normalizeText(next) })
      .where(eq(entityLabels.id, copy.id))
  }

  return rewritten
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
