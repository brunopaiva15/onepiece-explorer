import 'server-only'
import { sql } from 'drizzle-orm'
import { withBoundary, withIngest } from '@/db/boundary.ts'

/**
 * The vector store of ADR 0005, with an honest third case.
 *
 * Two implementations were planned: pgvector on Supabase, a `real[]` cosine
 * fallback on the local CI database. Building it revealed a third state that
 * matters more than either — **no embedding provider at all**. Anthropic has no
 * embeddings endpoint, so unless a second provider is configured there is
 * nothing to put in the column.
 *
 * `NullVectorStore` is that state, and it *declares* itself rather than
 * returning an empty list. The difference is not pedantic: an empty result says
 * "nothing in your library matches", which is a claim about the corpus, and it
 * is false. A store that cannot search has to say so, or the assistant will
 * report insufficient data for questions it simply never looked up.
 */

export interface VectorHit {
  subjectKind: string
  subjectId: string
  content: string
  chapterNumber: number
  similarity: number
}

export interface VectorStore {
  readonly name: 'pgvector' | 'array' | 'none'
  /** Null when the store cannot search; the caller reports why. */
  readonly unavailableReason: string | null

  search(
    userId: string,
    boundaryChapter: number,
    vector: number[],
    limit?: number,
  ): Promise<VectorHit[]>

  upsert(rows: EmbeddingRow[]): Promise<number>
}

export interface EmbeddingRow {
  userId: string
  workId: string
  subjectKind: string
  subjectId: string
  chapterNumber: number
  modelId: string
  content: string
  vector: number[]
}

interface Row extends Record<string, unknown> {
  subject_kind: string
  subject_id: string
  content: string
  chapter_number: number
  similarity: number
}

/** No provider configured. Reports, never guesses. */
export class NullVectorStore implements VectorStore {
  readonly name = 'none' as const
  readonly unavailableReason =
    "Aucun fournisseur d'embeddings configuré : la recherche sémantique est " +
    'désactivée. La recherche plein texte, approchante et par graphe fonctionne.'

  async search(): Promise<VectorHit[]> {
    return []
  }

  async upsert(): Promise<number> {
    return 0
  }
}

/**
 * pgvector, with the HNSW index from migration 0007.
 *
 * Only usable at 1024 dimensions, because that is the width the column was
 * declared with and the trigger nulls `embedding_v` for anything else. A
 * narrower model is not silently reinterpreted — it falls to the array store,
 * which is slower and correct rather than fast and wrong.
 */
export class PgVectorStore implements VectorStore {
  readonly name = 'pgvector' as const
  readonly unavailableReason = null

  async search(
    userId: string,
    boundaryChapter: number,
    vector: number[],
    limit = 20,
  ): Promise<VectorHit[]> {
    const literal = `[${vector.join(',')}]`

    return withBoundary({ userId, boundaryChapter }, async (db) => {
      const rows = await db.execute<Row>(sql`
        SELECT subject_kind, subject_id, content, chapter_number,
               1 - (embedding_v <=> ${literal}::vector) AS similarity
        FROM embeddings
        WHERE embedding_v IS NOT NULL
        ORDER BY embedding_v <=> ${literal}::vector
        LIMIT ${limit}
      `)
      return rows.map(toHit)
    })
  }

  async upsert(rows: EmbeddingRow[]): Promise<number> {
    return upsertRows(rows)
  }
}

/**
 * Cosine similarity computed in SQL over `real[]`.
 *
 * O(n) with no index, which is fine at fixture scale and would not be in
 * production — hence pgvector being the production path. It exists so the
 * abstraction is exercised on every CI run rather than being a speculative
 * interface with one real implementation behind it.
 */
export class PgArrayVectorStore implements VectorStore {
  readonly name = 'array' as const
  readonly unavailableReason = null

