import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'

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
 * Storage objects are the caller's responsibility, because they are removed by
 * prefix and that is a different kind of operation from a transaction.
 */
export async function purgeReader(
  userId: string,
): Promise<Record<string, number>> {
  const { withDestructive } = await import('@/db/boundary.ts')

  return withDestructive(
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
}
