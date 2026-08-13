/**
 * Attach a picture to every entity the pipeline extracted.
 *
 *   TEST_DB=1 pnpm images:enrich            # base de test
 *   pnpm images:enrich                      # DIRECT_URL
 *   pnpm images:enrich -- --limit 50        # premier essai, petit et observable
 *   pnpm images:enrich -- --offline         # interdit tout accès réseau au catalogue
 *
 * Reads the cached catalogue, matches each entity by name, downloads what it
 * finds and stores it in the private bucket. Re-runnable: an entity that already
 * has a picture is skipped, so a second pass only fills what the first missed.
 */
import '../src/lib/load-env.ts'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import postgres from 'postgres'

const testDb = process.env.TEST_DB === '1'
const url = testDb
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error(
    'Aucune connexion. Lancez avec TEST_DB=1 pour la base locale, ou renseignez DIRECT_URL.',
  )
  process.exit(1)
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  return process.argv[index + 1] ?? ''
}

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })

  /*
   * Local storage for a test run, and only for a test run.
   *
   * Illustrating a test library should not require a production bucket, so
   * TEST_DB=1 gets a temporary directory. A real run must not be given one:
   * defaulting to the filesystem there would write every portrait to whichever
   * machine happened to run the script, and a deployment reading the same
   * database would find rows pointing at files it cannot see — working locally,
   * broken everywhere else, with nothing saying so.
   *
   * Unset outside a test, the storage adapter decides. It defaults to Supabase
   * and says exactly what is missing if the service-role key is absent.
   */
  if (testDb && !process.env.STORAGE_DRIVER) {
    const root = await mkdtemp(path.join(tmpdir(), 'ope-images-'))
    Object.assign(process.env, { STORAGE_DRIVER: 'local', LOCAL_STORAGE_ROOT: root })
    console.log(`Stockage local temporaire : ${root}`)
  }

  const sql = postgres(url, { max: 2, onnotice: () => {} })
  const { enrichEntityImages, imageCoverage } = await import('../src/domains/images/index.ts')

  const users = await sql<Array<{ id: string }>>`SELECT id FROM profiles ORDER BY id`
  if (users.length === 0) {
    console.log('Aucun lecteur en base : rien à illustrer.')
    await sql.end({ timeout: 5 })
    return
  }

  const limitArg = flag('limit')
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined

  for (const user of users) {
    console.log(`\nLecteur ${user.id}`)

    const report = await enrichEntityImages(user.id, {
      limit: Number.isSafeInteger(limit) ? limit : undefined,
      offline: process.argv.includes('--offline'),
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          process.stdout.write(`\r  ${done}/${total} entités examinées`)
        }
      },
    })

    process.stdout.write('\n')
    console.log(`  catalogue    ${report.catalogueSize} illustrations disponibles`)
    console.log(`  examinées    ${report.considered}`)
    console.log(`  rapprochées  ${report.matched}`)
    console.log(`  dont wiki    ${report.fromWiki}`)
    console.log(`  stockées     ${report.stored}`)
    console.log(
      `  datées       ${report.preTimeskip} avant l'ellipse, ` +
        `${report.postTimeskip} après`,
    )
    console.log(`  sans image   ${report.unmatched}`)

    for (const failure of report.failures.slice(0, 10)) {
      console.log(`  échec « ${failure.label} » : ${failure.reason}`)
    }
    if (report.failures.length > 10) {
      console.log(`  … et ${report.failures.length - 10} autre(s)`)
    }
    for (const failure of report.catalogueFailures) {
      console.log(`  source injoignable : ${failure.source} — ${failure.reason}`)
    }

    const coverage = await imageCoverage(user.id)
    if (coverage.length > 0) {
      console.log('  couverture :')
      for (const line of coverage) {
        const share = line.total === 0 ? 0 : Math.round((line.illustrated / line.total) * 100)
        console.log(
          `    ${line.nodeType.padEnd(10)} ${line.illustrated}/${line.total} (${share} %)`,
        )
      }
    }
  }

  await sql.end({ timeout: 5 })
}

main().catch((error: unknown) => {
  console.error('\nÉchec de l’enrichissement :', error)
  process.exit(1)
})