  async search(
    userId: string,
    boundaryChapter: number,
    vector: number[],
    limit = 20,
  ): Promise<VectorHit[]> {
    const literal = `{${vector.join(',')}}`

    return withBoundary({ userId, boundaryChapter }, async (db) => {
      /*
       * Cosine over unnested arrays. The dimension guard is load-bearing:
       * without it, two vectors of different widths would zip to the shorter
       * one and produce a similarity that looks plausible and means nothing.
       */
      const rows = await db.execute<Row>(sql`
        WITH probe AS (SELECT ${literal}::real[] AS v)
        SELECT
          e.subject_kind, e.subject_id, e.content, e.chapter_number,
          (
            SELECT sum(a * b) / NULLIF(sqrt(sum(a * a)) * sqrt(sum(b * b)), 0)
            FROM unnest(e.embedding, probe.v) AS t(a, b)
          ) AS similarity
        FROM embeddings e, probe
        WHERE e.dimensions = array_length(probe.v, 1)
        ORDER BY similarity DESC NULLS LAST
        LIMIT ${limit}
      `)
      return rows.map(toHit)
    })
  }

  async upsert(rows: EmbeddingRow[]): Promise<number> {
    return upsertRows(rows)
  }
}

/**
 * Write embeddings through the ingest role.
 *
 * Indexing is a pipeline operation over a whole chapter, so it legitimately
 * writes rows the reader cannot yet see — the same exemption every other
 * pipeline step has.
 */
async function upsertRows(rows: EmbeddingRow[]): Promise<number> {
  if (rows.length === 0) return 0

  return withIngest(async (db) => {
    for (const row of rows) {
      await db.execute(sql`
        INSERT INTO embeddings
          (user_id, work_id, subject_kind, subject_id, chapter_number,
           model_id, dimensions, embedding, content)
        VALUES
          (${row.userId}, ${row.workId}, ${row.subjectKind}, ${row.subjectId},
           ${row.chapterNumber}, ${row.modelId}, ${row.vector.length},
           ${`{${row.vector.join(',')}}`}::real[], ${row.content})
        ON CONFLICT (subject_kind, subject_id, model_id) DO UPDATE SET
          embedding      = EXCLUDED.embedding,
          dimensions     = EXCLUDED.dimensions,
          content        = EXCLUDED.content,
          chapter_number = EXCLUDED.chapter_number
      `)
    }
    return rows.length
  })
}

function toHit(row: Row): VectorHit {
  return {
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    content: String(row.content),
    chapterNumber: Number(row.chapter_number),
    similarity: Number(row.similarity ?? 0),
  }
}

let cached: VectorStore | null = null

/**
 * Pick a store.
 *
 * The provider question comes first: with no way to embed a query there is
 * nothing to search *with*, whichever column exists. Only then does the
 * pgvector-versus-array choice matter.
 */
export async function vectorStore(): Promise<VectorStore> {
  if (cached) return cached

  if (!hasEmbeddingProvider()) {
    cached = new NullVectorStore()
    return cached
  }

  const usable = await pgvectorUsable()
  cached = usable ? new PgVectorStore() : new PgArrayVectorStore()
  return cached
}

export function resetVectorStore(): void {
  cached = null
}

/**
 * Is anything able to turn text into a vector?
 *
 * The synthetic provider's hashed bag-of-words counts, deliberately: it is not
 * semantic, but it is deterministic and genuinely useful for near-exact recall,
 * and it lets the whole path — store, index, query — run in tests instead of
 * being dead code guarded by a flag nobody sets.
 */
export function hasEmbeddingProvider(): boolean {
  const provider = process.env.MODEL_PROVIDER ?? 'anthropic'
  if (provider === 'synthetic' || provider === 'replay') return true

  /*
   * A self-hosted endpoint is what finally makes this step real.
   *
   * Anthropic exposes no embeddings endpoint, which is why this step has
   * declared itself skipped since the pipeline was written. An OpenAI-compatible
   * server usually serves one alongside the chat model, so both conditions have
   * to hold: the model is named, and the embed tier is actually routed there —
   * naming a model and then routing the tier elsewhere would leave this
   * returning true for a provider that cannot embed.
   */
  if (process.env.LOCAL_AI_EMBED_MODEL?.trim() && process.env.LOCAL_AI_MODEL?.trim()) {
    const tiers = process.env.LOCAL_AI_TIERS?.trim()
    if (!tiers) return true
    return tiers
      .split(',')
      .map((tier) => tier.trim())
      .includes('embed')
  }

  return Boolean(process.env.EMBEDDING_PROVIDER)
}

async function pgvectorUsable(): Promise<boolean> {
  try {
    return await withIngest(async (db) => {
      const rows = await db.execute<{ present: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'embeddings' AND column_name = 'embedding_v'
        ) AS present
      `)
      return rows[0]?.present === true
    })
  } catch {
    return false
  }
}
