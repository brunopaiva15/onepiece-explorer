/**
 * `pnpm queue` — what is in the job queue, and how to unwedge it.
 *
 *   pnpm queue                what the queue holds, by state
 *   pnpm queue --unstick      release jobs a killed worker left running
 *
 * Written after an evening lost to a worker that said "à l'écoute" while
 * nothing moved. The cause was not the worker: a previous one had taken a job,
 * the machine went to sleep, the pooler dropped the connection, and the process
 * was killed with the job still marked `active`. pg-boss reclaims such a job
 * only when it expires — an hour, for a chapter — and until then the chapter is
 * spoken for. Every new run sat at "en attente d'un worker", which named the one
 * thing that was not the problem.
 *
 * Nothing in the interface can show this: the queue is pg-boss's schema, not
 * ours, and the application deliberately never reads it. Hence a script.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { connectionStringIssue } from '../src/lib/connection-string.ts'

const testDb = process.env.TEST_DB === '1'
const url = testDb
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? '')

const issue = connectionStringIssue(url)
if (issue) {
  console.error(`DIRECT_URL : ${issue.problem}`)
  if (issue.fix) console.error(issue.fix)
  process.exit(1)
}

const schema = process.env.PGBOSS_SCHEMA ?? 'pgboss'
const QUEUE = 'chapter.process'

/**
 * How long a job may sit `active` before it is presumed dead.
 *
 * A chapter legitimately takes minutes. Ten of them without the worker having
 * touched the row means the worker is gone — it would otherwise have finished
 * it, failed it, or still be holding it open with a live connection.
 */
const PRESUMED_DEAD_MINUTES = 10

interface JobRow {
  id: string
  state: string
  created_on: Date
  started_on: Date | null
  singleton_key: string | null
  retry_count: number
  run_id: string | null
  minutes: number | null
  start_after: Date
  deferred: boolean
}

/**
 * The runs the interface is waiting on, next to the jobs that would advance them.
 *
 * This is the join nothing else can show. `/runs/[id]` reads our tables and says
 * "en attente d'un worker" for any run still `pending`; the queue lives in
 * pg-boss's schema, which the application never reads. So a run whose job was
 * deleted, refused, or never sent looks exactly like a run waiting for a worker
 * that simply is not running — and the remedy for the two is opposite.
 */
async function reportRuns(
  sql: ReturnType<typeof postgres>,
  jobs: JobRow[],
): Promise<void> {
  const runs = await sql<Array<{ id: string; chapter_id: string; status: string; minutes: number }>>`
    SELECT id::text, chapter_id::text, status,
           EXTRACT(EPOCH FROM (now() - created_at)) / 60 AS minutes
    FROM ingestion_runs
    WHERE status IN ('pending', 'running')
    ORDER BY created_at
  `

  if (runs.length === 0) {
    console.log('Aucun run en attente ni en cours.\n')
    return
  }

  const byRun = new Set(jobs.map((job) => job.run_id).filter(Boolean))
  console.log(`${runs.length} run(s) que l'interface attend :\n`)
  for (const run of runs) {
    const job = byRun.has(run.id)
    console.log(
      `  ${run.status.padEnd(8)} run ${run.id.slice(0, 8)} chapitre ${run.chapter_id.slice(0, 8)}` +
        ` depuis ${Math.round(run.minutes)} min — ` +
        (job
          ? 'un job existe dans la file'
          : 'AUCUN job dans la file : relancez le traitement, un worker ne le prendra jamais'),
    )
  }
  console.log()
}

