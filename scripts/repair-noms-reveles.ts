/**
 * Les noms que l'histoire révèle après coup, du chapitre 1 au 137.
 *
 *   pnpm repair:noms -- --dry-run     # dit tout, n'écrit rien
 *   pnpm repair:noms                  # applique
 *   TEST_DB=1 pnpm repair:noms        # base de test
 *
 * Le fil s'arrête de renommer au chapitre 51. Les lignes « un nom : » y sont
 * six, aux chapitres 23, 25, 26, 42 et 51 — exactement la portée de
 * `repair:chapitres-1-42` et `repair:chapitres-1-100`. Ce ne sont pas les
 * révélations qui cessent, c'est la relecture : au-delà, un chapitre qui apprend
 * au lecteur le vrai nom de quelqu'un qu'il connaît déjà écrit un **second
 * nœud**, et les deux vivent côte à côte pour le reste de l'histoire.
 *
 * Ce script ne répare pas des doublons, et c'est la distinction qui commande
 * tout ce qui suit. « Homme mystérieux debout sur l'eau » n'est pas une erreur :
 * c'est ce que le lecteur savait au chapitre 130, et le curseur doit pouvoir y
 * revenir. Le défaut n'est pas que le nœud existe, c'est que rien ne dit qu'il
 * devient Wapol au 131.
 *
 * D'où deux différences avec le `fold()` de `repair:details`, qui traite de
 * vrais doublons :
 *
 *   Les deux nœuds restent **acceptés**. Rejeter le provisoire effacerait
 *   l'état d'avant la révélation, qui est précisément ce que la frontière
 *   existe pour garder. Seul le `same_as` est écrit, daté du chapitre qui
 *   révèle : sous ce chapitre l'union-find ne le voit pas et les deux nœuds
 *   sont deux ; à partir de lui ils n'en font qu'un, affiché sous le nom le
 *   mieux classé de la composante.
 *
 *   La date ne vient pas de celui qui écrit le script. C'est le point qui a
 *   décidé de la forme de ce fichier : je peux lire dans le fil que deux nœuds
 *   sont la même personne — ils se croisent dans la prose d'un même chapitre,
 *   ou ils entrent en scène tous les deux — mais dater une révélation de
 *   mémoire, c'est écrire le spoiler que `naming.ts` a été écrit pour empêcher.
 *   La bibliothèque, elle, sait répondre : le nom est un mot, les sources sont
 *   dans `text_blocks`, et « à quel chapitre ce mot apparaît-il pour la première
 *   fois » a une réponse vérifiable. Le tableau ci-dessous porte donc des
 *   couples et jamais des chapitres.
 *
 * Un couple dont la date est indatable est laissé tel quel, et dit pourquoi.
 * Un couple dont le nom apparaît **avant** l'entrée en scène du nœud provisoire
 * est refusé aussi : ce n'est pas une révélation mais un doublon — le lecteur
 * pouvait lire ce nom quand le nœud a été créé — et un doublon se répare
 * ailleurs, avec l'outil qui le retire du graphe.
 *
 * Rien n'est supprimé, et une fusion se défait : la relation d'identité est un
 * fait comme un autre sur la fiche, que « ce fait est faux » retire.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { normalizeText } from '../src/domains/knowledge/normalize.ts'

const dryRun = process.argv.includes('--dry-run')
const testDb = process.env.TEST_DB === '1'
const url = testDb
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error(
    'Aucune connexion configurée.\n' +
      '  • Production : DIRECT_URL dans .env.local (connexion directe, port 5432).\n' +
      '  • Tests : TEST_DB=1, et TEST_DATABASE_URL si la base n’est pas celle par défaut.',
  )
  process.exit(1)
}

const NOTE = 'repair:noms — nom révélé par un chapitre ultérieur'

/**
 * Les couples relevés en relisant le fil des chapitres 1 à 137.
 *
 * `why` est ce que le fil montre, et rien d'autre — pas ce que je crois savoir
 * du manga. Chacun est vérifiable dans le fil lui-même : soit les deux nœuds
 * entrent en scène, soit ils se croisent dans la prose d'un même chapitre, soit
 * le nom circule dans les phrases sans qu'aucun nœud ne le porte.
 *
 * `revealed` accepte plusieurs graphies parce que la bibliothèque en porte
 * parfois deux — la première trouvée gagne. `provisional` aussi, pour la même
 * raison.
 */
