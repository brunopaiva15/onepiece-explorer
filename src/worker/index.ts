import '@/lib/load-env.ts'
import { closeConnections } from '@/db/client.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { boss, CHAPTER_QUEUE, stopQueue, type ChapterJob } from '@/domains/pipeline/queue.ts'
import { pruneRateLimitEntries } from '@/domains/observability/rate-limit.ts'

/**
 * The pipeline worker.
 *
 * A separate process from the web server, on purpose. Panel detection decodes
 * full-resolution pages and the model steps will hold long-running batches;
 * doing either inside a request handler would tie a chapter's processing to the
 * lifetime of an HTTP connection and let a closed tab abandon it half-done.
 *
 *   pnpm worker        watch mode, for development
 *   pnpm worker:once   single process, for deployment
 *
 * Nothing progresses without it. That is stated in the README because the
 * failure mode — an import that sits at "pending" forever — looks like a bug in
 * the application rather than a process that was never started.
 */

let shuttingDown = false
let maintenance: NodeJS.Timeout | null = null

/** Six hours. The rows being trimmed have an hour-long useful life. */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Housekeeping the web server should not do.
 *
 * Rate-limit counters live in `audit_log` because it is already per-user and
 * already written on every meaningful action. The cost of that choice is that
 * they accumulate in the same table the reader consults to see what they did,
 * so they are trimmed here rather than left to bury the real entries.
 *
 * Failures are logged and swallowed: a worker that exits because a cleanup
 * query timed out would stop processing chapters, which is worse than a few
 * extra rows.
 */
async function sweep(): Promise<void> {
  try {
    const removed = await pruneRateLimitEntries()
    if (removed > 0) console.log(`[worker] ${removed} compteur(s) de débit purgé(s)`)
  } catch (error: unknown) {
    console.error('[worker] purge des compteurs impossible :', error)
  }
}

async function main(): Promise<void> {
  const queue = await boss()

  await sweep()
  maintenance = setInterval(() => void sweep(), MAINTENANCE_INTERVAL_MS)
  // Do not let the timer alone keep the process alive; pg-boss decides that.
  maintenance.unref()

  await queue.work<ChapterJob>(
    CHAPTER_QUEUE,
    {
      // One chapter at a time. The steps are I/O and CPU heavy and they write
      // to overlapping rows; parallelism here would buy contention.
      batchSize: 1,
      pollingIntervalSeconds: 2,
    },
    async ([job]) => {
      if (!job) return

      const { runId, userId, chapterId } = job.data
      console.log(`[worker] run ${runId} — chapitre ${chapterId}`)

      const result = await executeRun(userId, chapterId, runId)

      if (result.status === 'failed') {
        console.error(`[worker] run ${runId} échoué : ${result.error}`)
        // Throwing hands the job back to pg-boss for its retry policy. The
        // run row already records the failure, so the history survives even
        // if every retry fails.
        throw new Error(result.error ?? 'Échec du pipeline.')
      }

      console.log(`[worker] run ${runId} terminé`)
    },
  )

  console.log(`[worker] à l'écoute sur « ${CHAPTER_QUEUE} »`)
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[worker] ${signal} — arrêt en cours, on laisse finir le job courant`)
  try {
    if (maintenance) clearInterval(maintenance)
    await stopQueue()
    await closeConnections()
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((error: unknown) => {
  console.error('[worker] démarrage impossible :', error)
  process.exit(1)
})
