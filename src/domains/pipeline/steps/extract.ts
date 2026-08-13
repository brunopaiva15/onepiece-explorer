import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, eq, lte } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { reviewDecisions, reviewItems } from '@/db/schema/ingestion.ts'
import {
  entities,
  entityLabels,
  glossaryTerms,
  nodeTypes,
  predicates,
} from '@/db/schema/knowledge.ts'
import { chapters } from '@/db/schema/documents.ts'
import {
  buildAnchorSources,
  filterExtraction,
  proposalFingerprint,
  refileMisfiled,
  type FilterResult,
  type OntologyView,
  type Quarantined,
} from '@/domains/ai/anchoring.ts'
import type { Extraction, PanelDescription } from '@/domains/ai/schemas.ts'
import { splitPassages } from '@/domains/ingestion/passages.ts'
import { PREDICATES } from '@/domains/knowledge/ontology.ts'
import { quarantineItems } from '../quarantine.ts'
import { completedUnits, recordUnit } from '../runs.ts'
import { reanchorOrphans } from '../reanchor.ts'
import { buildRefTable } from '../refs.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * Extraction: pages in, proposals out.
 *
 * Nothing this step writes is canon. Everything lands in `review_items`, and the
 * only route from there into the graph runs through a human decision. That is
 * not a workflow preference — it is the difference between a tool that records
 * what you have read and one that tells you things.
 *
 * The order of operations here is deliberate and each stage exists to stop a
 * specific failure:
 *
 *   1. Ask the model, giving it only this chapter's panels, text and the
 *      entities already visible at this chapter. Passing entities from *later*
 *      chapters would leak the future into the prompt — the model would helpfully
 *      connect a chapter 3 silhouette to a chapter 300 name.
 *   2. Filter mechanically. An unanchored proposal is quarantined, never queued.
 *   3. Fingerprint each survivor and re-apply any decision the user already made
 *      about that exact proposal. This is what makes a correction survive a
 *      re-import instead of being asked again.
 *   4. Queue the rest, flagging the categories that can never be bulk-accepted.
 */

/** A text block as the prompt sees it. */
interface PromptBlock {
  ref: string
  text: string
  panelRef: string | null
}

/**
 * How much of a chapter goes into one extraction call.
 *
 * Twenty panels is three or four pages: enough context for a scene to hold
 * together, small enough that the answer — entities, assertions, events and
 * mysteries for all of them — finishes inside the output ceiling.
 *
 * It started at forty, which measurement then rejected. A real chapter's third
 * slice ran through the 32 000 token ceiling and had to be halved and retried,
 * and that retry is not free: the truncated call is billed in full before it is
 * thrown away. Halving stays as the safety net for a slice that is unusually
 * dense; it should not be the normal path for a chapter that is merely busy.
 */
const SLICE_PANELS = 20

/**
 * How many passages of a written summary go into one extraction call.
 *
 * A passage is at most six hundred characters, so fifteen is around nine
 * thousand — a detailed chapter summary in one or two calls, where the page
 * path needed six or more. The unit is different from the panel one and the
 * number cannot be shared: prose carries far more claims per character than a
 * drawing does, so the same input length produces a much longer answer.
 */
const SLICE_PASSAGES = 15

/** How many times a failing slice may be halved before it is given up on. */
const MAX_SPLIT_DEPTH = 2

/**
 * How many slices are in flight at once.
 *
 * They ran strictly one after another, which was defensible when a chapter was
 * six slices of panels and the concern was rate limits. It is not defensible at
 * two slices: the second waits out the first for no reason, and the wall clock
 * is the sum where it could be the maximum.
 *
 * Three rather than "all of them" because the slices of one chapter share a
 * prompt cache and an account-level rate limit, and because a failure that
 * splits a slice pushes more work back onto the queue — an unbounded fan-out
 * would turn a bad chapter into a burst. Three keeps a normal chapter to a
 * single round while leaving headroom.
 */
const SLICE_CONCURRENCY = 3

interface Slice {
  descriptions: PanelDescription[]
  blocks: PromptBlock[]
}

/**
 * Passages of slack on each side of the window.
 *
 * Two people writing the same chapter cut their paragraphs in different places,
 * so the position that corresponds to a slice is approximate. Overshooting
 * costs a passage of prompt; clipping loses the sentence carrying the name,
 * which is the only reason the text is there.
 */
const PARALLEL_MARGIN = 1

/**
 * How much of the other-language text goes out with one slice.
 *
 * The second text is a naming aid, and a naming aid is only useful where it
 * overlaps the passages being read: sending the whole translation with every
 * slice would pay for the entire chapter once per call, and bury the sentences
 * that matter in the ones that do not.
 *
 * Aligned by position rather than by content. The two texts tell the same
 * chapter in the same order, so passage *k of n* on one side corresponds to
 * roughly *k of n* on the other — good enough to put a name next to its
 * translation, which is all this has to achieve.
 *
 * No attempt at real alignment, deliberately. Matching sentences across
 * languages is a model call, and paying for one to save part of the cost of
 * another is a trade this step does not need to make.
 */
