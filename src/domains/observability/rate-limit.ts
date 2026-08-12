import 'server-only'
import { sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'

/**
 * Rate limiting for the operations that spend money.
 *
 * This is a single-account private tool, so the threat is not an attacker — it
 * is a loop. A retry that fires on every render, a script left running, a page
 * that re-asks on focus: any of those can turn a few cents into a bill nobody
 * chose, and the reader finds out from the invoice.
 *
 * So the limits are deliberately about *cost*, not about traffic. Reads are
 * unlimited; asking a question, launching a run and exporting are counted.
 *
 * Backed by `audit_log` rather than by an in-memory counter, which matters more
 * than it looks: several invocations can run at once, and a
 * serverless deployment is many. An in-process map would be reset by every cold
 * start, so the limit it enforced would depend on the deployment topology rather
 * than on the reader's actual usage.
 */

export type LimitedAction = 'ask' | 'start_run' | 'export'

interface Limit {
  /** Actions permitted in the window. */
  max: number
  windowMinutes: number
  /** Shown to the reader; explains the limit rather than just refusing. */
  explain: string
}

const LIMITS: Record<LimitedAction, Limit> = {
  ask: {
    max: 60,
    windowMinutes: 60,
    explain:
      "Chaque question appelle un modèle et coûte de l'argent. Soixante par heure " +
      "est bien au-delà d'une lecture normale, et en deçà de ce qu'une boucle " +
      'accidentelle dépenserait.',
  },
  start_run: {
    max: 30,
    windowMinutes: 60,
    explain:
      'Un traitement de chapitre est la dépense la plus lourde du système. Trente ' +
      "par heure permet d'importer un tome d'affilée sans permettre à un script " +
      'de traiter la même chose en boucle.',
  },
  export: {
    max: 10,
    windowMinutes: 60,
    explain:
      "L'export lit toute la bibliothèque. La limite protège la base, pas le " +
      'portefeuille.',
  },
}

export interface LimitVerdict {
  allowed: boolean
  used: number
  max: number
  /** Minutes until the oldest counted action leaves the window. */
  retryInMinutes: number | null
  explain: string
}

/**
 * Check and record in one step.
 *
 * Deliberately not two functions. A `check()` followed by a separate `record()`
 * has a window between them, and the case this guards against — a loop firing
 * faster than the round trip — is exactly the one that would slip through it.
 */
export async function consume(
  userId: string,
  action: LimitedAction,
): Promise<LimitVerdict> {
  const limit = LIMITS[action]

  return withIngest(async (db) => {
    const rows = await db.execute<{ used: number; oldest: Date | null }>(sql`
      SELECT count(*)::int AS used, min(created_at) AS oldest
      FROM audit_log
      WHERE user_id = ${userId}
        AND action = ${`rate:${action}`}
        AND created_at > now() - (${limit.windowMinutes} * interval '1 minute')
    `)

    const used = Number(rows[0]?.used ?? 0)

    if (used >= limit.max) {
      const oldest = rows[0]?.oldest ? new Date(rows[0].oldest) : null
      const retryInMinutes =
        oldest === null
          ? limit.windowMinutes
          : Math.max(
              1,
              Math.ceil(
                (oldest.getTime() + limit.windowMinutes * 60_000 - Date.now()) / 60_000,
              ),
            )

      return {
        allowed: false,
        used,
        max: limit.max,
        retryInMinutes,
        explain: limit.explain,
      }
    }

    await db.execute(sql`
      INSERT INTO audit_log (user_id, action, subject_kind)
      VALUES (${userId}, ${`rate:${action}`}, 'rate_limit')
    `)

    return {
      allowed: true,
      used: used + 1,
      max: limit.max,
      retryInMinutes: null,
      explain: limit.explain,
    }
  })
}

/**
 * Trim the counter rows.
 *
 * They are written to `audit_log` because it already exists and is already
 * per-user, but they are not audit entries anyone will ever read — a month of
 * them would bury the real ones.
 *
 * Plain `withIngest`, not `withDestructive`: the destructive wrapper exists to
 * mark deletions of *history*, and it is the only way past the append-only
 * trigger on assertions. A counter is not history, and matching on the
 * `rate:` prefix means a real audit entry cannot be caught by mistake.
 */
export async function pruneRateLimitEntries(olderThanHours = 24): Promise<number> {
  return withIngest(async (db) => {
    const rows = await db.execute<{ count: number }>(sql`
      WITH removed AS (
        DELETE FROM audit_log
        WHERE action LIKE 'rate:%'
          AND created_at < now() - (${olderThanHours} * interval '1 hour')
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM removed
    `)
    return Number(rows[0]?.count ?? 0)
  })
}

/** Current usage, for the settings page. */
export async function usage(
  userId: string,
): Promise<Array<{ action: LimitedAction; used: number; max: number }>> {
  return withIngest(async (db) => {
    const results: Array<{ action: LimitedAction; used: number; max: number }> = []

    for (const [action, limit] of Object.entries(LIMITS) as Array<
      [LimitedAction, Limit]
    >) {
      const rows = await db.execute<{ used: number }>(sql`
        SELECT count(*)::int AS used FROM audit_log
        WHERE user_id = ${userId}
          AND action = ${`rate:${action}`}
          AND created_at > now() - (${limit.windowMinutes} * interval '1 minute')
      `)
      results.push({ action, used: Number(rows[0]?.used ?? 0), max: limit.max })
    }

    return results
  })
}
