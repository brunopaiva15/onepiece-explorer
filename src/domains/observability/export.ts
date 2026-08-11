import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { storage } from '@/domains/storage/index.ts'

/**
 * Export everything, in a form that outlives this application.
 *
 * The point is not backup — Postgres already does backup better than any JSON
 * dump. The point is that a private tool holding months of someone's reading
 * should not be able to hold it *hostage*. If this project stops being
 * maintained, or the reader wants their graph somewhere else, the whole thing
 * has to come out in a format anyone can read.
 *
 * Exported through `withIngest`, deliberately: an export is the reader asking
 * for their own data in full, not a view of the story at a chapter. Filtering it
 * by the boundary would silently produce a partial archive — the worst possible
 * failure for a backup, because it looks complete.
 *
 * Pages themselves are *not* included. They are the one thing that is not the
 * reader's own work, they are already files on their disk, and putting manga
 * pages into an export the tool then hands out would undo the whole
 * no-redistribution position. Storage keys are exported so a restore can
 * re-associate them with re-imported files.
 */

export interface ExportBundle {
  formatVersion: 1
  exportedAt: string
  work: unknown
  chapters: unknown[]
  documents: unknown[]
  pages: unknown[]
  panels: unknown[]
  textBlocks: unknown[]
  entities: unknown[]
  entityLabels: unknown[]
  entityImages: unknown[]
  assertions: unknown[]
  evidence: unknown[]
  events: unknown[]
  mysteries: unknown[]
  userTheories: unknown[]
  occurrences: unknown[]
  reviewDecisions: unknown[]
  ingestionRuns: unknown[]
  ingestionSteps: unknown[]
  auditLog: unknown[]
  counts: Record<string, number>
}

export async function exportEverything(userId: string): Promise<ExportBundle> {
  return withIngest(async (db) => {
    async function rows(query: ReturnType<typeof sql>): Promise<unknown[]> {
      return db.execute(query)
    }

    const work = await rows(sql`SELECT * FROM works WHERE user_id = ${userId}`)

    const bundle: ExportBundle = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      work: work[0] ?? null,
      chapters: await rows(
        sql`SELECT * FROM chapters WHERE user_id = ${userId} ORDER BY number`,
      ),
      documents: await rows(sql`SELECT * FROM documents WHERE user_id = ${userId}`),
      pages: await rows(
        sql`SELECT * FROM pages WHERE user_id = ${userId} ORDER BY chapter_number, index`,
      ),
      panels: await rows(sql`SELECT * FROM panels WHERE user_id = ${userId}`),
      textBlocks: await rows(sql`SELECT * FROM text_blocks WHERE user_id = ${userId}`),
      entities: await rows(sql`SELECT * FROM entities WHERE user_id = ${userId}`),
      entityLabels: await rows(
        sql`SELECT * FROM entity_labels WHERE user_id = ${userId}`,
      ),
      /*
       * Illustrations, as metadata only.
       *
       * The rows travel — which entity, which catalogue, which name matched —
       * so a restored library knows what it had and can fetch it again. The
       * image bytes do not, for the same reason the pages do not: an export
       * that carried them would turn this tool into a way of passing One Piece
       * artwork around, and re-downloading them is one command.
       */
      entityImages: await rows(
        sql`SELECT * FROM entity_images WHERE user_id = ${userId}`,
      ),
      // Ordered by revelation chapter so the archive reads as the reader's own
      // history rather than as insertion order.
      assertions: await rows(
        sql`SELECT * FROM assertions WHERE user_id = ${userId}
            ORDER BY knowledge_from_chapter, created_at`,
      ),
      evidence: await rows(sql`SELECT * FROM evidence WHERE user_id = ${userId}`),
      events: await rows(sql`SELECT * FROM events WHERE user_id = ${userId}`),
      mysteries: await rows(sql`SELECT * FROM mysteries WHERE user_id = ${userId}`),
      // The reader's own writing. The first thing they would miss.
      userTheories: await rows(
        sql`SELECT * FROM user_theories WHERE user_id = ${userId}`,
      ),
      occurrences: await rows(sql`SELECT * FROM occurrences WHERE user_id = ${userId}`),
      // Every decision they made in review. Re-importing without these would
      // ask them all over again.
      reviewDecisions: await rows(
        sql`SELECT * FROM review_decisions WHERE user_id = ${userId}`,
      ),
      ingestionRuns: await rows(
        sql`SELECT * FROM ingestion_runs WHERE user_id = ${userId}`,
      ),
      ingestionSteps: await rows(
        sql`SELECT * FROM ingestion_steps WHERE user_id = ${userId}`,
      ),
      auditLog: await rows(sql`SELECT * FROM audit_log WHERE user_id = ${userId}`),
      counts: {},
    }

    bundle.counts = {
      chapters: bundle.chapters.length,
      pages: bundle.pages.length,
      panels: bundle.panels.length,
      textBlocks: bundle.textBlocks.length,
      entities: bundle.entities.length,
      entityLabels: bundle.entityLabels.length,
      entityImages: bundle.entityImages.length,
      assertions: bundle.assertions.length,
      evidence: bundle.evidence.length,
      events: bundle.events.length,
      mysteries: bundle.mysteries.length,
      userTheories: bundle.userTheories.length,
      occurrences: bundle.occurrences.length,
      reviewDecisions: bundle.reviewDecisions.length,
    }

    return bundle
  })
}

