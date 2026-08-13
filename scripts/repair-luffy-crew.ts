/**
 * Give Luffy's crew a node, and give it back the facts that were filed
 * elsewhere.
 *
 *   pnpm repair:luffy-crew                  # DIRECT_URL
 *   TEST_DB=1 pnpm repair:luffy-crew        # base de test
 *   pnpm repair:luffy-crew -- --dry-run     # dit ce qu'il ferait, n'écrit rien
 *
 * Chapter 41 puts Usopp on board « as captain, which Luffy instantly states is
 * his job », and the extraction wrote three relations about it: Luffy leads the
 * crew, Usopp joins it, twice. All three landed on « Équipage du Capitaine
 * Usopp » — the band of village children from chapter 27 — because Luffy's own
 * crew is not in the graph and never was. The story does not name it for
 * another fifty chapters, so nothing ever proposed it, and the model reached
 * for the nearest crew-shaped node there was. Nothing caught it: both ends are
 * groups, the excerpt is anchored, the confidence was ordinary. The fiche then
 * reads « Appartenances · Équipage du Capitaine Usopp », which is how the
 * defect was found.
 *
 * So this creates the missing group and repoints those three relations at it.
 * The chapter-27 membership and the chapter-40 departure are Usopp's real ties
 * to his real crew and are deliberately left alone — which is why the selection
 * below is written as an exact chapter and an exact object rather than as
 * « everything mentioning Usopp's crew ».
 *
 * Re-runnable. The group is found by label before it is created, and
 * `repointAssertion` reports an assertion it has already superseded instead of
 * stacking a second correction on the first — so a second pass writes nothing
 * and prints the same report.
 *
 * `--conditions=react-server` in the package script is not decoration: the
 * modules that write knowledge are marked `server-only`, and that flag is what
 * resolves the marker to its empty build outside Next.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'

/** The band of children from chapter 27 — the node that was wrongly aimed at. */
const USOPP_CREW_LABEL = 'Équipage du Capitaine Usopp'

/**
 * What the new node is called, and why it is not « Chapeau de Paille ».
 *
 * The reader is at chapter 41 and nobody has named this crew. « Équipage du
 * Chapeau de Paille » is the name the story gives it much later, and writing it
 * here would put a future name on a chapter-5 fiche — the precise spoiler the
 * whole boundary machinery exists to prevent. A placeholder is the honest
 * label: descriptive, drawn from what is on the page, and replaceable in one
 * rename the day the manga names them.
 */
const LUFFY_CREW_LABEL = 'Équipage de Luffy'

/** Chapter 5: Zoro accepts, and there is a crew to belong to. */
const LUFFY_CREW_FIRST_CHAPTER = 5

