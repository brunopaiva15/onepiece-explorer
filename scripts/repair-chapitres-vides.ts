/**
 * Rendre à la file les chapitres publiés qui ne contiennent rien.
 *
 *   pnpm repair:chapitres-vides                  # DIRECT_URL
 *   TEST_DB=1 pnpm repair:chapitres-vides        # base de test
 *   pnpm repair:chapitres-vides -- --dry-run     # dit ce qu'il ferait, n'écrit rien
 *
 * Un traitement qui n'extrait rien — le modèle a refusé, ou toutes ses
 * propositions sont parties en quarantaine faute de preuve vérifiable — laisse
 * la même file vide qu'une revue terminée. La passe automatique lisait la
 * seconde dans la première : plus rien à trancher, donc chapitre lu jusqu'au
 * bout, donc publié. Et chaque publication libérait la suivante, si bien que
 * l'erreur ne s'arrêtait pas à un chapitre : elle parcourait tout le lot.
 *
 * Le code ne le refera plus (`review/auto.ts` exige qu'une carte ait existé, et
 * une extraction qui refuse fait maintenant échouer l'étape). Restent ceux qui
 * sont déjà dans la bibliothèque, marqués publiés et vides, comptés dans la
 * frontière du lecteur.
 *
 * Ce que ce script juge, et ce qu'il ne touche pas. Un chapitre n'est « vide »
 * que s'il n'a **aucune** carte de revue, dans aucun état et pour aucun de ses
 * traitements, **et** que rien dans le graphe n'est daté de lui — ni entité vue
 * pour la première fois, ni assertion, ni occurrence. Les deux conditions, parce
 * qu'un chapitre dont les propositions ont toutes été réappliquées depuis une
 * décision antérieure a bien des faits sans avoir de cartes, et qu'il est
 * légitimement publié.
 *
 * Ce qu'il fait : le chapitre redevient `uploaded`, sa date de publication est
 * effacée, et il retourne dans la file s'il avait été importé pour se traiter
 * tout seul. Rien n'est supprimé — le texte importé reste, et c'est lui qu'un
 * nouveau traitement relira. Un chapitre publié à la main et réellement vide
 * n'existe pas : celui-là aurait des cartes.
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
  number: number
  status: string
  auto_review: boolean
  queued_for_run: boolean
  runs: number
}

async function main(): Promise<void> {
  const sql = postgres(url, { max: 2, onnotice: () => {} })

  try {
    const empty = await sql<Row[]>`
      SELECT c.id,
             c.number,
             c.status,
             c.auto_review,
             c.queued_for_run,
             (SELECT count(*)::int FROM ingestion_runs r WHERE r.chapter_id = c.id) AS runs
        FROM chapters c
       /*
        * A chapter that was processed and came back with nothing — whatever it
        * has been left as since.
        *
        * The first version asked for status = 'published', which is where the
        * bug left them and *not* where they stay: its own first run un-published
        * them without returning them to the queue, so a second run matched
        * nothing and the chapters sat as « importé » with no processing coming.
        * Having a run is what separates these from a chapter freshly imported
        * and deliberately not processed — that one has none, and sweeping it up
        * would turn a decision not to spend into a spend.
        */
       WHERE c.status <> 'review'
         AND EXISTS (
           SELECT 1 FROM ingestion_runs r WHERE r.chapter_id = c.id
         )
         AND NOT c.queued_for_run
         AND NOT EXISTS (
           SELECT 1 FROM ingestion_runs r
            WHERE r.chapter_id = c.id AND r.status IN ('pending', 'running')
         )
         AND NOT EXISTS (
           SELECT 1 FROM review_items i WHERE i.chapter_id = c.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM entities e
            WHERE e.work_id = c.work_id AND e.user_id = c.user_id
              AND e.first_seen_chapter = c.number
         )
         AND NOT EXISTS (
           SELECT 1 FROM assertions a
            WHERE a.work_id = c.work_id AND a.user_id = c.user_id
              AND a.knowledge_from_chapter = c.number
         )
         AND NOT EXISTS (
           SELECT 1 FROM occurrences o WHERE o.chapter_id = c.id
         )
       ORDER BY c.number
    `

    if (empty.length === 0) {
      console.log('Aucun chapitre traité sans rien produire. Rien à faire.')
      return
    }

    console.log(
      `${empty.length} chapitre(s) traité(s) sans la moindre proposition ni le ` +
        `moindre fait :`,
    )
    for (const row of empty) {
      console.log(
        `  · ${row.number} — ${row.runs} traitement(s), état « ${row.status} »,` +
          ` aucune carte, aucun fait`,
      )
    }

    if (dryRun) {
      console.log('\n--dry-run : rien n’a été écrit.')
      return
    }

    const ids = empty.map((row) => row.id)

    /*
     * Remis dans la file, tous, et marqués comme se relisant seuls.
     *
     * La première version conditionnait la remise en file à `auto_review`, par
     * prudence : ne pas transformer un choix de ne pas dépenser en dépense
     * déclenchée par un script. La prudence visait le mauvais cas. Ces
     * chapitres-là ont **déjà** été traités automatiquement — c'est la seule
     * façon dont ils ont pu être publiés vides — et la colonne est fausse dès
     * qu'ils ont été importés avant qu'elle existe, ou avec
     * AUTO_REVIEW_NAMES_ONLY pour toute l'instance. Résultat : dépubliés, hors
     * file, et plus rien pour les reprendre.
     *
     * Un chapitre importé et délibérément non traité n'entre pas ici : il n'a
     * aucun traitement, et c'est la condition qui l'exclut plus haut.
     */
    const reset = await sql`
      UPDATE chapters
         SET status = 'uploaded',
             published_at = NULL,
             queued_for_run = true,
             auto_review = true,
             updated_at = now()
       WHERE id = ANY(${ids})
      RETURNING number
    `

    console.log(
      `\n${reset.length} chapitre(s) rendus à « importé » et remis dans la file, ` +
        `à se traiter et se publier seuls comme la première fois.`,
    )
    console.log(
      'Ouvrez n’importe quelle page de l’atelier : le suivi en bas à droite ' +
        'reprend la chaîne au plus petit numéro.',
    )
    console.log(
      'Le texte de chaque chapitre est intact — c’est lui que le nouveau ' +
        'traitement relira.',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

await main()