const RÉVÉLATIONS: ReadonlyArray<{
  provisional: string[]
  revealed: string[]
  why: string
}> = [
  {
    provisional: ['Silhouette géante'],
    revealed: ['Brogy'],
    why: 'la silhouette entre en scène au 115, Brogy au 116',
  },
  {
    provisional: ['Fille au sabre ressemblant à Kuina'],
    revealed: ['Tashigi'],
    why: 'Tashigi est nommée dans la prose du 97 et n’a aucun nœud',
  },
  {
    provisional: ['Belle femme observée par Sanji'],
    revealed: ['Alvida'],
    why: '« la belle femme est en fait Alvida », dans la prose du 98',
  },
  {
    provisional: ['Miss Wednesday'],
    revealed: ['Nefertari Vivi', 'Vivi'],
    why: 'Miss Wednesday et Vivi sont tous deux dans la prose du 110',
  },
  {
    provisional: ['Mr 8', 'Mr. 8'],
    revealed: ['Igaram'],
    why: 'Mr 8 et Igaram sont tous deux dans la prose du 110',
  },
  {
    provisional: ['Docteur sorcière de l’île', 'Docteur sorcière de l’île'],
    revealed: ['Dr Kureha', 'Dr. Kureha'],
    why: 'la « doctoresse sorcière » du 132 est la Dr Kureha nommée au 133',
  },
  {
    provisional: ['Homme mystérieux debout sur l’eau'],
    revealed: ['Wapol'],
    why: 'les deux entrent en scène au même chapitre 131',
  },
]

interface Work {
  id: string
  user_id: string
}

interface Counters {
  [key: string]: number
}