/** The chapter whose relations were misfiled. */
const MISFILED_CHAPTER = 41

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
  user_id: string
  work_id: string
  predicate: string
  subject_label: string
}

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })

  const sql = postgres(url, { max: 2, onnotice: () => {} })

  try {
    /*
     * The wrong node, found by name.
     *
     * Deliberately not a hard-coded uuid: the id is one library's, and a repair
     * that only works against the database it was written on cannot be checked
     * by running it. If the label is missing there is nothing to repair, and
     * saying so is the right outcome rather than a crash three queries later.
     */
    const [usoppCrew] = await sql<Array<{ id: string; user_id: string; work_id: string }>>`
      SELECT e.id, e.user_id, e.work_id
        FROM entities e
        JOIN entity_labels l ON l.entity_id = e.id
       WHERE e.node_type = 'group'
         AND l.label = ${USOPP_CREW_LABEL}
       LIMIT 1
    `

    if (!usoppCrew) {
      console.log(`Aucun groupe « ${USOPP_CREW_LABEL} » : rien à réparer.`)
      return
    }

    /*
     * The relations to move: this chapter, this object, these two predicates.
     *
     * `member_of` at chapter 27 is Usopp in his own crew and is true; `leaves`
     * at chapter 40 is him walking away from it and is true as well. Both are
     * excluded by the chapter, and the chapter is in the query rather than in a
     * comment for exactly that reason.
     */
    const misfiled = await sql<Row[]>`
      SELECT a.id, a.user_id, a.work_id, a.predicate,
             (SELECT l.label FROM entity_labels l
               WHERE l.entity_id = a.subject_entity_id
               ORDER BY l.precedence DESC, l.revealed_in_chapter DESC
               LIMIT 1) AS subject_label
        FROM assertions a
       WHERE a.object_entity_id = ${usoppCrew.id}
         AND a.knowledge_from_chapter = ${MISFILED_CHAPTER}
         AND a.predicate IN ('leads', 'member_of')
         AND a.review_status = 'accepted'
       ORDER BY a.created_at
    `

    if (misfiled.length === 0) {
      console.log('Aucune relation mal orientée au chapitre 41 : rien à réparer.')
      return
    }

    console.log(`${misfiled.length} relation(s) à réorienter :`)
    for (const row of misfiled) {
      console.log(`  - ${row.subject_label} · ${row.predicate} · → « ${USOPP_CREW_LABEL} »`)
    }

    const [existing] = await sql<Array<{ id: string }>>`
      SELECT e.id
        FROM entities e
        JOIN entity_labels l ON l.entity_id = e.id
       WHERE e.node_type = 'group'
         AND e.user_id = ${usoppCrew.user_id}
         AND e.work_id = ${usoppCrew.work_id}
         AND l.label = ${LUFFY_CREW_LABEL}
       LIMIT 1
    `

    if (dryRun) {
      console.log(
        existing
          ? `\n[dry-run] Le groupe « ${LUFFY_CREW_LABEL} » existe déjà (${existing.id}).`
          : `\n[dry-run] Créerait le groupe « ${LUFFY_CREW_LABEL} » au chapitre ${LUFFY_CREW_FIRST_CHAPTER}.`,
      )
      console.log('[dry-run] Rien n’a été écrit.')
      return
    }

    let crewId = existing?.id ?? null

    if (crewId === null) {
      const { normalizeText } = await import('../src/domains/knowledge/normalize.ts')
      const [created] = await sql<Array<{ id: string }>>`
        INSERT INTO entities (work_id, user_id, node_type, first_seen_chapter, review_status)
        VALUES (${usoppCrew.work_id}, ${usoppCrew.user_id}, 'group',
                ${LUFFY_CREW_FIRST_CHAPTER}, 'accepted')
        RETURNING id
      `
      crewId = created!.id

      /*
       * `placeholder`, at precedence 10, like every other label the pipeline
       * writes for something it can describe but not name. A true name here
       * would outrank the real one the day it arrives.
       */
      await sql`
        INSERT INTO entity_labels
          (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
        VALUES (${crewId}, ${usoppCrew.user_id}, ${LUFFY_CREW_LABEL},
                ${normalizeText(LUFFY_CREW_LABEL)}, 'placeholder',
                ${LUFFY_CREW_FIRST_CHAPTER}, 10)
      `
      console.log(`\nGroupe « ${LUFFY_CREW_LABEL} » créé (${crewId}), chapitre ${LUFFY_CREW_FIRST_CHAPTER}.`)
    } else {
      console.log(`\nGroupe « ${LUFFY_CREW_LABEL} » déjà présent (${crewId}).`)
    }

    const { repointAssertion } = await import('../src/domains/knowledge/repoint.ts')

    let moved = 0
    let already = 0

    for (const row of misfiled) {
      const result = await repointAssertion(row.user_id, {
        assertionId: row.id,
        objectEntityId: crewId,
        comment:
          'Chapitre 41 : la relation vise l’équipage de Luffy, pas la bande ' +
          'd’enfants du chapitre 27. Réorientée à la main.',
      })

      if (result.alreadyDone) {
        already++
        console.log(`  = ${row.subject_label} · ${row.predicate} — déjà corrigée`)
      } else {
        moved++
        console.log(
          `  → ${row.subject_label} · ${row.predicate} — ${result.assertionId} ` +
            `(${result.evidenceCopied} preuve(s) recopiée(s))`,
        )
      }
    }

    console.log(
      `\n${moved} relation(s) réorientée(s), ${already} déjà faite(s). ` +
        'Les anciennes lignes sont conservées en « superseded ».',
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

await main()
process.exit(0)
