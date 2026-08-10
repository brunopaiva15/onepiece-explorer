import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, pages, panels, textBlocks } from '@/db/schema/documents.ts'
import { filterTranscription } from '@/domains/ai/anchoring.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import { assignToPanel } from '@/domains/documents/panels.ts'
import { normalizeText } from '@/domains/knowledge/normalize.ts'
import { storage } from '@/domains/storage/index.ts'
import { quarantineItems } from '../quarantine.ts'
import { buildRefTable, panelRef } from '../refs.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * Transcription.
 *
 * Three sources, in order of preference, and the order is entirely about
 * accuracy rather than convenience:
 *
 *   1. The PDF's own text layer. Exact, free, already positioned. If a chapter
 *      has one this step does nothing at all — a fact worth reporting, because
 *      "skipped, the source carried exact text" is the cheapest and best
 *      outcome and looks identical to a bug if unexplained.
 *   2. tesseract, in WASM. Free, offline, and mediocre on stylised manga
 *      lettering — good enough to locate text, often wrong about what it says.
 *   3. A multimodal model, for pages tesseract was unsure about.
 *
 * Nothing here interprets. A transcription that "fixes" a name is worse than
 * one that reports `[illisible]`, because the fix is silent and the excerpt it
 * produces will then anchor perfectly against text nobody wrote.
 */

/** Below this, tesseract's reading is not worth storing without a second pass. */
const TESSERACT_FLOOR = 0.55

export async function runOcr(context: StepContext): Promise<StepResult> {
  const { userId, chapterId } = context

  const existing = await withIngest(async (db) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))
    return row?.count ?? 0
  })

  if (existing > 0) {
    return {
      note:
        `Ignorée : ${existing} blocs de texte proviennent déjà de la couche texte du fichier. ` +
        `Cette transcription est exacte et gratuite — la refaire ne pourrait que la dégrader.`,
      status: 'skipped',
    }
  }

  const provider = modelProvider()
  const store = storage()

  const work = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ number: chapters.number, language: chapters.language })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

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

    return { chapter, pageRows, panelRows }
  })

  if (work.panelRows.length === 0) {
    throw new Error(
      'Aucune case détectée : la transcription a besoin du découpage en cases pour rattacher le texte.',
    )
  }

  let stored = 0
  let quarantined = 0
  let escalated = 0
  let costCents = 0
  let modelId: string | undefined

  for (const page of work.pageRows) {
    const pagePanels = work.panelRows.filter((p) => p.pageId === page.id)
    const table = buildRefTable({
      panels: pagePanels.map((p) => ({
        id: p.id,
        pageIndex: page.index,
        index: p.index,
      })),
      blocks: [],
    })

    const refs = [...table.panelIds.keys()]

    // Prefer tesseract, which is free, and only reach for the model on the
    // pages it could not read confidently.
    const local = await tesseractPage(page.displayKey ?? page.originalKey, work.chapter.language, store)

    const lowConfidence =
      local.blocks.length === 0 ||
      local.blocks.filter((b) => b.confidence < TESSERACT_FLOOR).length >
        local.blocks.length / 2

    let blocks = local.blocks
    let source: 'tesseract' | 'model' = 'tesseract'

    if (lowConfidence) {
      const key = page.displayKey ?? page.originalKey
      const bytes = await store.get(key)
      const result = await provider.transcribe({
        chapterNumber: work.chapter.number,
        images: [
          {
            data: Buffer.from(bytes).toString('base64'),
            mediaType: key.endsWith('.webp') ? 'image/webp' : 'image/png',
            ref: panelRef(page.index, 0),
          },
        ],
        allowedRefs: refs,
        language: work.chapter.language,
      })

      costCents += result.usage.costCents
      modelId = result.usage.modelId

      if (!result.refusal) {
        escalated++
        source = 'model'
        const filtered = filterTranscription(result.value.blocks, new Set(refs))
        quarantined += filtered.quarantined.length
        await quarantineItems(context, filtered.quarantined)

        blocks = filtered.accepted.map((block) => ({
          panelRef: block.panel_ref,
          text: block.text,
          kind: normaliseKind(block.kind),
          confidence: block.confidence,
          // The model returns a panel, not a box. The panel's own box is the
          // honest bbox: claiming a tighter one would be invented precision,
          // and the citation UI would then point at a rectangle nobody measured.
          bbox: pagePanels.find((p) => table.panelRefs.get(p.id) === block.panel_ref)?.bbox ?? null,
        }))
      }
    }

    if (blocks.length === 0) continue

    stored += await withIngest(async (db) => {
      const values = blocks.map((block, order) => {
        const panelId =
          block.panelRef && block.panelRef !== 'hors_case'
            ? (table.panelIds.get(block.panelRef) ?? null)
            : block.bbox
              ? panelIdFor(block.bbox, pagePanels)
              : null

        return {
          pageId: page.id,
          panelId,
          chapterId,
          userId,
          chapterNumber: work.chapter.number,
          bbox: block.bbox ?? { x: 0, y: 0, w: 1, h: 1 },
          text: block.text,
          normalizedText: normalizeText(block.text),
          lang: work.chapter.language,
          confidence: block.confidence,
          kind: block.kind,
          source,
          readingOrder: order,
        }
      })

      await db.insert(textBlocks).values(values)
      return values.length
    })
  }

  const parts = [`${stored} blocs transcrits`]
  if (escalated > 0) parts.push(`${escalated} page(s) relues par un modèle`)
  if (quarantined > 0) parts.push(`${quarantined} en quarantaine`)
  if (stored === 0) {
    parts.push(
      'aucun texte reconnu — vérifiez la qualité des pages ou fournissez un PDF avec couche texte',
    )
  }

  return {
    note: parts.join(' · '),
    costCents,
    ...(modelId ? { modelId } : {}),
  }
}

