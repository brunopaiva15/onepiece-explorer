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
  auto_review: boolean
  runs: number
}

async function main(): Promise<void> {
  const sql = postgres(url, { max: 2, onnotice: () => {} })

  try {
    const empty = await sql<Row[]>`
      SELECT c.id,
             c.number,
             c.auto_review,
             (SELECT count(*)::int FROM ingestion_runs r WHERE r.chapter_id = c.id) AS runs
        FROM chapters c
       WHERE c.status = 'published'
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
      console.log('Aucun chapitre publié sans contenu. Rien à faire.')
      return
    }

    console.log(
      `${empty.length} chapitre(s) publié(s) sans la moindre proposition ni le ` +
        `moindre fait :`,
    )
    for (const row of empty) {
      console.log(
        `  · ${row.number} — ${row.runs} traitement(s), aucune carte, aucun fait` +
          (row.auto_review ? ' · importé en lot automatique' : ''),
      )
    }

    if (dryRun) {
      console.log('\n--dry-run : rien n’a été écrit.')
      return
    }

    const ids = empty.map((row) => row.id)

    /*
     * Remis en file seulement s'ils y avaient leur place.
     *
     * Un chapitre importé en lot automatique reprend la chaîne là où elle
     * s'était trompée. Un chapitre importé seul redevient simplement « à
     * traiter » : le remettre en file transformerait un choix de ne pas
     * dépenser en dépense déclenchée par un script de réparation.
     */
    const reset = await sql`
      UPDATE chapters
         SET status = 'uploaded',
             published_at = NULL,
             queued_for_run = auto_review,
             updated_at = now()
       WHERE id = ANY(${ids})
      RETURNING number, queued_for_run
    `

    const requeued = reset.filter((row) => row.queued_for_run === true).length

    console.log(
      `\n${reset.length} chapitre(s) dépubliés et rendus à « importé ». ` +
        `${requeued} remis dans la file : ouvrez n’importe quelle page de ` +
        `l’atelier pour que la chaîne les reprenne.`,
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
