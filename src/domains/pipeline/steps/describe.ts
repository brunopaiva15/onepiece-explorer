import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { withIngest } from '@/db/boundary.ts'
import { pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { storage } from '@/domains/storage/index.ts'
import { buildRefTable, type RefTable } from '../refs.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * A factual description of each panel.
 *
 * Panels are cropped and sent individually rather than sending whole pages. Two
 * reasons, and the second is the one that matters: a cropped panel is smaller
 * and therefore cheaper, and a model looking at one panel cannot accidentally
 * describe the panel next to it — which is how a quote ends up attributed to
 * the wrong picture while every id in the response looks perfectly valid.
 *
 * Crops are capped at ~1568px on the long side. Above that the token cost rises
 * (a full-resolution page is around 4 800 tokens against roughly 1 600) with no
 * gain in what the model can read.
 */

const MAX_CROP_EDGE = 1_568
/** Panels per request. Enough to amortise the cached prefix, small enough to retry. */
const BATCH_SIZE = 6

export async function runDescribe(context: StepContext): Promise<StepResult> {
  const { userId, chapterId, chapterNumber } = context
  const provider = modelProvider()
  const limits = ingestionLimits()
  const store = storage()

  const work = await withIngest(async (db) => {
    const pageRows = await db
      .select({
        id: pages.id,
        index: pages.index,
        displayKey: pages.storageKeyDisplay,
        originalKey: pages.storageKeyOriginal,
      })
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
        bbox: panels.bbox,
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

    return { pageRows, panelRows, blockRows }
  })

  if (work.panelRows.length === 0) {
    throw new Error('Aucune case à décrire : le découpage doit avoir réussi.')
  }

  const table = buildRefTable({
    panels: work.panelRows.map((panel) => ({
      id: panel.id,
      pageIndex: work.pageRows.find((p) => p.id === panel.pageId)?.index ?? 0,
      index: panel.index,
    })),
    blocks: work.blockRows,
  })

  // Text per panel ref, so the model reads the dialogue while looking at the
  // drawing. Passed inside an untrusted envelope by the provider.
  const textByRef: Record<string, string> = {}
  for (const block of work.blockRows) {
    if (!block.panelId) continue
    const ref = table.panelRefs.get(block.panelId)
    if (!ref) continue
    textByRef[ref] = textByRef[ref] ? `${textByRef[ref]}\n${block.text}` : block.text
  }

  const crops = await cropPanels(work, table, store, limits)

  let described = 0
  let costCents = 0
  let tokensIn = 0
  let tokensOut = 0
  let modelId: string | undefined
  let refusals = 0

  for (let start = 0; start < crops.length; start += BATCH_SIZE) {
    const batch = crops.slice(start, start + BATCH_SIZE)
    const refs = batch.map((crop) => crop.ref)

    const result = await provider.describePanels({
      chapterNumber,
      images: batch.map((crop) => ({
        data: crop.base64,
        mediaType: 'image/webp' as const,
        ref: crop.ref,
      })),
      allowedRefs: refs,
      text: Object.fromEntries(refs.map((ref) => [ref, textByRef[ref] ?? ''])),
    })

    costCents += result.usage.costCents
    tokensIn += result.usage.inputTokens
    tokensOut += result.usage.outputTokens
    modelId = result.usage.modelId

    if (result.refusal) {
      refusals += batch.length
      continue
    }

    await withIngest(async (db) => {
      for (const description of result.value) {
        const panelId = table.panelIds.get(description.panel_ref)
        // A description of a panel that was not in this batch is discarded
        // rather than stored against a guess. It has no anchor, and storing it
        // would give a later step visual "evidence" nobody produced.
        if (!panelId || !refs.includes(description.panel_ref)) continue

        await db
          .update(panels)
          .set({
            description: description.description,
            descriptionModel: result.usage.modelId,
          })
          .where(eq(panels.id, panelId))
        described++
      }
    })
  }

  const parts = [`${described}/${crops.length} cases décrites`]
  if (refusals > 0) parts.push(`${refusals} refus du modèle`)
  if (described === 0) {
    parts.push('aucune description : les preuves visuelles ne pourront pas être ancrées')
  }

  return {
    note: parts.join(' · '),
    costCents,
    tokensIn,
    tokensOut,
    ...(modelId ? { modelId } : {}),
  }
}

interface Crop {
  ref: string
  base64: string
}

/**
 * Crop each panel out of its page.
 *
 * Rounded outward by a small margin, because a detected box sits on the gutter
 * and cropping exactly on it shaves the panel border — which is often where a
 * sound effect or a small caption lives.
 */
async function cropPanels(
  work: {
    pageRows: Array<{ id: string; index: number; displayKey: string | null; originalKey: string }>
    panelRows: Array<{ id: string; pageId: string; index: number; bbox: { x: number; y: number; w: number; h: number } }>
  },
  table: RefTable,
  store: { get(key: string): Promise<Uint8Array> },
  limits: { maxPixelsPerPage: number },
): Promise<Crop[]> {
  const crops: Crop[] = []

  for (const page of work.pageRows) {
    const pagePanels = work.panelRows.filter((panel) => panel.pageId === page.id)
    if (pagePanels.length === 0) continue

    const bytes = await store.get(page.displayKey ?? page.originalKey)
    const image = sharp(Buffer.from(bytes), { limitInputPixels: limits.maxPixelsPerPage })
    const meta = await image.metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width === 0 || height === 0) continue

    for (const panel of pagePanels) {
      const ref = table.panelRefs.get(panel.id)
      if (!ref) continue

      const margin = 0.006
      const left = Math.max(0, Math.floor((panel.bbox.x - margin) * width))
      const top = Math.max(0, Math.floor((panel.bbox.y - margin) * height))
      const cropWidth = Math.min(
        width - left,
        Math.ceil((panel.bbox.w + margin * 2) * width),
      )
      const cropHeight = Math.min(
        height - top,
        Math.ceil((panel.bbox.h + margin * 2) * height),
      )
      if (cropWidth < 8 || cropHeight < 8) continue

      const buffer = await sharp(Buffer.from(bytes), {
        limitInputPixels: limits.maxPixelsPerPage,
      })
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .resize({
          width: Math.min(MAX_CROP_EDGE, cropWidth),
          height: Math.min(MAX_CROP_EDGE, cropHeight),
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer()

      crops.push({ ref, base64: buffer.toString('base64') })
    }
  }

  return crops
}