/**
 * Delete everything belonging to one reader.
 *
 * The other half of the retention promise. Cascades do most of the work — the
 * `works` row is the root of nearly everything — but the tables keyed only by
 * `user_id` have to be named, and forgetting one is how a "delete my data"
 * feature quietly leaves data behind.
 *
 * Storage objects go too. Deleting the rows makes them unreachable but leaves
 * the bytes in the bucket, and a purge that reports success while the reader's
 * pages are still sitting there is not a purge.
 */
export async function purgeReader(
  userId: string,
): Promise<Record<string, number>> {
  const { withDestructive } = await import('@/db/boundary.ts')

  /*
   * Storage keys first, while the rows that name them still exist.
   *
   * Deleting the rows makes the objects unreachable but does not delete them —
   * the reader's pages and portraits would sit in the bucket after a purge that
   * reported success. "Delete everything" has to mean the bytes too, and the
   * only place that knows where they are is the tables about to be dropped.
   */
  const keys = await withIngest(async (db) => {
    const pageKeys = await db.execute<{
      original: string | null
      display: string | null
      thumb: string | null
    }>(sql`
      SELECT storage_key_original AS original,
             storage_key_display  AS display,
             storage_key_thumb    AS thumb
      FROM pages WHERE user_id = ${userId}
    `)
    const sourceKeys = await db.execute<{ storage_key: string }>(sql`
      SELECT storage_key FROM documents WHERE user_id = ${userId}
    `)
    const imageKeys = await db.execute<{
      storage_key: string
      thumb_key: string | null
    }>(sql`
      SELECT storage_key, thumb_key FROM entity_images WHERE user_id = ${userId}
    `)

    return [
      ...pageKeys.flatMap((row) => [row.original, row.display, row.thumb]),
      ...sourceKeys.map((row) => row.storage_key),
      ...imageKeys.flatMap((row) => [row.storage_key, row.thumb_key]),
    ].filter((key): key is string => typeof key === 'string' && key.length > 0)
  })

  const result = await withDestructive(
    `Purge complète des données de ${userId} à sa demande`,
    async (db) => {
      const deleted: Record<string, number> = {}

      /*
       * Order matters only where a cascade does not cover it. `works` takes
       * chapters, entities, assertions, evidence, runs and the rest with it;
       * these are the ones that outlive it.
       */
      const standalone = [
        'user_theories',
        'review_decisions',
        'embeddings',
        'quarantine',
        'audit_log',
      ] as const

      for (const table of standalone) {
        const rows = await db.execute<{ count: number }>(sql`
          WITH removed AS (
            DELETE FROM ${sql.identifier(table)} WHERE user_id = ${userId} RETURNING 1
          )
          SELECT count(*)::int AS count FROM removed
        `)
        deleted[table] = Number(rows[0]?.count ?? 0)
      }

      const works = await db.execute<{ count: number }>(sql`
        WITH removed AS (
          DELETE FROM works WHERE user_id = ${userId} RETURNING 1
        )
        SELECT count(*)::int AS count FROM removed
      `)
      deleted.works = Number(works[0]?.count ?? 0)

      const profiles = await db.execute<{ count: number }>(sql`
        WITH removed AS (
          DELETE FROM profiles WHERE id = ${userId} RETURNING 1
        )
        SELECT count(*)::int AS count FROM removed
      `)
      deleted.profiles = Number(profiles[0]?.count ?? 0)

      return deleted
    },
  )

  /*
   * Objects last, outside the transaction — same reasoning as chapter deletion.
   *
   * A storage failure must not roll back the purge: the rows would come back
   * while the objects stayed, and re-running would find nothing to delete. The
   * worst case here is a few unreferenced objects, which is recoverable; the
   * worst case the other way round is a purge that cannot complete.
   */
  const store = storage()
  let objectsDeleted = 0
  for (let i = 0; i < keys.length; i += 50) {
    const batch = keys.slice(i, i + 50)
    try {
      await store.remove(batch)
      objectsDeleted += batch.length
    } catch (error) {
      console.error(
        `[purge] ${batch.length} objet(s) non supprimé(s) du stockage :`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  return { ...result, storageObjects: objectsDeleted }
}