interface LocalBlock {
  panelRef: string | null
  text: string
  kind: 'bubble' | 'caption' | 'sfx' | 'sign' | 'other'
  confidence: number
  bbox: { x: number; y: number; w: number; h: number } | null
}

/**
 * tesseract, in WASM, on one page.
 *
 * Loaded lazily: the language data is several megabytes and a chapter with a
 * text layer never needs it. Failures are swallowed into an empty result rather
 * than propagated — a page tesseract cannot read is a page for the model, not a
 * failed run.
 */
async function tesseractPage(
  key: string,
  language: string,
  store: { get(key: string): Promise<Uint8Array> },
): Promise<{ blocks: LocalBlock[] }> {
  try {
    const { createWorker } = await import('tesseract.js')
    const bytes = await store.get(key)

    // 'fra' for French, falling back to English; tesseract's own naming.
    const traineddata = language.startsWith('fr') ? 'fra' : 'eng'
    const worker = await createWorker(traineddata)

    try {
      const { data } = await worker.recognize(Buffer.from(bytes), {}, { blocks: true })

      /*
       * tesseract reports boxes in the pixel space of the image it was given,
       * and its own Page object does not carry the dimensions. They have to come
       * from the image itself — not from the `pages` row, whose width and height
       * describe the original while this ran on the display derivative. Dividing
       * by the wrong pair would shift every box by the resize ratio, and a
       * shifted box attaches a quote to the wrong panel.
       */
      const sharp = (await import('sharp')).default
      const meta = await sharp(Buffer.from(bytes)).metadata()
      const imageWidth = meta.width ?? 0
      const imageHeight = meta.height ?? 0

      const blocks: LocalBlock[] = []
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
          const text = paragraph.text.trim()
          if (text.length === 0) continue
          blocks.push({
            panelRef: null,
            text,
            kind: 'bubble',
            confidence: paragraph.confidence / 100,
            bbox:
              imageWidth > 0 && imageHeight > 0
                ? {
                    x: paragraph.bbox.x0 / imageWidth,
                    y: paragraph.bbox.y0 / imageHeight,
                    w: (paragraph.bbox.x1 - paragraph.bbox.x0) / imageWidth,
                    h: (paragraph.bbox.y1 - paragraph.bbox.y0) / imageHeight,
                  }
                : null,
          })
        }
      }

      return { blocks }
    } finally {
      await worker.terminate()
    }
  } catch {
    // No language data, no network, a corrupt page: all of these mean "let the
    // model try", not "fail the chapter".
    return { blocks: [] }
  }
}

/**
 * Which panel a tesseract box falls in.
 *
 * tesseract knows nothing about panels, so its boxes arrive as page-relative
 * rectangles and have to be matched geometrically. A box overlapping no panel
 * keeps a null panel and is still stored — page furniture is text too.
 */
function panelIdFor(
  bbox: { x: number; y: number; w: number; h: number },
  pagePanels: Array<{ id: string; index: number; bbox: { x: number; y: number; w: number; h: number } }>,
): string | null {
  const index = assignToPanel(
    bbox,
    pagePanels.map((p) => ({ bbox: p.bbox, readingOrder: p.index, confidence: 1 })),
  )
  return index === null ? null : (pagePanels[index]?.id ?? null)
}

function normaliseKind(kind: string): LocalBlock['kind'] {
  switch (kind) {
    case 'bubble':
    case 'caption':
    case 'sfx':
    case 'sign':
      return kind
    // 'thought' has no column value; a thought bubble is still a bubble, and
    // inventing an enum value here would need a migration for a distinction
    // nothing yet uses.
    case 'thought':
      return 'bubble'
    default:
      return 'other'
  }
}