export function parallelWindow(
  parallel: string[],
  span: { from: number; to: number },
  total: number,
): string[] {
  if (parallel.length === 0 || total <= 0) return []
  if (parallel.length <= 2 * PARALLEL_MARGIN + 1) return parallel

  const ratio = parallel.length / total
  const start = Math.floor(span.from * ratio) - PARALLEL_MARGIN
  const end = Math.ceil((span.to + 1) * ratio) + PARALLEL_MARGIN

  return parallel.slice(Math.max(0, start), Math.min(parallel.length, end))
}

/** Can this slice be made smaller, or is it already one unit of source? */
function isDivisible(slice: Slice): boolean {
  return slice.descriptions.length > 1 || (slice.descriptions.length === 0 && slice.blocks.length > 1)
}

/**
 * Halve a slice.
 *
 * Two shapes, because a slice has two possible units. With panels, the panels
 * are halved and each half keeps the text that belongs to it — splitting the
 * text independently would hand the model a bubble whose panel it cannot see.
 * Without panels there is only prose, so the passages are halved directly.
 */
export function splitSlice(slice: Slice): Slice[] {
  if (slice.descriptions.length === 0) {
    const middle = Math.ceil(slice.blocks.length / 2)
    return [slice.blocks.slice(0, middle), slice.blocks.slice(middle)]
      .filter((half) => half.length > 0)
      .map((half) => ({ descriptions: [], blocks: half }))
  }

  const middle = Math.ceil(slice.descriptions.length / 2)
  const halves = [slice.descriptions.slice(0, middle), slice.descriptions.slice(middle)]

  return halves
    .filter((half) => half.length > 0)
    .map((half, index) => {
      const refs = new Set(half.map((d) => d.panel_ref))
      return {
        descriptions: half,
        blocks: slice.blocks.filter((block) =>
          // Orphans stay with the first half, once — the same rule as slicing.
          block.panelRef === null ? index === 0 : refs.has(block.panelRef),
        ),
      }
    })
}

/**
 * Panels in slices, each carrying the text blocks that belong to it.
 *
 * Blocks attached to no panel — a narration box in a gutter, a title — go with
 * the first slice rather than into every one: repeating them would have the
 * model propose the same fact once per slice.
 */
/**
 * A slice's identity, stable across retries.
 *
 * The panel refs it carries, sorted and hashed. Stable because a retry sends
 * the same panels; sensitive because re-detecting panels renumbers them, so a
 * genuine reprocessing gets new keys and redoes the work.
 */
/**
 * Local ids, made unique across the slices of one run.
 *
 * A local id is « scoped to this response », and the prompt says so — which was
 * exactly right when a chapter was one call. Sliced, a chapter is a dozen
 * responses, and every one of them starts counting at `e1`. They are then
 * merged into a single list of proposals and published against a single map
 * from local id to entity row, where `e1` can only mean one thing.
 *
 * What that did, quietly: the second slice's `e1` overwrote the first's, and
 * every relation the first slice had proposed about *its* `e1` landed on a
 * different character. Not a missing edge — a wrong one, drawn between two
 * entities the chapter never connected, indistinguishable from a real one.
 *
 * Prefixing with the slice's own key rather than a counter is deliberate: the
 * key is derived from the slice's refs, so a resumed run rebuilds the same
 * prefix for the same slice and its replayed checkpoint still lines up.
 *
 * References to *existing* entities are left alone. Those are database uuids
 * handed to the model in the prompt, they are already unique, and prefixing one
 * would turn a valid reference into a dangling one.
 */
export function namespaceLocalIds(extraction: Extraction, prefix: string): Extraction {
  // Mysteries carry no local id — nothing may reference one — so they pass
  // through untouched.
  const mine = new Set<string>([
    ...extraction.entities.map((entity) => entity.local_id),
    ...extraction.events.map((event) => event.local_id),
  ])
  const scoped = (ref: string): string => (mine.has(ref) ? `${prefix}:${ref}` : ref)

  return {
    entities: extraction.entities.map((entity) => ({
      ...entity,
      local_id: scoped(entity.local_id),
    })),
    assertions: extraction.assertions.map((assertion) => ({
      ...assertion,
      subject: scoped(assertion.subject),
      object: assertion.object === null ? null : scoped(assertion.object),
    })),
    events: extraction.events.map((event) => ({
      ...event,
      local_id: scoped(event.local_id),
      // Participants were left un-namespaced, which made them dangle: `e1` in a
      // participant list matched no entity once every entity had become
      // `<clé>:e1`, so an event published from the second slice of a chapter
      // knew nobody. Same rule as a relation's two ends, and for the same
      // reason — it is the same identifier.
      participants: event.participants.map(scoped),
    })),
    mysteries: extraction.mysteries,
  }
}

function sliceKey(slice: Slice): string {
  const refs = [
    ...slice.descriptions.map((d) => d.panel_ref),
    ...slice.blocks.map((b) => b.ref),
  ].sort()
  return createHash('sha256').update(refs.join('|')).digest('hex').slice(0, 32)
}

