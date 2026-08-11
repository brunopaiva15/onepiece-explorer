import '@/lib/load-env.ts'
import { closeConnections } from '@/db/client.ts'
import { executeRun } from '@/domains/pipeline/execute.ts'
import { boss, CHAPTER_QUEUE, stopQueue, type ChapterJob } from '@/domains/pipeline/queue.ts'
import { markRunFinished } from '@/domains/pipeline/runs.ts'
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

/**
 * The job this process is holding, if any.
 *
 * Tracked for one purpose: giving it back on the way out. Ctrl+C used to leave
 * it marked `active`, and pg-boss reclaims such a job only when it expires — an
 * hour, for a chapter — so the chapter stayed spoken for and every relaunch sat
 * at "en attente d'un worker" with a worker running. Stopping a process you
 * started should not wedge anything.
 */
let inFlight: { id: string; runId: string; chapterId: string } | null = null

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
      inFlight = { id: job.id, runId, chapterId }
      console.log(`[worker] run ${runId} — chapitre ${chapterId}`)

      try {
        const result = await executeRun(userId, chapterId, runId)

        if (result.status === 'failed') {
          console.error(`[worker] run ${runId} échoué : ${result.error}`)
          // Throwing hands the job back to pg-boss for its retry policy. The
          // run row already records the failure, so the history survives even
          // if every retry fails.
          throw new Error(result.error ?? 'Échec du pipeline.')
        }

        console.log(`[worker] run ${runId} terminé`)
      } finally {
        inFlight = null
      }
    },
  )

  console.log(`[worker] à l'écoute sur « ${CHAPTER_QUEUE} »`)
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  /*
   * The old message here said the current job would be allowed to finish. It
   * would not: the graceful stop waits thirty seconds and a chapter takes
   * twenty minutes, so the job was abandoned mid-flight and left `active`.
   * Saying so, and handing the job back, is the whole difference between a
   * stop and a wedge.
   */
  console.log(
    inFlight
      ? `[worker] ${signal} — le job en cours (run ${inFlight.runId}) est rendu à la file, ` +
        'le chapitre reste relançable'
      : `[worker] ${signal} — arrêt, aucun job en cours`,
  )

  try {
    if (maintenance) clearInterval(maintenance)

    if (inFlight) {
      const held = inFlight
      try {
        const queue = await boss()
        await queue.fail(CHAPTER_QUEUE, held.id, { reason: `worker arrêté (${signal})` })
        await markRunFinished(held.runId, {
          status: 'failed',
          error: `Worker arrêté (${signal}) pendant le traitement. Les étapes déjà réussies sont conservées : relancez.`,
        })
      } catch (error: unknown) {
        // Best effort. A failure here leaves exactly the state the old code
        // always left, and `pnpm queue --unstick` still resolves it.
        console.error(
          '[worker] le job en cours n’a pas pu être rendu :',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

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
