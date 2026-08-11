/**
 * Fetch the three illustration catalogues and cache them.
 *
 *   pnpm images:catalogue          # fetch if the cache is older than a month
 *   pnpm images:catalogue --force  # fetch regardless
 *
 * Separate from enrichment on purpose. Fetching ~1 200 rows from three free,
 * unauthenticated, community-run services is the part that depends on other
 * people's uptime and goodwill; matching and downloading is the part that
 * depends on your own data. Splitting them means a catalogue you already have
 * keeps working when one of the three is down, and means the enrichment run in
 * CI never opens a socket.
 */
import '../src/lib/load-env.ts'
import { buildCatalogue, cataloguePath, loadCatalogue, summarize } from '../src/domains/images/catalogue.ts'

async function main(): Promise<void> {
  const force = process.argv.includes('--force')

  console.log(`Cache : ${cataloguePath()}`)
  console.log(force ? 'Récupération forcée…' : 'Récupération si nécessaire…')

  const catalogue = force
    ? await writeThrough()
    : await loadCatalogue({ refresh: false })

  console.log(`\n${catalogue.candidates.length} illustrations · ${catalogue.fetchedAt}`)
  for (const line of summarize(catalogue)) {
    console.log(`  ${String(line.count).padStart(5)}  ${line.kind.padEnd(10)} ${line.source}`)
  }

  if (catalogue.failures.length > 0) {
    console.log('\nSources injoignables :')
    for (const failure of catalogue.failures) {
      console.log(`  ${failure.source} — ${failure.reason}`)
    }
    // Not an error exit. Two catalogues out of three still illustrate most of a
    // graph, and failing the command would make a partial success look like a
    // total one.
  }

  const withChapter = catalogue.candidates.filter(
    (candidate) => candidate.firstAppearanceChapter !== null,
  ).length
  console.log(
    `\n${withChapter} portent un chapitre de première apparition ` +
      '(utilisé comme garde-fou, jamais comme connaissance).',
  )
}

async function writeThrough() {
  const built = await buildCatalogue()
  const { writeFile, mkdir } = await import('node:fs/promises')
  const path = await import('node:path')
  const file = cataloguePath()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(built), 'utf8')
  return built
}

main().catch((error: unknown) => {
  console.error('\nÉchec :', error)
  process.exit(1)
})