await main()
process.exit(0)

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  const done: Counters = {}
  const bump = (key: string, by = 1): number => (done[key] = (done[key] ?? 0) + by)

  try {
    const [work] = await sql<Work[]>`
      SELECT id, user_id FROM works ORDER BY created_at LIMIT 1
    `
    if (!work) {
      console.log('Aucune œuvre dans cette base : rien à réparer.')
      return
    }

    console.log(dryRun ? '— dry-run : rien ne sera écrit —\n' : '')
    console.log('NOMS RÉVÉLÉS PLUS TARD')

    for (const entry of RÉVÉLATIONS) await reveal(sql, work, entry, bump)

    console.log('\n' + (dryRun ? '[dry-run] Rien écrit. ' : '') + summarise(done))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Un couple, de bout en bout : le trouver, le dater, l'écrire.
 *
 * L'ordre des refus est celui du coût de l'erreur. Un nœud introuvable ne coûte
 * rien — la bibliothèque n'a pas ces chapitres, ou les nomme autrement. Une
 * date introuvable coûte le silence, ce qui est le bon prix. Une date antérieure
 * à l'entrée en scène coûte une fusion fausse, et c'est celle qu'il faut
 * refuser bruyamment.
 */
async function reveal(
  sql: postgres.Sql,
  work: Work,
  entry: (typeof RÉVÉLATIONS)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const provisional = await entityByLabels(sql, work, entry.provisional)
  if (!provisional) {
    console.log(`  ! « ${entry.provisional[0]} » introuvable`)
    return
  }

  const revealed = await entityByLabels(sql, work, entry.revealed)
  const name = revealed?.label ?? entry.revealed[0]!

  /*
   * Le couple qui n'en est plus un.
   *
   * Un nom sans nœud est écrit *sur* le nœud provisoire, donc au passage
   * suivant les deux moitiés du couple désignent la même fiche : « Tashigi »
   * résout vers la sabreuse du 96, qui le porte maintenant. Une identité d'une
   * entité vers elle-même est refusée par la base, et à juste titre — mais la
   * refuser ici est la seule façon d'être re-jouable, ce qu'un script de
   * réparation doit être.
   */
  if (revealed !== null && revealed.id === provisional.id) {
    console.log(`  = « ${provisional.label} » porte déjà « ${name} »`)
    return
  }

  const from = await firstChapterNaming(sql, work, name)
  if (from === null) {
    console.log(
      `  ! « ${name} » n’apparaît dans aucune source : indatable, laissé tel quel`,
    )
    return
  }

  /*
   * Une révélation vient après. Sinon, c'est un doublon.
   *
   * Le nœud provisoire est daté du chapitre où le lecteur l'a rencontré sans
   * nom. Si le nom était déjà lisible à ce chapitre-là, il n'a jamais été
   * provisoire : deux nœuds ont été écrits pour une personne que la source
   * nommait, et les rejoindre par un `same_as` daté laisserait le doublon
   * visible sous ce chapitre. Ce cas se répare avec l'outil qui retire la
   * copie, pas avec celui-ci.
   */
  if (from <= provisional.firstSeen) {
    console.log(
      `  ! « ${provisional.label} » → « ${name} » : le nom est lisible dès le ${from}, ` +
        `et le nœud entre en scène au ${provisional.firstSeen} — c’est un doublon, ` +
        `pas une révélation. Non traité ici.`,
    )
    return
  }

  console.log(
    `  → « ${provisional.label} » (ch. ${provisional.firstSeen}) est « ${name} » ` +
      `à partir du ch. ${from} — ${entry.why}`,
  )

  if (revealed === null) {
    /*
     * Le nom sans nœud : un libellé de plus sur celui qui existe.
     *
     * Tashigi est nommée dans les phrases du 97 et n'est nulle part un nœud, si
     * bien que la question ouverte au 96 — « quel est le lien entre la jeune
     * sabreuse et Kuina » — ne pouvait se refermer sur personne. Le nom entre à
     * sa pleine précédence, donc la fiche l'affiche à partir de sa date, et la
     * désignation provisoire reste en dessous : au 96 elle est encore tout ce
     * que le lecteur a.
     */
    if (await hasLabel(sql, work, provisional.id, name)) {
      console.log(`      = « ${name} » déjà sur ce nœud`)
      return
    }
    console.log(`      + « ${name} » comme vrai nom, révélé ch. ${from}`)
    if (dryRun) return
    await addTrueName(sql, work, provisional.id, name, from)
    bump('noms')
    return
  }

  if (revealed.nodeType !== provisional.nodeType) {
    console.log(
      `      ! types différents (${provisional.nodeType} / ${revealed.nodeType}) : ` +
        `une identité entre deux types est une question, pas une réparation. Ignoré.`,
    )
    return
  }

  if (revealed.revealedIn !== null && revealed.revealedIn !== from) {
    // Dit plutôt que corrigé : le libellé peut avoir été daté à la main, et la
    // date du texte n'est une meilleure réponse que lorsque personne n'a tranché.
    console.log(
      `      · le libellé « ${name} » est daté ch. ${revealed.revealedIn} ` +
        `alors que la source l’écrit dès le ${from}`,
    )
  }

  if (await alreadyJoined(sql, work, provisional.id, revealed.id)) {
    console.log('      = déjà rejoints')
    return
  }

  console.log(`      + identité datée ch. ${from}, les deux nœuds restent lisibles`)
  if (dryRun) return
  await join(sql, work, provisional.id, revealed.id, from)
  bump('identités')
}

/** Le premier nœud accepté portant l'une de ces graphies. */
async function entityByLabels(
  sql: postgres.Sql,
  work: Work,
  labels: string[],
): Promise<{
  id: string
  label: string
  nodeType: string
  firstSeen: number
  revealedIn: number | null
} | null> {
  for (const label of labels) {
    const [row] = await sql<
      Array<{
        entity_id: string
        label: string
        node_type: string
        first_seen_chapter: number
        revealed_in_chapter: number | null
      }>
    >`
      SELECT l.entity_id, l.label, en.node_type, en.first_seen_chapter,
             l.revealed_in_chapter
        FROM entity_labels l
        JOIN entities en ON en.id = l.entity_id
       WHERE l.user_id = ${work.user_id}
         AND l.normalized_label = ${normalizeText(label)}
         AND en.review_status = 'accepted'
       ORDER BY l.precedence DESC
       LIMIT 1
    `
    if (row) {
      return {
        id: row.entity_id,
        label: row.label,
        nodeType: row.node_type,
        firstSeen: row.first_seen_chapter,
        revealedIn: row.revealed_in_chapter,
      }
    }
  }
  return null
}

/**
 * Le premier chapitre dont la source écrit ce nom.
 *
 * La même question que `nameRevealedLater()` pose pour refuser un nom, posée
 * ici pour en dater un — et la même réponse, sur les mêmes lignes. Un mot
 * entier : « Vivi » dans « Vivienne » n'est pas une occurrence du nom, et une
 * date fausse est le seul défaut que ce script puisse introduire.
 */
async function firstChapterNaming(
  sql: postgres.Sql,
  work: Work,
  name: string,
): Promise<number | null> {
  const needle = normalizeText(name)
  if (needle.length < 3) return null

  const pattern = `\\y${needle.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}\\y`

  const [row] = await sql<Array<{ first: number | null }>>`
    SELECT min(c.number)::int AS first
      FROM text_blocks t
      JOIN chapters c ON c.id = t.chapter_id
     WHERE c.work_id = ${work.id} AND c.user_id = ${work.user_id}
       AND t.normalized_text ~ ${pattern}
  `
  return row?.first ?? null
}

async function hasLabel(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  label: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM entity_labels
     WHERE user_id = ${work.user_id} AND entity_id = ${entityId}
       AND normalized_label = ${normalizeText(label)}
  `
  return row !== undefined && row.n !== '0'
}

/**
 * Le nom, à sa date et à son rang.
 *
 * Précédence 100 — celle d'un vrai nom — plutôt qu'un rang calculé sous
 * l'existant : c'est toute la différence entre « il porte aussi ce nom » et
 * « il s'appelle ainsi à partir d'ici ». La désignation provisoire garde la
 * sienne et reste donc affichée aux chapitres qui précèdent.
 */
async function addTrueName(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  label: string,
  chapter: number,
): Promise<void> {
  await sql`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
    VALUES
      (${entityId}, ${work.user_id}, ${label}, ${normalizeText(label)},
       'true_name', ${chapter}, 100)
  `
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, 'name_revealed', 'entity', ${entityId},
            ${sql.json({ label, revealedInChapter: chapter, note: NOTE })})
  `
}

async function alreadyJoined(
  sql: postgres.Sql,
  work: Work,
  a: string,
  b: string,
): Promise<boolean> {
  const [row] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM assertions
     WHERE user_id = ${work.user_id}
       AND predicate = 'same_as' AND review_status = 'accepted'
       AND ((subject_entity_id = ${a} AND object_entity_id = ${b})
         OR (subject_entity_id = ${b} AND object_entity_id = ${a}))
  `
  return row !== undefined && row.n !== '0'
}

/**
 * Deux nœuds rejoints, et tous les deux gardés.
 *
 * Une écriture, là où `fold()` en fait deux. Ce dernier rejette la copie parce
 * qu'un doublon ne doit jamais se voir ; ici le nœud provisoire doit se voir,
 * sous le chapitre qui révèle, et c'est le `same_as` daté qui s'en charge tout
 * seul — l'union-find de la projection ne le lit qu'à partir de sa frontière.
 *
 * Écrit comme la parole du lecteur : `user_validated`, `locked`, donc à l'abri
 * d'une proposition ultérieure de l'IA, et lisible sur les deux fiches comme un
 * fait que « ce fait est faux » défait.
 */
async function join(
  sql: postgres.Sql,
  work: Work,
  provisional: string,
  revealed: string,
  chapter: number,
): Promise<void> {
  await sql`
    INSERT INTO assertions (
      work_id, user_id, subject_entity_id, predicate, object_entity_id,
      knowledge_from_chapter, observed_in_chapter, confidence,
      epistemic_status, review_status, proposed_by, locked
    ) VALUES (
      ${work.id}, ${work.user_id}, ${provisional}, 'same_as', ${revealed},
      ${chapter}, ${chapter}, 1,
      'user_validated', 'accepted', 'user', true
    )
  `
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, 'entities_joined', 'entity', ${revealed},
            ${sql.json({ provisional, chapter, note: NOTE })})
  `
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}
