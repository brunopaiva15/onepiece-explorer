import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { assertions, entityLabels } from '@/db/schema/knowledge.ts'
import { vectorStore, type EmbeddingRow } from '@/domains/search/index.ts'
import type { StepContext, StepResult } from './context.ts'

/**
 * Index this chapter's published knowledge for semantic search.
 *
 * Runs on *accepted* rows only, which is why it can sit at the end of the
 * pipeline and still be meaningful: indexing proposals would make search return
 * things the reader never agreed to, and the fact that they came back from a
 * search would lend them an authority the review step deliberately withheld.
 *
 * With no embedding provider the step reports itself skipped and says why —
 * the same honesty as OCR on a chapter whose PDF carried exact text. What it
 * must not do is write zero vectors: those index cleanly, rank confidently, and
 * are meaningless, so every semantic query would return the same wrong answers
 * with no error anywhere.
 */

const BATCH = 64

export async function runEmbed(context: StepContext): Promise<StepResult> {
  const store = await vectorStore()

  if (store.unavailableReason !== null) {
    return { note: store.unavailableReason, status: 'skipped' }
  }

  const { userId, chapterId, chapterNumber } = context

  const work = await withIngest(async (db) => {
    const [chapter] = await db
      .select({ workId: chapters.workId })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.userId, userId)))
      .limit(1)
    if (!chapter) throw new Error(`Chapitre introuvable : ${chapterId}`)

    const rows = await db
      .select({
        id: assertions.id,
        predicate: assertions.predicate,
        subjectId: assertions.subjectEntityId,
        objectId: assertions.objectEntityId,
        objectValue: assertions.objectValue,
      })
      .from(assertions)
      .where(
        and(
          eq(assertions.userId, userId),
          eq(assertions.knowledgeFromChapter, chapterNumber),
          eq(assertions.reviewStatus, 'accepted'),
        ),
      )

    if (rows.length === 0) return { workId: chapter.workId, rows, labelOf: new Map() }

    const involved = [
      ...new Set(
        rows.flatMap((row) =>
          [row.subjectId, row.objectId].filter((id): id is string => id !== null),
        ),
      ),
    ]

    const labels = await db
      .select({ entityId: entityLabels.entityId, label: entityLabels.label })
      .from(entityLabels)
      .where(
        and(
          inArray(entityLabels.entityId, involved),
          eq(entityLabels.lang, 'fr'),
        ),
      )
      .orderBy(sql`${entityLabels.precedence} DESC`)

    const labelOf = new Map<string, string>()
    for (const row of labels) {
      if (!labelOf.has(row.entityId)) labelOf.set(row.entityId, row.label)
    }

    return { workId: chapter.workId, rows, labelOf }
  })

  if (work.rows.length === 0) {
    return {
      note: 'Aucune assertion acceptée pour ce chapitre — rien à indexer.',
      status: 'skipped',
    }
  }

  /*
   * The text embedded is the sentence the assistant would read, not the raw
   * triple. Embedding "member_of" would put every affiliation in the corpus at
   * the same point in the space; embedding "Kaelo Renn appartient à la Guilde
   * des Marées" puts it near questions about Kaelo and about the Guild.
   */
  const documents = work.rows.map((row) => ({
    id: row.id,
    text: [
      work.labelOf.get(row.subjectId) ?? 'une entité',
      row.predicate,
      row.objectId
        ? (work.labelOf.get(row.objectId) ?? 'une entité')
        : literalOf(row.objectValue) ?? '',
    ]
      .filter(Boolean)
      .join(' '),
  }))

  const provider = context.provider
  let indexed = 0
  let costCents = 0
  let modelId = 'synthetic'

  for (let start = 0; start < documents.length; start += BATCH) {
    const batch = documents.slice(start, start + BATCH)
    const embedded = await provider.embed({ texts: batch.map((doc) => doc.text) })
    costCents += embedded.usage.costCents
    modelId = embedded.usage.modelId

    const rows: EmbeddingRow[] = []
    batch.forEach((doc, index) => {
      const vector = embedded.value[index]
      // A missing vector is skipped rather than substituted. A zero vector
      // would index and rank; an absent row simply is not found.
      if (!vector || vector.length === 0) return
      rows.push({
        userId,
        workId: work.workId,
        subjectKind: 'assertion',
        subjectId: doc.id,
        chapterNumber,
        modelId: embedded.usage.modelId,
        content: doc.text,
        vector,
      })
    })

    indexed += await store.upsert(rows)
  }

  return {
    note: `${indexed} assertion(s) indexée(s) · ${store.name}`,
    costCents,
    modelId,
  }
}

function literalOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value
    return inner === null || inner === undefined ? null : String(inner)
  }
  return String(value)
}
