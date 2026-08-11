import 'server-only'
import { and, asc, eq, lte } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { reviewDecisions, reviewItems } from '@/db/schema/ingestion.ts'
import { entities, entityLabels, nodeTypes, predicates } from '@/db/schema/knowledge.ts'
import { chapters } from '@/db/schema/documents.ts'
import {
  buildAnchorSources,
  filterExtraction,
  proposalFingerprint,
  type OntologyView,
  type Quarantined,
} from '@/domains/ai/anchoring.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import type { Extraction, PanelDescription } from '@/domains/ai/schemas.ts'
import { PREDICATES } from '@/domains/knowledge/ontology.ts'
import { quarantineItems } from '../quarantine.ts'
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
 * Forty panels is roughly seven pages: enough context for a scene to hold
 * together, small enough that the answer — entities, assertions, events and
 * mysteries for all of them — finishes inside the output ceiling. A chapter of
 * 122 panels ran through that ceiling in a single call and came back truncated.
 */
const SLICE_PANELS = 40

/**
 * Panels in slices, each carrying the text blocks that belong to it.
 *
 * Blocks attached to no panel — a narration box in a gutter, a title — go with
 * the first slice rather than into every one: repeating them would have the
 * model propose the same fact once per slice.
 */
export function sliceChapter(
  descriptions: PanelDescription[],
  blocks: PromptBlock[],
): Array<{ descriptions: PanelDescription[]; blocks: PromptBlock[] }> {
  if (descriptions.length === 0) return [{ descriptions: [], blocks }]

  const orphans = blocks.filter((block) => block.panelRef === null)
  const slices: Array<{ descriptions: PanelDescription[]; blocks: PromptBlock[] }> = []

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
  const provider = modelProvider()

  const world = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ workId: chapters.workId })
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

    const types = await db.select({ key: nodeTypes.key }).from(nodeTypes)
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

    return { chapter, pageRows, panelRows, blockRows, known, types, preds, decisions }
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
        "Rien à extraire : ni texte transcrit ni description de case. " +
        "Vérifiez les étapes précédentes avant de relancer.",
      status: 'skipped',
    }
  }

  const knownEntities = dedupeById(world.known)

  const ontology: OntologyView = {
    nodeTypes: new Set(world.types.map((t) => t.key)),
    predicates: new Set(world.preds.map((p) => p.key)),
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
  let usage = { costCents: 0, inputTokens: 0, outputTokens: 0, modelId: undefined as string | undefined }
  let refusal: string | null = null

  for (const [index, slice] of slices.entries()) {
    if (slices.length > 1) {
      console.log(`[extract] tranche ${index + 1}/${slices.length}`)
    }

    const refs = [
      ...slice.descriptions.map((d) => d.panel_ref),
      ...slice.blocks.map((b) => b.ref),
    ]

    const result = await provider.extract({
      chapterNumber,
      ontology: renderOntology(world.preds),
      knownEntities,
      descriptions: slice.descriptions,
      textBlocks: slice.blocks,
      allowedRefs: refs,
    })

    usage = {
      costCents: usage.costCents + result.usage.costCents,
      inputTokens: usage.inputTokens + result.usage.inputTokens,
      outputTokens: usage.outputTokens + result.usage.outputTokens,
      modelId: result.usage.modelId,
    }

    if (result.refusal) {
      refusal = result.refusal
      continue
    }

    const sliceFiltered = filterExtraction(
      result.value,
      buildAnchorSources({
        textBlocks: slice.blocks,
        descriptions: slice.descriptions,
        allowedRefs: refs,
      }),
      ontology,
      new Set(knownEntities.map((e) => e.id)),
    )

    accepted.entities.push(...sliceFiltered.accepted.entities)
    accepted.assertions.push(...sliceFiltered.accepted.assertions)
    accepted.events.push(...sliceFiltered.accepted.events)
    accepted.mysteries.push(...sliceFiltered.accepted.mysteries)
    quarantined.push(...sliceFiltered.quarantined)
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

      rows.push({
        runId,
        chapterId,
        userId,
        category: 'entity',
        // Identity-adjacent proposals go to the top of the queue: they are the
        // ones whose mistakes are hardest to undo later.
        priority: entity.label_kind === 'true_name' ? 90 : 50,
        payload: entity,
        proposalFingerprint: fingerprint,
        requiresExplicitReview: entity.label_kind === 'true_name',
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
  if (healed.healed > 0) {
    parts.push(`${healed.healed} fait(s) réancré(s) après suppression`)
  }
  if (reapplied > 0) {
    parts.push(`${reapplied} déjà décidées lors d'un import précédent, non redemandées`)
  }
  if (filtered.quarantined.length > 0) {
    parts.push(`${filtered.quarantined.length} en quarantaine (preuve non vérifiable)`)
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
 */
function renderOntology(
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

  return preds
    .map((predicate) => {
      const builtin = known.get(predicate.key)
      const detail = predicate.description ?? builtin?.description ?? ''
      return (
        `  ${predicate.key} (${predicate.labelFr}) : ` +
        `${predicate.subjectTypes.join('|')} → ${predicate.objectTypes.join('|')}` +
        (detail ? `\n      ${detail}` : '')
      )
    })
    .join('\n')
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