/** A slice's size, in whatever unit it is made of. */
function sizeOf(slice: Slice): string {
  return slice.descriptions.length > 0
    ? `${slice.descriptions.length} cases`
    : `${slice.blocks.length} passages`
}

/**
 * Was this a connection that died, or an answer that did not fit?
 *
 * The distinction decides the remedy and the cost. A truncated stream is fixed
 * by asking again — the same slice, unchanged. An answer that genuinely
 * overflows is fixed by asking for less. Halving on a network error doubles the
 * number of billed calls to solve a problem that was never about size, which is
 * most of how one chapter reached four dollars.
 */
function looksLikeNetwork(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('connection error') ||
    m.includes('terminated') ||
    m.includes('econnreset') ||
    m.includes('socket') ||
    m.includes('fetch failed') ||
    m.includes('unterminated string') ||
    m.includes('unexpected end of json') ||
    // Le chien de garde du fournisseur : un flux resté muet a été abandonné.
    // C'est une connexion morte, pas une réponse trop grande — on redemande
    // la même tranche au lieu de la couper en deux.
    m.includes('flux inactif') ||
    m.includes('aborted') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    // Le fournisseur auto-hébergé qui n'a pas répondu dans le délai imparti.
    m.includes('n’a pas répondu') ||
    m.includes("n'a pas répondu")
  )
}

export function sliceChapter(descriptions: PanelDescription[], blocks: PromptBlock[]): Slice[] {
  /*
   * No panels means a chapter you wrote: slice the prose itself.
   *
   * This used to return everything in one slice, which was right when "no
   * panels" only ever meant a page whose detection had failed. It is wrong now
   * that a chapter can legitimately be nothing but text — a long summary would
   * go out as a single call and run into the same output ceiling that slicing
   * exists to stay under.
   */
  if (descriptions.length === 0) {
    if (blocks.length === 0) return [{ descriptions: [], blocks: [] }]
    const slices: Slice[] = []
    for (let start = 0; start < blocks.length; start += SLICE_PASSAGES) {
      slices.push({ descriptions: [], blocks: blocks.slice(start, start + SLICE_PASSAGES) })
    }
    return slices
  }

  const orphans = blocks.filter((block) => block.panelRef === null)
  const slices: Slice[] = []

  for (let start = 0; start < descriptions.length; start += SLICE_PANELS) {
    const chunk = descriptions.slice(start, start + SLICE_PANELS)
    const refs = new Set(chunk.map((d) => d.panel_ref))
    slices.push({
      descriptions: chunk,
      blocks: [
        ...(start === 0 ? orphans : []),
        ...blocks.filter((block) => block.panelRef !== null && refs.has(block.panelRef)),
      ],
    })
  }

  return slices
}

