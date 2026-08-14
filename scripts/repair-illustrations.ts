/**
 * Forget the wiki illustrations today's rules would no longer accept.
 *
 *   pnpm repair:illustrations                  # DIRECT_URL
 *   TEST_DB=1 pnpm repair:illustrations        # base de test
 *   pnpm repair:illustrations -- --dry-run     # dit ce qu'il ferait, n'écrit rien
 *
 * The fiche « Équipage du Roux » opened on the coloured cover of chapter 1018.
 * Nothing had gone wrong at read time: MediaWiki's `pageimages` had answered
 * with that file when asked for the article's picture — it scores every image on
 * the page and a colour spread in a footnote wins — and the enrichment stored
 * the answer as the crew's portrait. The lookup now checks a lead image against
 * the name that asked for it and reads the article's own infobox when the check
 * fails, which is a correction to the rules; a library illustrated before it
 * still holds the picture the old rules found.
 *
 * `enrichEntityImages` cannot reach those rows. It skips an entity that already
 * has a picture, and its `recheck` pass re-judges rapprochements made on a
 * resemblance — the wiki's were made on an exact article title, which is still
 * exact. So this exists, and it is a one-off: run it once against a library
 * illustrated before the check, then `pnpm images:enrich` to fill the holes it
 * leaves.
 *
 * What it judges, and what it leaves alone. Only rows whose ref is a bare
 * `lang:title` — the article's lead image, the one `pageimages` chose. A ref
 * naming a file (`en:Nami#File:Nami Manga Pre Timeskip Infobox.png`) was chosen
 * by a rule that already checked the name against the subject, and re-asking
 * about it would be re-asking the wrong question anyway: those portraits are
 * fetched under a *catalogue's* name for the character, not under the label
 * stored beside them, so an empty answer would mean « asked in French », not
 * « no longer offered ».
 *
 * The article is re-asked by the title in the ref, and the row is forgotten only
 * when today's lookup no longer produces that exact ref. A wiki that answers
 * nothing at all for every title is an outage, not a verdict, and stops the run
 * before it deletes anything.
 *
 * `--conditions=react-server` in the package script is not decoration: the
 * module that removes the stored bytes is marked `server-only`, and that flag is
 * what resolves the marker to its empty build outside Next.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'

const dryRun = process.argv.includes('--dry-run')
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

interface Row {
  id: string
  entity_id: string
  source_ref: string
  matched_label: string
  storage_key: string
  thumb_key: string | null
}

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })

  const sql = postgres(url, { max: 2, onnotice: () => {} })

  try {
    const stored = await sql<Row[]>`
      SELECT id, entity_id, source_ref, matched_label, storage_key, thumb_key
        FROM entity_images
       WHERE source = 'fandom' AND kind = 'portrait'
         AND source_ref NOT LIKE '%#%'
       ORDER BY source_ref
    `

    if (stored.length === 0) {
      console.log('Aucune illustration de wiki à réexaminer.')
      return
    }

    console.log(`${stored.length} illustration(s) de wiki à réexaminer.`)

    const { lookupFandomImages } = await import('../src/domains/images/index.ts')

    /*
     * One lookup per article, not per row.
     *
     * Two entities can resolve to the same article — that is exactly what the
     * shared ref is for — and asking a free wiki twice for the same title to
     * reach the same verdict is a request nobody needs to make.
     */
    const verdicts = new Map<string, Set<string>>()
    let answered = 0

    for (const row of stored) {
      if (verdicts.has(row.source_ref)) continue

      // `fr:L'Équipage du Roux` — the language is what asked, the rest is the
      // article. Split once: a colon in a title belongs to the title.
      const cut = row.source_ref.indexOf(':')
      const title = cut === -1 ? row.source_ref : row.source_ref.slice(cut + 1)

      const found = await lookupFandomImages(title)
      if (found.length > 0) answered += 1
      verdicts.set(row.source_ref, new Set(found.map((candidate) => candidate.sourceRef)))
    }

    /*
     * An outage is not a verdict.
     *
     * Every title coming back empty means the wiki is unreachable far more often
     * than it means the library is entirely wrong, and the failure mode of
     * reading one as the other is deleting every illustration in it.
     */
    if (answered === 0) {
      console.error(
        `\nAucun des ${verdicts.size} articles n’a répondu : le wiki est probablement ` +
          'injoignable. Rien n’a été supprimé.',
      )
      process.exitCode = 1
      return
    }

    const refused = stored.filter((row) => !verdicts.get(row.source_ref)?.has(row.source_ref))

    console.log(
      `${verdicts.size} article(s) réinterrogé(s), ` +
        `${refused.length} illustration(s) que les règles d’aujourd’hui refusent.`,
    )
    for (const row of refused) {
      console.log(`  - « ${row.matched_label} » · ${row.source_ref}`)
    }

    if (refused.length === 0) return

    if (dryRun) {
      console.log('\n[dry-run] Rien n’a été supprimé.')
      return
    }

    const removed = await sql<Array<{ storage_key: string; thumb_key: string | null }>>`
      DELETE FROM entity_images
       WHERE id IN ${sql(refused.map((row) => row.id))}
      RETURNING storage_key, thumb_key
    `

    /*
     * The bytes, after the rows — the recoverable order, as in `enrich.ts`. A
     * file left in the bucket is an orphan nobody reads; a row pointing at a
     * file that is gone is a broken picture on a fiche.
     */
    try {
      const { storage } = await import('../src/domains/storage/index.ts')
      await storage().remove(
        removed
          .flatMap((row) => [row.storage_key, row.thumb_key])
          .filter((key): key is string => typeof key === 'string' && key.length > 0),
      )
    } catch (error: unknown) {
      console.log(
        `  (fichiers laissés dans le seau : ${
          error instanceof Error ? error.message : String(error)
        })`,
      )
    }

    console.log(`\n${removed.length} illustration(s) oubliée(s).`)
    console.log('Lancez « pnpm images:enrich » pour réillustrer ce qui vient d’être libéré.')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((error: unknown) => {
  console.error('\nÉchec de la réparation :', error)
  process.exit(1)
})
