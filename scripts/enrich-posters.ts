/**
 * Les avis de recherche, rapatriés.
 *
 *   pnpm images:posters
 *
 * Reads the wiki's bounty gallery, pairs every printing the manifest knows with
 * a file, and stores it dated by the chapter that shows it. Run it once, and
 * again whenever src/domains/images/bounties.ts grows a row.
 *
 * It prints what it could *not* resolve, and that list is the point of the
 * command as much as the pictures are: a printing with no file is a line to add
 * to the manifest, and a run that quietly stored eleven of thirty-six would
 * tell you nothing about the twenty-five.
 *
 * Never guesses. A poster the gallery cannot be pinned to is skipped, and the
 * character keeps the portrait they already had.
 */
import '../src/lib/load-env.ts'
import { enrichBountyPosters } from '../src/domains/images/posters.ts'
import { closeConnections } from '../src/db/client.ts'

const userId = process.argv[2] ?? process.env.PUBLIC_LIBRARY_OWNER_ID ?? ''

if (!userId) {
  console.error(
    "Indiquez la bibliothèque à enrichir :\n" +
      '  pnpm images:posters <user-id>\n' +
      'ou renseignez PUBLIC_LIBRARY_OWNER_ID. Le réglage est affiché sur /admin/reglages.',
  )
  process.exit(1)
}

const report = await enrichBountyPosters(userId, {
  onProgress: (done, total) => {
    process.stdout.write(`\r  ${done}/${total} affiches`)
  },
})

process.stdout.write('\r')

console.log(`Personnages du manifeste présents dans la bibliothèque : ${report.considered}`)
console.log(`Tirages rattachés à un fichier : ${report.resolved}`)
console.log(`Affiches stockées : ${report.stored}`)
console.log(`Déjà en place : ${report.skipped}`)

if (report.unresolved.length > 0) {
  console.log(`\nSans fichier (${report.unresolved.length}) :`)
  for (const line of report.unresolved) console.log(`  · ${line}`)
  console.log(
    "\nLa galerie du wiki ne tient qu'une poignée d'anciens tirages, et les nomme\n" +
      "«  … Wanted Poster.png » sans dire lequel c'est. Pour en rattacher un,\n" +
      'ajoutez `file:` à sa ligne dans src/domains/images/bounties.ts.',
  )
}

if (report.failures.length > 0) {
  console.log(`\nÉchecs (${report.failures.length}) :`)
  for (const failure of report.failures) {
    console.log(`  · ${failure.what} : ${failure.reason}`)
  }
}

await closeConnections()