export async function runExtract(context: StepContext): Promise<StepResult> {
  const { userId, chapterId, chapterNumber, runId } = context
  const provider = context.provider

  const world = await withIngest(async (db) => {
    const [chapter] = await db
      .select({
        workId: chapters.workId,
        parallelText: chapters.parallelText,
        parallelLanguage: chapters.parallelLanguage,
      })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const pageRows = await db
      .select({ id: pages.id, index: pages.index })
      .from(pages)
      .where(
        and(
          eq(pages.chapterId, chapterId),
          eq(pages.userId, userId),
          eq(pages.excluded, false),
        ),
      )
      .orderBy(asc(pages.index))

    const panelRows = await db
      .select({
        id: panels.id,
        pageId: panels.pageId,
        index: panels.index,
        description: panels.description,
      })
      .from(panels)
      .where(and(eq(panels.chapterId, chapterId), eq(panels.userId, userId)))
      .orderBy(asc(panels.index))

    const blockRows = await db
      .select({
        id: textBlocks.id,
        panelId: textBlocks.panelId,
        text: textBlocks.text,
      })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))
      .orderBy(asc(textBlocks.readingOrder))

    /*
     * Entities the reader could already know about, and nothing more.
     *
     * `firstSeenChapter <= chapterNumber` is the boundary applied to the
     * prompt. Without it the model would receive the whole cast — including
     * figures introduced two hundred chapters later — and would connect them.
     * The row-level security policies protect what the *reader* sees; this
     * protects what the *model* sees, and they are different leaks.
     */
    const known = await db
      .select({
        id: entities.id,
        nodeType: entities.nodeType,
        label: entityLabels.label,
      })
      .from(entities)
      .leftJoin(
        entityLabels,
        and(
          eq(entityLabels.entityId, entities.id),
          lte(entityLabels.revealedInChapter, chapterNumber),
        ),
      )
      .where(
        and(
          eq(entities.workId, chapter.workId),
          eq(entities.userId, userId),
          eq(entities.reviewStatus, 'accepted'),
          lte(entities.firstSeenChapter, chapterNumber),
        ),
      )

    /*
     * Naming decisions the reader has already made, and no later ones.
     *
     * Same boundary as `known` above, for the same reason: learning that a term
     * is called X is itself a revelation, dated by the chapter where it was
     * settled. Handing a chapter-3 extraction the vocabulary of chapter 500
     * would leak the future into the prompt just as surely as handing it the
     * entity list would.
     */
    const glossary = await db
      .select({
        sourceTerm: glossaryTerms.sourceTerm,
        frenchTerm: glossaryTerms.frenchTerm,
        note: glossaryTerms.note,
      })
      .from(glossaryTerms)
      .where(
        and(
          eq(glossaryTerms.workId, chapter.workId),
          eq(glossaryTerms.userId, userId),
          lte(glossaryTerms.decidedInChapter, chapterNumber),
        ),
      )

    const types = await db
      .select({
        key: nodeTypes.key,
        labelFr: nodeTypes.labelFr,
        description: nodeTypes.description,
      })
      .from(nodeTypes)
    const preds = await db
      .select({
        key: predicates.key,
        labelFr: predicates.labelFr,
        subjectTypes: predicates.subjectTypes,
        objectTypes: predicates.objectTypes,
        requiresExplicitReview: predicates.requiresExplicitReview,
        description: predicates.description,
      })
      .from(predicates)

    const decisions = await db
      .select({
        fingerprint: reviewDecisions.proposalFingerprint,
        decision: reviewDecisions.decision,
      })
      .from(reviewDecisions)
      .where(
        and(
          eq(reviewDecisions.userId, userId),
          eq(reviewDecisions.workId, chapter.workId),
        ),
      )

    return { chapter, pageRows, panelRows, blockRows, known, glossary, types, preds, decisions }
  })

  const table = buildRefTable({
    panels: world.panelRows.map((panel) => ({
      id: panel.id,
      pageIndex: world.pageRows.find((p) => p.id === panel.pageId)?.index ?? 0,
      index: panel.index,
    })),
    blocks: world.blockRows,
  })

  const descriptions: PanelDescription[] = world.panelRows
    .filter((panel) => panel.description !== null)
    .map((panel) => ({
      panel_ref: table.panelRefs.get(panel.id)!,
      description: panel.description!,
      characters_visible: [],
      setting: null,
      actions: [],
      confidence: 1,
    }))

  const promptBlocks = world.blockRows.map((block) => ({
    ref: table.blockRefs.get(block.id)!,
    text: block.text,
    panelRef: block.panelId ? (table.panelRefs.get(block.panelId) ?? null) : null,
  }))

  if (promptBlocks.length === 0 && descriptions.length === 0) {
    return {
      note:
        context.sourceKind === 'summary'
          ? 'Rien à extraire : ce chapitre ne contient aucun passage. Réimportez son résumé.'
          : 'Rien à extraire : ni texte transcrit ni description de case. ' +
            'Vérifiez les étapes précédentes avant de relancer.',
      status: 'skipped',
    }
  }

  const knownEntities = dedupeById(world.known)

  /*
   * The other-language text, cut up the same way its counterpart was.
   *
   * `splitPassages` rather than a second splitter, and split here rather than
   * at import: the text is stored whole because nothing cites it, and cutting
   * it with the same function as the citable side is what makes "passage k of
   * n" mean the same thing on both, which is the entire basis of the alignment.
   */
  const parallelPassages =
    world.chapter.parallelText !== null && world.chapter.parallelLanguage !== null
      ? splitPassages(world.chapter.parallelText)
      : []

  /** Where each citable passage sits in reading order, for that alignment. */
  const positionOfRef = new Map(promptBlocks.map((block, index) => [block.ref, index]))

  function parallelFor(slice: Slice): { language: string; passages: string[] } | null {
    if (parallelPassages.length === 0 || world.chapter.parallelLanguage === null) return null

    const positions = slice.blocks
      .map((block) => positionOfRef.get(block.ref))
      .filter((position): position is number => position !== undefined)
    if (positions.length === 0) return null

    const passages = parallelWindow(
      parallelPassages,
      { from: Math.min(...positions), to: Math.max(...positions) },
      promptBlocks.length,
    )
    if (passages.length === 0) return null

    return { language: world.chapter.parallelLanguage, passages }
  }

  const ontology: OntologyView = {
    nodeTypes: new Set(world.types.map((t) => t.key)),
    predicates: new Set(world.preds.map((p) => p.key)),
    // A predicate that declares no object type is the only one whose object may
    // be a value rather than an entity. None of the built-in ones is.
    literalObjects: new Set(
      world.preds.filter((p) => p.objectTypes.length === 0).map((p) => p.key),
    ),
  }

  /*
   * The chapter, in slices.
   *
   * One call for a whole chapter used to be the design, and it met its limit on
   * a real one: 122 panels and 130 text blocks in, everything out — entities,
   * assertions, events, mysteries — against a ceiling the answer ran straight
   * through. `stop_reason: max_tokens` leaves truncated JSON, which surfaced as
   * "réponse non conforme au schéma", a message about a symptom.
   *
   * Slicing bounds the output by bounding the input, which is the only bound
   * that holds: no ceiling is high enough for a chapter that happens to be
   * denser than the last one. The cacheable prefix — system prompt, ontology,
   * validated entities — is identical across slices, so the extra calls are
   * cheap after the first.
   *
   * What it costs: a character appearing in two slices is proposed twice, since
   * only *accepted* entities are given as known and nothing is accepted mid-run.
   * Entity resolution and review already handle that — it is the same situation
   * as two chapters processed before either is reviewed.
   */
  const slices = sliceChapter(descriptions, promptBlocks)

  const accepted: Extraction = { entities: [], assertions: [], events: [], mysteries: [] }
  const quarantined: Quarantined[] = []
  /** Proposals that arrived under the wrong heading and were put back. */
  const misfiled = { events: 0, mysteries: 0 }
  let usage = { costCents: 0, inputTokens: 0, outputTokens: 0, modelId: undefined as string | undefined }
  let refusal: string | null = null

  /*
   * A slice that fails is retried smaller, then given up on — never the step.
   *
   * The first sliced run got through two of four and died on the third, taking
   * the two that had worked with it: eight minutes and their cost, discarded
   * because a later call came back with truncated JSON. The describe step
   * already knew better; this one did not, and the inconsistency was mine.
   *
   * Splitting on failure also treats the likeliest cause rather than reporting
   * it. Truncation means the answer did not fit; half as many panels is half as
   * much answer. Two splits take forty panels down to ten, and a slice that
   * still fails at ten is not failing because of its size.
   */
  /*
   * What this run already bought.
   *
   * pg-boss retries a job whose worker died, and the step used to restart at
   * its first slice — paying again for every call that had already landed and
   * written its proposals. On a connection that drops, the same chapter was
   * bought three times.
   */
  const alreadyDone = await completedUnits(runId, 'extract_candidates')
  const pending: Array<{ slice: Slice; depth: number; retried: boolean }> = []
  let resumed = 0

  for (const slice of slices) {
    const saved = alreadyDone.get(sliceKey(slice))
    if (saved === undefined) {
      pending.push({ slice, depth: 0, retried: false })
      continue
    }
    // Replayed, not re-bought. The answer was paid for; only the writing of it
    // was lost.
    if (saved) {
      try {
        const restored = JSON.parse(saved) as FilterResult
        accepted.entities.push(...restored.accepted.entities)
        accepted.assertions.push(...restored.accepted.assertions)
        accepted.events.push(...restored.accepted.events)
        accepted.mysteries.push(...restored.accepted.mysteries)
        quarantined.push(...restored.quarantined)
      } catch {
        // A checkpoint we cannot read is worth less than the call it saves;
        // redo the slice rather than silently drop its proposals.
        pending.push({ slice, depth: 0, retried: false })
        continue
      }
    }
    resumed++
  }

  if (resumed > 0) {
    console.log(`[extract] ${resumed} tranche(s) déjà payée(s), rejouées sans rappeler le modèle`)
  }
  let done = 0
  let failedSlices = 0
  let lastFailure: string | null = null

  /*
   * A pool over the shared queue, not a map over a fixed list.
   *
   * The queue is mutated while it drains: a slice that fails is pushed back
   * whole for a retry, or halved and pushed back as two. A `Promise.all` over
   * the initial slices could not express that. Workers pulling from one array
   * can, and `shift()` between awaits is safe here because nothing yields
   * inside the read-modify-write.
   */
  async function drain(): Promise<void> {
   while (pending.length > 0) {
    const { slice, depth, retried } = pending.shift()!
    done++
    if (slices.length > 1) {
      console.log(
        `[extract] tranche ${done} (${sizeOf(slice)}` +
          `${depth > 0 ? `, redécoupée ×${depth}` : ''})`,
      )
    }

    const refs = [
      ...slice.descriptions.map((d) => d.panel_ref),
      ...slice.blocks.map((b) => b.ref),
    ]

    const parallel = parallelFor(slice)

    let result: Awaited<ReturnType<typeof provider.extract>>
    try {
      result = await provider.extract({
        chapterNumber,
        source: context.sourceKind,
        ontology: renderOntology(world.types, world.preds),
        knownEntities,
        /*
         * What this chapter has already proposed, so a relation can name it.
         *
         * A slice sees only its own passages, and `knownEntities` holds
         * *accepted* entities — nothing is accepted mid-run. A link between
         * someone introduced in the first slice and someone in the third could
         * therefore not be written at all: the model had no name to use for
         * the first. This is that name.
         *
         * Best effort by design. Slices run three at a time, so a slice gets
         * whatever has landed when it starts rather than everything before it
         * in the chapter; making it exact would mean running them one after
         * another and paying three times the wall clock for the last few links.
         *
         * Omitted when empty, so the first slice's request — and the recorded
         * response keyed on it — is byte for byte what it was before this
         * existed.
         */
        ...(accepted.entities.length > 0
          ? {
              proposedSoFar: accepted.entities.map((entity) => ({
                id: entity.local_id,
                label: entity.label,
                nodeType: entity.node_type,
              })),
            }
          : {}),
        glossary: world.glossary,
        descriptions: slice.descriptions,
        textBlocks: slice.blocks,
        allowedRefs: refs,
        // Omitted rather than sent empty when there is no second text, so the
        // request — and the recorded response keyed on it — is byte for byte
        // what it was before this existed.
        ...(parallel ? { parallel } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      /*
       * A dropped stream is retried as-is; only an answer that really did not
       * fit is halved. Halving a network failure doubles the billed calls to
       * solve a problem that was never about size.
       */
      if (looksLikeNetwork(message) && !retried) {
        pending.unshift({ slice, depth, retried: true })
        console.warn(`[extract] connexion perdue, on redemande la même tranche : ${message}`)
        continue
      }

      if (depth < MAX_SPLIT_DEPTH && isDivisible(slice)) {
        const halves = splitSlice(slice)
        pending.unshift(...halves.map((half) => ({ slice: half, depth: depth + 1, retried: false })))
        console.warn(`[extract] tranche en échec, redécoupée en ${halves.length} : ${message}`)
        continue
      }

      failedSlices++
      lastFailure = message
      console.error(`[extract] tranche abandonnée (${sizeOf(slice)}) : ${message}`)
      continue
    }

    usage = {
      costCents: usage.costCents + result.usage.costCents,
      inputTokens: usage.inputTokens + result.usage.inputTokens,
      outputTokens: usage.outputTokens + result.usage.outputTokens,
      modelId: result.usage.modelId,
    }

    /*
     * The number that explains the wait, per call, while it is still running.
     *
     * A step writes its totals only once it finishes, so a slow extraction
     * offers nothing to look at until it is over. Output tokens are the wait —
     * a call emitting twelve thousand of them takes minutes — and printing them
     * per slice turns "it seems stuck" into a figure, in the host's logs, as it
     * happens.
     */
    console.log(
      `[extract] tranche rendue : ${result.usage.outputTokens} tokens écrits, ` +
        `${result.usage.inputTokens} lus, ${result.value.entities.length} entités, ` +
        `${result.value.assertions.length} assertions`,
    )

    if (result.refusal) {
      refusal = result.refusal
      continue
    }

    /*
     * Put back what came in the wrong envelope, before anything is checked.
     *
     * Before filtering, because an event proposed as an entity must be an event
     * by the time relations are resolved against it — refiling it afterwards
     * would leave the assertions that name it quarantined for pointing at
     * something that no longer exists under that heading.
     */
    const refiled = refileMisfiled(result.value)
    if (refiled.refiled.events > 0 || refiled.refiled.mysteries > 0) {
      misfiled.events += refiled.refiled.events
      misfiled.mysteries += refiled.refiled.mysteries
      console.warn(
        `[extract] ${refiled.refiled.events} événement(s) et ` +
          `${refiled.refiled.mysteries} mystère(s) proposés comme entités, reclassés`,
      )
    }

    const sliceFiltered = filterExtraction(
      refiled.extraction,
      buildAnchorSources({
        textBlocks: slice.blocks,
        descriptions: slice.descriptions,
        allowedRefs: refs,
        // Only a scanned chapter was read by a machine. What you typed is
        // quoted exactly or not at all.
        tolerateNoise: context.sourceKind === 'pages',
      }),
      ontology,
      /*
       * Accepted entities *and* what earlier slices proposed.
       *
       * A reference to one of those is resolvable — it names a proposal this
       * run will publish — and without it here the relation that finally can
       * be written would be quarantined as `unknown_subject` on its way out.
       */
      new Set([
        ...knownEntities.map((e) => e.id),
        ...accepted.entities.map((entity) => entity.local_id),
      ]),
    )

    /*
     * Namespaced before anything else sees it, including the checkpoint.
     *
     * The resume path replays a recorded unit straight into `accepted`, so
     * recording the raw ids would put un-namespaced proposals back into a run
     * whose other slices are namespaced — the collision, restored from disk.
     */
    const key = sliceKey(slice)
    const scoped: FilterResult = {
      accepted: namespaceLocalIds(sliceFiltered.accepted, key.slice(0, 8)),
      quarantined: sliceFiltered.quarantined,
    }

    accepted.entities.push(...scoped.accepted.entities)
    accepted.assertions.push(...scoped.accepted.assertions)
    accepted.events.push(...scoped.accepted.events)
    accepted.mysteries.push(...scoped.accepted.mysteries)
    quarantined.push(...scoped.quarantined)

    /*
     * Written down the moment it lands.
     *
     * The proposals reach review_items only after every slice has returned, so
     * without this a run that dies on slice eighteen loses eighteen paid
     * answers. Recording here costs one small insert per call and removes the
     * only reason a retry was ever expensive.
     */
    await recordUnit(
      runId,
      userId,
      'extract_candidates',
      key,
      JSON.stringify(scoped),
    )
   }
  }

  await Promise.all(
    Array.from({ length: Math.min(SLICE_CONCURRENCY, Math.max(pending.length, 1)) }, () =>
      drain(),
    ),
  )

  if (failedSlices > 0 && failedSlices === slices.length) {
    // Every slice failed: not a bad patch, a broken step. Failing puts the
    // reason in the run instead of in a note under a green tick.
    throw new Error(
      `Les ${slices.length} tranche(s) ont échoué, y compris après redécoupage. ` +
        `Dernière erreur : ${lastFailure ?? 'inconnue'}`,
    )
  }

  if (refusal !== null && accepted.entities.length === 0 && accepted.assertions.length === 0) {
    return {
      note: `Le modèle a refusé : ${refusal}`,
      costCents: usage.costCents,
      modelId: usage.modelId,
    }
  }

  const filtered = { accepted, quarantined }

  await quarantineItems(context, filtered.quarantined)

  const decided = new Map(world.decisions.map((d) => [d.fingerprint, d.decision]))
  const explicitReview = new Set(
    world.preds.filter((p) => p.requiresExplicitReview).map((p) => p.key),
  )

  let queued = 0
  let reapplied = 0

  /*
   * Fingerprints already decided, with the evidence this fresh run produced for
   * them. Used to heal facts orphaned by a chapter deletion: the decision
   * correctly suppresses the proposal, but the existing assertion still needs
   * its citation back or replacing a bad scan leaves it uncheckable forever.
   */
  const decidedRefs = new Map<string, typeof filtered.accepted.assertions[number]['evidence']>()

  await withIngest(async (db) => {
    const rows: Array<typeof reviewItems.$inferInsert> = []

    for (const entity of filtered.accepted.entities) {
      const fingerprint = proposalFingerprint({
        kind: 'entity',
        subject: entity.label,
        evidence: entity.evidence,
      })

      if (decided.has(fingerprint)) {
        reapplied++
        continue
      }

      /*
       * A model that does not know what to call something says so, and is
       * believed.
       *
       * `naming_confident: false` is an admission, not a low score, so it
       * overrides confidence entirely: a model can be certain a ship is there
       * and have no idea whether its name is translated into French. Left to
       * decide alone it decides differently each chapter, and two labels
       * honestly derived from the source become two entities where there is one
       * — a failure evidence anchoring cannot catch, because both are anchored.
       *
       * Queued above true names, because it is the cheapest question in the
       * batch and the one whose answer is reused: the decision goes into the
       * glossary and every later chapter is handed it.
       */
      const naming = entity.naming_confident === false

      rows.push({
        runId,
        chapterId,
        userId,
        category: 'entity',
        // Identity-adjacent proposals go to the top of the queue: they are the
        // ones whose mistakes are hardest to undo later.
        priority: naming ? 95 : entity.label_kind === 'true_name' ? 90 : 50,
        payload: entity,
        proposalFingerprint: fingerprint,
        requiresExplicitReview: naming || entity.label_kind === 'true_name',
        confidence: entity.confidence,
      })
    }

    for (const assertion of filtered.accepted.assertions) {
      const fingerprint = proposalFingerprint({
        kind: 'assertion',
        subject: assertion.subject,
        predicate: assertion.predicate,
        object: assertion.object ?? assertion.object_value,
        evidence: assertion.evidence,
      })

      if (decided.has(fingerprint)) {
        reapplied++
        decidedRefs.set(fingerprint, assertion.evidence)
        continue
      }

      // Confidence never overrides this. Identity, death, hidden affiliation and
      // mystery resolution go through explicit review however sure the model is,
      // because these are precisely the claims whose premature acceptance
      // spoils the story rather than merely being wrong.
      const forced =
        explicitReview.has(assertion.predicate) ||
        assertion.epistemic_status === 'hypothetical'

      rows.push({
        runId,
        chapterId,
        userId,
        category: 'assertion',
        priority: forced ? 80 : Math.round(assertion.confidence * 40),
        payload: assertion,
        proposalFingerprint: fingerprint,
        requiresExplicitReview: forced,
        confidence: assertion.confidence,
      })
    }

    for (const event of filtered.accepted.events) {
      const fingerprint = proposalFingerprint({
        kind: 'event',
        subject: event.summary,
        evidence: event.evidence,
      })
      if (decided.has(fingerprint)) {
        reapplied++
        continue
      }
      rows.push({
        runId,
        chapterId,
        userId,
        category: 'event',
        priority: 40,
        payload: event,
        proposalFingerprint: fingerprint,
        requiresExplicitReview: false,
        confidence: event.confidence,
      })
    }

    for (const mystery of filtered.accepted.mysteries) {
      const fingerprint = proposalFingerprint({
        kind: 'mystery',
        subject: mystery.question,
        evidence: mystery.evidence,
      })
      if (decided.has(fingerprint)) {
        reapplied++
        continue
      }
      rows.push({
        runId,
        chapterId,
        userId,
        category: 'mystery',
        priority: 70,
        payload: mystery,
        proposalFingerprint: fingerprint,
        requiresExplicitReview: true,
        confidence: mystery.confidence,
      })
    }

    if (rows.length > 0) {
      await db.insert(reviewItems).values(rows)
      queued = rows.length
    }
  })

  const healed = await reanchorOrphans({
    userId,
    chapterId,
    refTable: table,
    proposals: decidedRefs,
  })

  const parts = [`${queued} propositions à revoir`]
  if (parallelPassages.length > 0) {
    // Worth a line: it changes what the model was shown, and therefore how the
    // names in this batch were arrived at. A run that read a second text and
    // one that did not are not the same run to compare.
    parts.push(
      `texte parallèle (${world.chapter.parallelLanguage}) fourni pour le nommage`,
    )
  }
  if (healed.healed > 0) {
    parts.push(`${healed.healed} fait(s) réancré(s) après suppression`)
  }
  if (misfiled.events + misfiled.mysteries > 0) {
    /*
     * Said out loud, because it changes what the review queue contains. A
     * proposal that arrives as an entity and is queued as an event is not the
     * card the model wrote, and a run where that happened is worth telling
     * apart from one where it did not — that is how the prompt gets measured.
     */
    parts.push(
      `${misfiled.events + misfiled.mysteries} proposition(s) reclassée(s) ` +
        `(événement ou mystère proposé comme entité)`,
    )
  }
  if (reapplied > 0) {
    parts.push(`${reapplied} déjà décidées lors d'un import précédent, non redemandées`)
  }
  if (filtered.quarantined.length > 0) {
    parts.push(`${filtered.quarantined.length} en quarantaine (preuve non vérifiable)`)
  }
  if (failedSlices > 0) {
    /*
     * Named, not swallowed. Panels in a slice that never came back are panels
     * whose facts are absent from the review queue — and an absence is the one
     * thing a reviewer cannot notice. Better a note saying which part of the
     * chapter was not read than a clean-looking run that quietly skipped it.
     */
    parts.push(
      `${failedSlices} tranche(s) abandonnée(s) après redécoupage — les cases concernées ` +
        `n'ont produit aucune proposition (dernière erreur : ${lastFailure ?? 'inconnue'})`,
    )
  }

  return {
    note: parts.join(' · '),
    costCents: usage.costCents,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    ...(usage.modelId ? { modelId: usage.modelId } : {}),
  }
}

/**
 * The ontology, rendered for the prompt.
 *
 * Read from the database rather than from the TypeScript constant, because a
 * user-created predicate has to be usable without a code change — the ontology
 * is stored as data precisely so that adding one needs no migration.
 *
 * The node types are listed, and were not. « N'utilisez aucun autre type ni
 * aucun autre prédicat » sat above a list of predicates alone, so the only
 * statement of what a type *is* was the arrows: `character|group → group`. A
 * model reading that infers the vocabulary correctly — the keys are all there —
 * and infers nothing at all about what belongs in each one, which is how a
 * chapter's six events arrived as six entities of type `event`, each with a
 * sentence for a name, none of them in the chronology. Naming the types costs a
 * few hundred cached tokens once per chapter.
 */
export function renderOntology(
  types: Array<{ key: string; labelFr: string; description: string | null }>,
  preds: Array<{
    key: string
    labelFr: string
    subjectTypes: string[]
    objectTypes: string[]
    description: string | null
  }>,
): string {
  // Keyed by plain string: the database may hold user-created predicates that
  // the TypeScript union does not know about, which is the whole point of
  // storing the ontology as data.
  const known = new Map<string, { description: string }>(
    PREDICATES.map((p) => [p.key as string, { description: p.description }]),
  )

  const typeLines = types.map(
    (type) =>
      `  ${type.key} (${type.labelFr})` +
      (type.description ? `\n      ${type.description}` : ''),
  )

  const predicateLines = preds.map((predicate) => {
    const builtin = known.get(predicate.key)
    const detail = predicate.description ?? builtin?.description ?? ''
    return (
      `  ${predicate.key} (${predicate.labelFr}) : ` +
      `${predicate.subjectTypes.join('|')} → ${predicate.objectTypes.join('|')}` +
      (detail ? `\n      ${detail}` : '')
    )
  })

  return [
    'Types de nœud :',
    ...typeLines,
    '',
    'Prédicats :',
    ...predicateLines,
  ].join('\n')
}

/**
 * One row per entity, keeping the highest-precedence label the join produced.
 *
 * The join emits a row per visible label, which is correct — an entity can have
 * an alias and an epithet both revealed by this chapter — but the prompt wants
 * one designation each. Taking the first non-null keeps whichever the index
 * ordered first rather than fabricating a choice.
 */
function dedupeById(
  rows: Array<{ id: string; nodeType: string; label: string | null }>,
): Array<{ id: string; label: string; nodeType: string }> {
  const byId = new Map<string, { id: string; label: string; nodeType: string }>()
  for (const row of rows) {
    if (byId.has(row.id)) continue
    byId.set(row.id, {
      id: row.id,
      nodeType: row.nodeType,
      // An entity with no label visible at this chapter is real and must still
      // be offered: it is exactly the not-yet-named figure the model needs to
      // be able to reference rather than re-create.
      label: row.label ?? 'entité sans nom révélé à ce chapitre',
    })
  }
  return [...byId.values()]
}
