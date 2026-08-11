import 'server-only'
import { PgBoss } from 'pg-boss'
import { isVercelRuntime } from '@/lib/hosting.ts'

/**
 * The job queue, in Postgres.
 *
 * Postgres rather than Redis because the queue and the data it operates on are
 * then in one transaction boundary: enqueueing a run and writing the rows that
 * describe it cannot half-happen. Redis would be faster and would introduce a
 * second thing that can be up while the other is down.
 *
 * On the DIRECT connection, deliberately. pg-boss keeps long-lived listening
 * connections and owns its own schema; Supavisor in transaction mode hands the
 * connection to somebody else between statements, which breaks both.
 */

export const CHAPTER_QUEUE = 'chapter.process'

export interface ChapterJob {
  runId: string
  userId: string
  chapterId: string
}

let instance: PgBoss | null = null
let starting: Promise<PgBoss> | null = null

function connectionString(): string {
  const url =
    process.env.NODE_ENV === 'test' || process.env.TEST_DB === '1'
      ? process.env.TEST_DATABASE_URL
      : (process.env.DIRECT_URL ?? process.env.DATABASE_URL)

  if (!url) {
    throw new Error(
      "DIRECT_URL n'est pas configuré. La file de jobs exige la connexion directe (port 5432) : " +
        'pg-boss maintient des connexions longues et son propre schéma, ce que le pooler en mode transaction ne permet pas.',
    )
  }
  return url
}

/**
 * The shared instance, started once.
 *
 * `starting` guards against two concurrent callers each running the schema
 * migration pg-boss performs on first start.
 */
export async function boss(): Promise<PgBoss> {
  if (instance) return instance
  starting ??= (async () => {
    /*
     * On a serverless host, this process only ever *sends*.
     *
     * The web application enqueues a chapter and returns; the worker is the
     * only thing that ever takes a job off the queue, and on Vercel there is no
     * worker — it runs on the reader's machine against the same database.
     *
     * That distinction matters because pg-boss's default posture is a
     * long-lived server: it supervises jobs, runs a scheduler, and holds a pool
     * open. In a function that lives for the length of one request, those are
     * background timers that never get to do anything useful and connections
     * that are abandoned rather than closed — repeated on every cold start,
     * against a Supabase connection limit that is not large.
     *
     * One connection, no supervision, no scheduler. Migrations stay on: the
     * first enqueue against a fresh database still has to create the schema,
     * and getting that from whichever side happens to run first is correct.
     */
    const sendOnly = isVercelRuntime()

    const created = new PgBoss({
      connectionString: connectionString(),
      schema: process.env.PGBOSS_SCHEMA ?? 'pgboss',
      // A page-heavy chapter takes minutes, not seconds. The default would
      // declare the job abandoned and hand it to a second worker, which would
      // then race the first one writing the same panels.
      max: sendOnly ? 1 : 4,
      ...(sendOnly ? { supervise: false, schedule: false } : {}),
    })

    created.on('error', (error) => {
      console.error('[queue] erreur pg-boss :', error)
    })

    await created.start()
    await created.createQueue(CHAPTER_QUEUE, {
      /*
       * One run at a time per chapter, scoped by singletonKey at send time.
       *
       * `stately` allows one job per state, and *without* a singletonKey that
       * scope is the whole queue — so queueing chapter 2 while chapter 1 was
       * still waiting silently dropped chapter 2. The smoke test caught it as a
       * null job id. The dedup wanted here is per chapter: two runs over the
       * same pages would each delete the other's panels, while two runs over
       * different chapters are simply two pieces of work.
       */
      policy: 'stately',
    })

    instance = created
    return created
  })()

  return starting
}

export async function enqueueChapter(job: ChapterJob): Promise<string | null> {
  const queue = await boss()
  return queue.send(CHAPTER_QUEUE, job, {
    // Scopes the queue's `stately` dedup to one chapter. Without it the policy
    // applies across the whole queue and a second chapter's job is dropped.
    singletonKey: job.chapterId,
    // Retries are for transient failures — a dropped connection, a storage
    // timeout. A malformed page fails the same way every time, so the backoff
    // is short and the ceiling low; the failure is then visible in the run
    // rather than retried into the night.
    retryLimit: 2,
    retryDelay: 10,
    retryBackoff: true,
    // A page-heavy chapter can legitimately take a while; the ceiling exists
    // so a wedged job is eventually reclaimed rather than held forever.
    expireInSeconds: 3600,
  })
}

export async function stopQueue(): Promise<void> {
  if (!instance) return
  await instance.stop({ graceful: true, timeout: 30_000 })
  instance = null
  starting = null
}