async function main(): Promise<void> {
  const sql = postgres(url, { max: 2, onnotice: () => {} })

  const installed = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'job'
    ) AS exists
  `
  if (!installed[0]?.exists) {
    console.log(
      `Aucune file installée dans le schéma « ${schema} ». Elle est créée au premier import.`,
    )
    await sql.end({ timeout: 5 })
    return
  }

  const jobs = await sql<JobRow[]>`
    SELECT
      id::text,
      state::text,
      created_on,
      started_on,
      singleton_key,
      retry_count,
      data->>'runId' AS run_id,
      EXTRACT(EPOCH FROM (now() - started_on)) / 60 AS minutes,
      start_after,
      start_after > now() AS deferred
    FROM ${sql(schema)}.job
    WHERE name = ${QUEUE} AND state <= 'active'
    ORDER BY created_on
  `

  await reportRuns(sql, jobs)

  if (jobs.length === 0) {
    console.log('File vide : aucun job en attente ni en cours.')
  } else {
    console.log(`${jobs.length} job(s) dans « ${QUEUE} » :\n`)
    for (const job of jobs) {
      const age = job.minutes === null ? '' : ` depuis ${Math.round(job.minutes)} min`
      const chapter = job.singleton_key ? ` chapitre ${job.singleton_key.slice(0, 8)}` : ''
      const run = job.run_id ? ` run ${job.run_id.slice(0, 8)}` : ''
      const suspect =
        job.state === 'active' && (job.minutes ?? 0) > PRESUMED_DEAD_MINUTES
          ? '  ← bloqué, aucun worker ne le tient'
          : job.deferred
            ? `  ← différé jusqu'à ${job.start_after.toISOString()}, aucun worker ne le prendra avant`
            : ''
      console.log(
        `  ${job.state.padEnd(8)}${chapter}${run}${age}` +
          (job.retry_count > 0 ? ` (${job.retry_count} tentative(s))` : '') +
          suspect,
      )
    }
  }

  const stuck = jobs.filter(
    (job) => job.state === 'active' && (job.minutes ?? 0) > PRESUMED_DEAD_MINUTES,
  )

  if (stuck.length === 0) {
    console.log('\nRien de bloqué.')
    await sql.end({ timeout: 5 })
    return
  }

  if (!process.argv.includes('--unstick')) {
    console.log(
      `\n${stuck.length} job(s) bloqué(s). Relancez avec --unstick pour les libérer,` +
        ' puis relancez le traitement depuis la fiche du chapitre.',
    )
    console.log("Coupez d'abord « pnpm worker » : un worker vivant tient légitimement son job.")
    await sql.end({ timeout: 5 })
    return
  }

  /*
   * Deleted rather than failed. The job carries no history worth keeping — ours
   * is in `ingestion_runs`, which is updated just below — and a deleted row is
   * the only state that certainly releases the chapter, whatever the policy's
   * unique index happens to cover.
   */
  const ids = stuck.map((job) => job.id)
  await sql`DELETE FROM ${sql(schema)}.job WHERE name = ${QUEUE} AND id::text IN ${sql(ids)}`

  const runIds = stuck.map((job) => job.run_id).filter((id): id is string => Boolean(id))
  let marked = 0
  if (runIds.length > 0) {
    // The run said "pending" while its job was already dead. Say what happened,
    // in the row the interface actually reads. The count is the number of rows
    // the update touched, not the number it was aimed at — reporting the second
    // as if it were the first is how a script comes to claim work it never did.
    const runs = await sql`
      UPDATE ingestion_runs
      SET status = 'failed',
          error = 'Worker interrompu pendant le traitement (machine en veille, connexion perdue, ou arrêt du processus).',
          finished_at = now()
      WHERE id::text IN ${sql(runIds)} AND status IN ('pending', 'running')
    `
    marked = runs.count
    await sql`
      UPDATE chapters SET status = 'failed', updated_at = now()
      WHERE id IN (SELECT chapter_id FROM ingestion_runs WHERE id::text IN ${sql(runIds)})
        AND status = 'processing'
    `
  }

  console.log(`\n${ids.length} job(s) libéré(s), ${marked} run(s) marqué(s) en échec.`)
  console.log('Relancez le traitement depuis la fiche du chapitre.')

  await sql.end({ timeout: 5 })
}

main().catch((error: unknown) => {
  console.error('Échec :', error)
  process.exit(1)
})
