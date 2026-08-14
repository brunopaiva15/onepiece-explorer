/**
 * La relecture du chapitre 1 : apparaître n'est pas être nommé.
 *
 *   pnpm repair:chapitre-1 -- --dry-run     # dit tout, n'écrit rien
 *   pnpm repair:chapitre-1                  # applique
 *   TEST_DB=1 pnpm repair:chapitre-1        # base de test
 *
 * Le chapitre 1 montre sept personnes et en nomme cinq. Le graphe en nommait
 * six et en oubliait une, parce que la publication avait confondu deux dates
 * que rien n'obligeait à confondre : celle où un personnage entre dans la case,
 * et celle où le lecteur apprend comment il s'appelle. Le modèle de données les
 * distingue depuis le premier jour — `entities.first_seen_chapter` d'un côté,
 * `entity_labels.revealed_in_chapter` de l'autre — et personne ne s'en était
 * servi ici, si bien qu'un nom arrivait avec le corps qui le porte.
 *
 * Quatre cas, et ils ne sont pas de même nature :
 *
 *   1. Le gros pirate qui mange une cuisse de viande et le grand pirate aux
 *      cheveux noirs sont là au chapitre 1, dessinés, sans une réplique qui les
 *      nomme. Leurs noms — Lucky Roux, Benn Beckman — sont donnés dans le SBS
 *      du tome 5, que le lecteur atteint au chapitre 42. La date existe donc,
 *      mais la source n'est pas la page : c'est ce que `reveal_source` écrit.
 *
 *   2. Yasopp est dans la même case et n'était pas dans le graphe du tout. Son
 *      identité et son appartenance à l'équipage sont établies au chapitre 25,
 *      dans le texte cette fois. Il entre donc au 1 et se nomme au 25.
 *
 *   3. Le maire de Fuchsia apparaît au chapitre 1 et son nom vient d'un
 *      databook, que cette bibliothèque ne rattache à aucun chapitre. Il n'y a
 *      pas de date à écrire, et lui en inventer une serait affirmer une
 *      révélation qu'aucun chapitre ne contient. Son nom passe donc hors
 *      chronologie — voir la migration 0027.
 *
 *   4. Makino, Shanks, Higuma, Luffy et Gold Roger sont nommés dans le chapitre
 *      lui-même. Rien à corriger : ils sont ici pour être *vérifiés*, y compris
 *      contre la faute inverse — « Gol D. Roger » est la forme que le lecteur
 *      lira bien plus tard, et le chapitre 1 dit « Gold Roger ».
 *
 * Deux scènes suivent des noms. Celle qui disait « Beckman neutralise seul la
 * bande d'Higuma » le disait deux fois de travers : elle nomme un personnage
 * anonyme à ce stade, et elle attribue à un seul homme un travail qu'ils sont
 * deux à faire — le premier bandit est abattu d'un coup de pistolet par celui
 * qu'on appellera Lucky Roux. Le graphe n'avait pas du tout cette scène-là.
 *
 * Rien n'est renommé au sens de la base. L'entité canonique ne bouge pas, ses
 * liens continuent de pointer vers elle, et c'est le texte affiché qui dépend
 * du chapitre — un libellé descriptif au 1, le nom à sa date. Reculer le
 * curseur reste possible et redonne exactement ce que le lecteur savait.
 *
 * Rejouable. Chaque opération vérifie d'abord si elle a déjà eu lieu.
 *
 * `--conditions=react-server` dans le script pnpm n'est pas décoratif : les
 * modules qui écrivent de la connaissance sont marqués `server-only`, et ce
 * drapeau est ce qui résout le marqueur hors de Next.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { normalizeText } from '../src/domains/knowledge/normalize.ts'
import { classifyOccurrence } from '../src/domains/knowledge/occurrence.ts'

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

const CHAPTER = 1

/** Le SBS du tome 5, que le lecteur ouvre après le chapitre 42. */
const SBS_CHAPTER = 42
const SBS_SOURCE = 'SBS du tome 5'

/**
 * Une identité, dans l'ordre où le lecteur la reçoit.
 *
 * Les champs portent les noms de la question à laquelle ils répondent, et ils
 * existent déjà dans le schéma : `firstAppearance` va sur l'entité, `before` et
 * `reveal` sont deux libellés du même nœud. Il n'y a pas de renommage
 * là-dedans, seulement deux dates au lieu d'une.
 */
interface Identity {
  /** Le nom canonique. Ce que la base porte, jamais ce que la fiche affiche. */
  canonical: string
  /** Les autres orthographes sous lesquelles le nœud peut être rangé. */
  spellings: readonly string[]
  /** Ce que le lecteur voit tant que personne n'a donné le nom. */
  before: string
  /**
   * Où le nom est donné, et quand.
   *
   * `chapter: null` veut dire « aucun chapitre ne le donne » — pas « on ne sait
   * pas ». La contrainte de la migration 0027 exige alors une source, parce
   * qu'un nom que rien n'explique n'est pas une donnée, c'est un trou.
   */
  reveal: { chapter: number | null; source: string | null }
  /** Le chapitre où on le voit. Le corps, pas le nom. */
  firstAppearance: number
  /**
   * À partir de quand le lecteur peut lire son appartenance à l'équipage.
   *
   * Pas la même réponse pour tous, et c'est le fond de cette relecture : les
   * deux pirates du chapitre 1 sont debout au milieu de l'équipage, à côté de
   * Shanks, dans une taverne qu'il occupe entièrement — leur appartenance est
   * sur la page même si leur nom n'y est pas. Yasopp est dans la même case et
   * son appartenance n'est établie qu'au 25 ; l'écrire au 1 ferait dire à la
   * fiche « un pirate au bandeau appartient à l'équipage du Roux » avec, pour
   * seule preuve, un chapitre qu'on n'a pas encore lu.
   */
  crewFrom: number | null
  /** Créé s'il manque : Yasopp n'était pas dans le graphe. */
  createIfMissing: boolean
}

const IDENTITIES: readonly Identity[] = [
  {
    canonical: 'Lucky Roux',
    spellings: ['Lucky Roo', 'Lucky Roux', 'Lucky Rou'],
    before: 'Pirate corpulent mangeant de la viande',
    reveal: { chapter: SBS_CHAPTER, source: SBS_SOURCE },
    firstAppearance: CHAPTER,
    crewFrom: CHAPTER,
    createIfMissing: true,
  },
  {
    canonical: 'Benn Beckman',
    spellings: ['Ben Beckman', 'Benn Beckmann', 'Ben Beckmann', 'Beckman'],
    before: 'Pirate aux cheveux noirs de l’équipage de Shanks',
    reveal: { chapter: SBS_CHAPTER, source: SBS_SOURCE },
    firstAppearance: CHAPTER,
    crewFrom: CHAPTER,
    createIfMissing: true,
  },
  {
    canonical: 'Yasopp',
    spellings: ['Yassop', 'Yasop'],
    before: 'Pirate au bandeau de l’équipage de Shanks',
    // Le chapitre lui-même, donc pas de source à citer : c'est la page.
    reveal: { chapter: 25, source: null },
    firstAppearance: CHAPTER,
    crewFrom: 25,
    createIfMissing: true,
  },
  {
    canonical: 'Woop Slap',
    spellings: ['Hoop Slap', 'Woop Slap', 'Woop-Slap'],
    before: 'Maire du village de Fuchsia',
    reveal: {
      chapter: null,
      source: 'databook officiel — hors de la chronologie des chapitres',
    },
    firstAppearance: CHAPTER,
    crewFrom: null,
    createIfMissing: false,
  },
]

/**
 * Les cinq que le chapitre nomme lui-même, et la forme exacte qu'il en donne.
 *
 * Vérifiés, pas corrigés : ils sont déjà justes, et un script qui les réécrirait
 * « au cas où » ne serait pas rejouable, il serait simplement destructif. Le
 * contrôle porte sur ce qui s'*affiche* au chapitre 1 — c'est-à-dire sur le
 * libellé le mieux classé parmi ceux révélés au 1 ou avant. Un nom du futur
 * glissé sur l'un de ces nœuds sortirait ici, nommément.
 */
const NAMED_AT_ONE: readonly string[] = [
  'Makino',
  'Shanks',
  'Higuma',
  'Monkey D. Luffy',
  'Gold Roger',
]

/** Une scène du chapitre 1 qui nomme quelqu'un que le chapitre ne nomme pas. */
const SCENE_REWRITES: ReadonlyArray<{ find: string; to: string }> = [
  {
    find: 'neutralise seul la bande',
    to:
      'Un pirate aux cheveux noirs de l’équipage de Shanks neutralise presque ' +
      'toute la bande d’Higuma.',
  },
]

/**
 * La scène que le graphe n'avait pas.
 *
 * « presque toute la bande » ci-dessus n'est exact que si celle-ci existe :
 * les deux réparations tiennent ensemble, et c'est pour cela qu'elles sont dans
 * le même script plutôt que dans deux.
 */
const SCENES_ADDED: ReadonlyArray<{ summary: string; probe: string }> = [
  {
    summary:
      'Un pirate corpulent de l’équipage de Shanks abat l’un des bandits ' +
      'd’Higuma d’un coup de pistolet.',
    // Le fragment qui dit « celle-ci est déjà là », et qui doit survivre à une
    // reformulation du résumé — sans quoi une deuxième exécution en écrirait
    // une copie. Choisi dans ce que la scène a d'irremplaçable.
    probe: 'abat l’un des bandits',
  },
]

const NOTE =
  'Relecture du chapitre 1 : première apparition et révélation du nom ' +
  'distinguées, voir scripts/repair-chapitre-1.ts.'

/**
 * L'apostrophe, des deux façons dont elle est écrite.
 *
 * La prose importée porte l'apostrophe droite, celle écrite ici la
 * typographique, et un fragment qui contient « l'équipage » ne trouve rien dans
 * un résumé qui dit « l’équipage ». Les deux côtés sont ramenés à la même — en
 * JavaScript pour le fragment, en SQL pour la colonne.
 */
function straight(value: string): string {
  return value.replace(/[’']/g, "'")
}

interface Work {
  id: string
  user_id: string
}

interface Counters {
  [key: string]: number
}

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

    const [chapter] = await sql<Array<{ id: string }>>`
      SELECT id FROM chapters WHERE work_id = ${work.id} AND number = ${CHAPTER} LIMIT 1
    `
    if (!chapter) {
      console.log(`Le chapitre ${CHAPTER} n’est pas dans cette bibliothèque.`)
      return
    }

    console.log(dryRun ? '— dry-run : rien ne sera écrit —\n' : '')

    const crewId = await shanksCrew(sql, work)
    console.log(
      crewId
        ? `Équipage du Roux : ${crewId}`
        : '! Aucun équipage de Shanks dans le graphe — les appartenances seront ignorées.',
    )

    // ---- 1. Une identité, en deux dates ---------------------------------------
    console.log('\nIDENTITÉS')
    for (const identity of IDENTITIES) {
      await repairIdentity(sql, work, chapter.id, identity, crewId, bump)
    }

    // ---- 2. Les cinq que le chapitre nomme ------------------------------------
    console.log('\nNOMS DÉJÀ JUSTES (vérification)')
    for (const name of NAMED_AT_ONE) {
      await checkNamedAtOne(sql, work, name)
    }

    // ---- 3. La scène qui nommait, et celle qui manquait -----------------------
    console.log('\nSCÈNES')
    for (const rewrite of SCENE_REWRITES) {
      await rewriteScene(sql, work, rewrite, bump)
    }
    for (const scene of SCENES_ADDED) {
      await addScene(sql, work, scene, bump)
    }

    // ---- 4. Ce qui reste des noms dans la prose du chapitre -------------------
    console.log('\nNOMS DANS LA PROSE DU CHAPITRE 1')
    await scrubProse(sql, work, bump)

    console.log('\n' + (dryRun ? '[dry-run] Rien écrit. ' : '') + summarise(done))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Le groupe où sont ces pirates, retrouvé par la relation plutôt que par le nom.
 *
 * Trois tentatives, de la plus solide à la plus faible. « Le groupe que Shanks
 * dirige » reste vrai après n'importe quel renommage ; un libellé, non — et
 * celui-ci en a déjà changé une fois dans cette bibliothèque. La recherche par
 * nom est le dernier recours, et elle est bornée aux formes que la source du
 * chapitre 1 emploie.
 */
async function shanksCrew(sql: postgres.Sql, work: Work): Promise<string | null> {
  const [led] = await sql<Array<{ id: string }>>`
    SELECT a.object_entity_id AS id
      FROM assertions a
      JOIN entity_labels l ON l.entity_id = a.subject_entity_id
      JOIN entities o ON o.id = a.object_entity_id
     WHERE a.user_id = ${work.user_id} AND a.predicate = 'leads'
       AND a.review_status = 'accepted' AND o.node_type = 'group'
       AND l.label IN ('Shanks', 'Le Roux', 'Shanks le Roux')
     LIMIT 1
  `
  if (led) return led.id

  const [joined] = await sql<Array<{ id: string }>>`
    SELECT a.object_entity_id AS id
      FROM assertions a
      JOIN entity_labels l ON l.entity_id = a.subject_entity_id
      JOIN entities o ON o.id = a.object_entity_id
     WHERE a.user_id = ${work.user_id} AND a.predicate = 'member_of'
       AND a.review_status = 'accepted' AND o.node_type = 'group'
       AND l.label IN ('Lucky Roux', 'Lucky Roo', 'Benn Beckman', 'Ben Beckman')
     LIMIT 1
  `
  if (joined) return joined.id

  const [named] = await sql<Array<{ id: string }>>`
    SELECT e.id
      FROM entities e
      JOIN entity_labels l ON l.entity_id = e.id
     WHERE e.user_id = ${work.user_id} AND e.node_type = 'group'
       AND l.label IN ('Équipage du Roux', 'Équipage de Shanks',
                       'Équipage du Roux (pirates)', 'Pirates du Roux')
     LIMIT 1
  `
  return named?.id ?? null
}

/**
 * Tous les nœuds qui sont cette personne, y compris ceux qui portent son nom
 * sans le savoir.
 *
 * Une entité n'est pas une personne : une personne est une *composante*, celle
 * que les relations `same_as` referment. La fiche le sait — elle lit la
 * composante entière et affiche le meilleur libellé qu'elle y trouve, ce qui
 * est précisément ce qui fait qu'un personnage fusionné s'affiche sous son vrai
 * nom plutôt que sous la silhouette qui a trié première.
 *
 * Le revers est ce qui a été trouvé sur la fiche de Beckman : la bibliothèque
 * le range en deux nœuds, une correction qui n'en traite qu'un laisse le nom
 * du futur sur l'autre, et la fiche du chapitre 1 le réaffiche — exactement
 * comme avant la correction, à un `LIMIT 1` près. Corriger un nœud n'est donc
 * pas corriger une identité ; c'est la composante qu'il faut prendre.
 *
 * Récursif, et sans borne de chapitre. Le CTE est ce que `projection.ts` évite
 * délibérément, pour une raison qui ne vaut pas ici : là-bas il faudrait
 * redériver le prédicat de frontière à l'intérieur du CTE, au risque qu'il
 * diverge de la politique RLS. Ce script n'a pas de frontière — il répare la
 * donnée, pas une lecture — et une identité datée du chapitre 300 rend le nom
 * tout aussi prématuré au chapitre 1 sur le nœud qui le porte.
 */
async function identityComponent(
  sql: postgres.Sql,
  work: Work,
  seeds: readonly string[],
): Promise<string[]> {
  if (seeds.length === 0) return []
  const rows = await sql<Array<{ id: string }>>`
    WITH RECURSIVE component(id) AS (
      SELECT id FROM entities WHERE id IN ${sql([...seeds])}
      UNION
      SELECT CASE WHEN a.subject_entity_id = c.id
                  THEN a.object_entity_id ELSE a.subject_entity_id END
        FROM assertions a
        JOIN component c
          ON c.id IN (a.subject_entity_id, a.object_entity_id)
       WHERE a.user_id = ${work.user_id}
         AND a.predicate = 'same_as'
         AND a.review_status = 'accepted'
         AND a.object_entity_id IS NOT NULL
    )
    SELECT id FROM component ORDER BY id
  `
  return rows.map((row) => row.id)
}

/**
 * Une identité remise dans l'ordre où le lecteur la reçoit.
 *
 * Toutes les écritures sont conditionnelles et se relisent avant d'écrire, ce
 * qui rend le script rejouable — et ce qui permet de le lancer en `--dry-run`
 * pour lire le diagnostic sans rien risquer.
 *
 * Le nom est redaté sur *chaque* nœud de la composante ; la désignation
 * descriptive, elle, n'est posée qu'une fois, sur le nœud de plus petit
 * identifiant. Deux fois, elle s'afficherait deux fois dans « Noms connus » dès
 * que la fusion est visible, et la fusion l'est presque toujours au même
 * chapitre que les nœuds. Quand elle ne l'est pas, l'autre moitié se lit
 * « entité sans nom révélé » jusqu'à ce qu'elle le devienne — ce qui est exact
 * plutôt que commode : à ce chapitre-là, le lecteur n'a effectivement aucun nom
 * pour cette silhouette.
 */
async function repairIdentity(
  sql: postgres.Sql,
  work: Work,
  chapterId: string,
  identity: Identity,
  crewId: string | null,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const spellings = [identity.canonical, ...identity.spellings]

  const named = await sql<Array<{ id: string }>>`
    SELECT DISTINCT e.id
      FROM entities e
      JOIN entity_labels l ON l.entity_id = e.id
     WHERE e.user_id = ${work.user_id} AND e.work_id = ${work.id}
       AND e.node_type = 'character' AND e.review_status = 'accepted'
       AND l.label IN ${sql(spellings)}
  `

  let members = await identityComponent(
    sql,
    work,
    named.map((row) => row.id),
  )

  if (members.length === 0) {
    if (!identity.createIfMissing) {
      console.log(`  ! « ${identity.canonical} » introuvable`)
      return
    }
    console.log(
      `  → « ${identity.canonical} » absent du graphe : créé au ch${identity.firstAppearance}`,
    )
    if (dryRun) {
      // Créé seulement en écriture : la suite n'a pas de nœud où se poser, et
      // le dry-run a déjà dit ce qu'il ferait.
      console.log('      (dry-run : le reste de cette identité suivra la création)')
      return
    }
    const [created] = await sql<Array<{ id: string }>>`
      INSERT INTO entities (work_id, user_id, node_type, first_seen_chapter, review_status)
      VALUES (${work.id}, ${work.user_id}, 'character',
              ${identity.firstAppearance}, 'accepted')
      RETURNING id
    `
    await sql`
      INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
      VALUES (${work.user_id}, 'entity_created', 'entity', ${created!.id},
              ${sql.json({ label: identity.canonical, chapter: identity.firstAppearance, note: NOTE })})
    `
    members = [created!.id]
    bump('entités')
  } else if (members.length > 1) {
    console.log(`  · « ${identity.canonical} » : ${members.length} nœuds joints par une identité`)
  }

  /*
   * L'entrée en scène, ramenée au chapitre où on le voit — sur toute la
   * composante, parce qu'une personne n'entre pas en scène deux fois.
   *
   * C'est l'écriture qui répare le symptôme visible : la page « Ce qu'apporte le
   * chapitre N » liste les entités dont c'est la première apparition, et un
   * pirate dessiné au chapitre 1 y figurait quarante et un chapitres trop tard.
   * Le libellé, lui, ne bouge pas d'un cran — c'est tout l'intérêt de les avoir
   * séparés.
   */
  const late = await sql<Array<{ id: string; first_seen_chapter: number }>>`
    SELECT id, first_seen_chapter FROM entities
     WHERE id IN ${sql(members)} AND first_seen_chapter <> ${identity.firstAppearance}
  `
  for (const row of late) {
    console.log(
      `  → « ${identity.canonical} » entre en scène : ` +
        `ch${row.first_seen_chapter} → ch${identity.firstAppearance}`,
    )
    if (!dryRun) {
      await sql`
        UPDATE entities SET first_seen_chapter = ${identity.firstAppearance}
         WHERE id = ${row.id}
      `
    }
    bump('apparitions')
  }

  /*
   * Le nom d'abord, sur tous les nœuds : c'est lui qui rend la composante
   * anonyme, et la désignation ci-dessous n'a de sens qu'une fois qu'elle l'est.
   *
   * Écrit au plus une fois pour toute la composante, et seulement si personne
   * ne le porte déjà. La fiche lit la composante entière : un nom posé sur
   * chaque moitié se lirait deux fois dans « Noms connus » au chapitre où il est
   * révélé — ce qui est précisément ce que la première version de cette boucle a
   * produit, et ce que son dry-run a montré.
   */
  const [carried] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM entity_labels
     WHERE entity_id IN ${sql(members)} AND label = ${identity.canonical}
  `
  const alreadyNamed = carried !== undefined && carried.n !== '0'

  for (const member of members) {
    await ensureLabel(sql, work, member, {
      label: identity.canonical,
      kind: 'true_name',
      precedence: 100,
      chapter: identity.reveal.chapter,
      source: identity.reveal.source,
      existingOnly: alreadyNamed || member !== members[0],
    })
    await redateSpellings(sql, member, identity)
    await followPortraits(sql, work, member, identity, spellings, bump)
  }

  await ensureLabel(sql, work, members[0]!, {
    label: identity.before,
    kind: 'placeholder',
    precedence: 10,
    chapter: identity.firstAppearance,
    source: null,
  })

  await ensurePresence(sql, work, chapterId, members, identity)

  if (crewId && identity.crewFrom !== null) {
    await ensureMembership(sql, work, members, crewId, identity, bump)
  }
}

/**
 * Le visage suit le nom qui l'a trouvé.
 *
 * `entity_images.revealed_in_chapter` n'est pas la première apparition du
 * personnage : c'est la révélation du *libellé qui a produit la
 * correspondance* — la migration 0012 est explicite là-dessus, et c'est ce qui
 * empêche un portrait trouvé par un vrai nom d'arriver avant ce nom. Déplacer
 * le libellé sans déplacer l'image casse ce lien en silence : la fiche du
 * chapitre 1 affichait « Pirate corpulent mangeant de la viande » au-dessus
 * d'une illustration que seul « Lucky Roux » avait su aller chercher.
 *
 * Quand le nom n'a aucun chapitre, il n'y a pas de date à donner à l'image et
 * la colonne n'accepte pas de vide. La ligne est alors supprimée, et c'est le
 * seul endroit où ce script supprime quelque chose : une illustration n'est pas
 * de la connaissance — la migration 0012 les sépare exprès, aucune preuve n'en
 * cite —, elle est refabricable par `pnpm images:enrich`, et l'enrichissement
 * ne la retrouvera plus par ce nom puisqu'il ignore désormais les libellés hors
 * chronologie. Le retrait est tracé.
 */
async function followPortraits(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  identity: Identity,
  spellings: readonly string[],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const rows = await sql<
    Array<{ id: string; matched_label: string; revealed_in_chapter: number }>
  >`
    SELECT id, matched_label, revealed_in_chapter FROM entity_images
     WHERE user_id = ${work.user_id} AND entity_id = ${entityId}
       AND matched_label IN ${sql([...spellings])}
  `

  for (const row of rows) {
    if (identity.reveal.chapter === null) {
      console.log(
        `      − portrait rapproché par « ${row.matched_label} » retiré ` +
          '(ce nom n’a aucun chapitre où le montrer)',
      )
      if (dryRun) continue
      await sql`DELETE FROM entity_images WHERE id = ${row.id}`
      await sql`
        INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
        VALUES (${work.user_id}, 'entity_image_removed', 'entity', ${entityId},
                ${sql.json({ matchedLabel: row.matched_label, note: NOTE })})
      `
      bump('portraits')
      continue
    }
    if (row.revealed_in_chapter === identity.reveal.chapter) continue

    console.log(
      `      → portrait rapproché par « ${row.matched_label} » : ` +
        `ch${row.revealed_in_chapter} → ch${identity.reveal.chapter}`,
    )
    if (dryRun) continue
    await sql`
      UPDATE entity_images SET revealed_in_chapter = ${identity.reveal.chapter}
       WHERE id = ${row.id}
    `
    bump('portraits')
  }
}

/**
 * Un libellé, à sa date et avec sa provenance.
 *
 * Écrit s'il manque, redaté s'il est là et faux, laissé tel quel s'il est déjà
 * juste — dans cet ordre, et sans jamais en supprimer un. Un nom qu'on retire
 * de la chronologie reste dans la table : la recherche interne, une fusion, un
 * renommage futur en ont besoin, et c'est la frontière qui décide de l'afficher
 * ou non, pas la présence de la ligne.
 */
async function ensureLabel(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  wanted: {
    label: string
    kind: string
    precedence: number
    chapter: number | null
    source: string | null
    /** Redater ce libellé s'il est là, mais ne pas l'écrire s'il ne l'est pas. */
    existingOnly?: boolean
  },
): Promise<void> {
  const held = await sql<
    Array<{
      id: string
      label: string
      revealed_in_chapter: number | null
      reveal_source: string | null
    }>
  >`
    SELECT id, label, revealed_in_chapter, reveal_source
      FROM entity_labels
     WHERE entity_id = ${entityId} AND label = ${wanted.label}
  `

  if (held.length === 0) {
    if (wanted.existingOnly) return
    console.log(`      + « ${wanted.label} » ${at(wanted.chapter, wanted.source)}`)
    if (dryRun) return
    await sql`
      INSERT INTO entity_labels
        (entity_id, user_id, label, normalized_label, kind,
         revealed_in_chapter, reveal_source, precedence)
      VALUES (${entityId}, ${work.user_id}, ${wanted.label},
              ${normalizeText(wanted.label)}, ${wanted.kind}::label_kind,
              ${wanted.chapter}, ${wanted.source}, ${wanted.precedence})
    `
    return
  }

  for (const row of held) {
    const dated = row.revealed_in_chapter === wanted.chapter
    const sourced = (row.reveal_source ?? null) === wanted.source
    if (dated && sourced) {
      console.log(`      = « ${row.label} » déjà ${at(wanted.chapter, wanted.source)}`)
      continue
    }
    console.log(
      `      → « ${row.label} » ${at(row.revealed_in_chapter, row.reveal_source)} ` +
        `→ ${at(wanted.chapter, wanted.source)}`,
    )
    if (dryRun) continue
    await sql`
      UPDATE entity_labels
         SET revealed_in_chapter = ${wanted.chapter},
             reveal_source = ${wanted.source},
             kind = ${wanted.kind}::label_kind,
             precedence = ${wanted.precedence}
       WHERE id = ${row.id}
    `
  }
}

/**
 * Les autres orthographes du même nom, redatées et pas autre chose.
 *
 * Elles doivent bouger : laisser « Ben Beckman » au chapitre 1 rendrait toute
 * la correction inutile, le nom s'afficherait simplement sous son autre forme.
 * Mais elles ne doivent bouger *que* de date. La publication range la graphie
 * de la source à une précédence sous toutes les autres, exprès, pour qu'un
 * catalogue anglais retrouve le personnage sans que la fiche l'appelle ainsi ;
 * les promouvoir en « vrai nom » ferait de « Lucky Roo » un candidat à
 * l'affichage à égalité avec « Lucky Roux », et laisserait un tri décider du
 * nom d'un personnage.
 */
async function redateSpellings(
  sql: postgres.Sql,
  entityId: string,
  identity: Identity,
): Promise<void> {
  if (identity.spellings.length === 0) return

  const rows = await sql<
    Array<{ id: string; label: string; revealed_in_chapter: number | null }>
  >`
    SELECT id, label, revealed_in_chapter FROM entity_labels
     WHERE entity_id = ${entityId} AND label IN ${sql([...identity.spellings])}
       AND (revealed_in_chapter IS DISTINCT FROM ${identity.reveal.chapter})
  `

  for (const row of rows) {
    console.log(
      `      → « ${row.label} » (autre graphie) ${at(row.revealed_in_chapter, null)} ` +
        `→ ${at(identity.reveal.chapter, identity.reveal.source)}`,
    )
    if (dryRun) continue
    await sql`
      UPDATE entity_labels
         SET revealed_in_chapter = ${identity.reveal.chapter},
             reveal_source = ${identity.reveal.source}
       WHERE id = ${row.id}
    `
  }
}

/** « au ch42 · SBS du tome 5 », « hors chronologie · databook ». */
function at(chapter: number | null, source: string | null): string {
  const when = chapter === null ? 'hors chronologie' : `ch${chapter}`
  return source ? `${when} · ${source}` : when
}

/**
 * Vu, et non pas seulement nommé.
 *
 * `stated` dit que la réponse a été donnée plutôt que déduite du support de la
 * preuve — voir la migration 0025. Ici elle est donnée à la main, ce qui est le
 * même geste que pour Zoro au chapitre 2, dans l'autre sens : lui est nommé
 * sans être vu, ceux-ci sont vus sans être nommés.
 */
async function ensurePresence(
  sql: postgres.Sql,
  work: Work,
  chapterId: string,
  members: readonly string[],
  identity: Identity,
): Promise<void> {
  // Lue sur toute la composante, écrite sur un seul nœud. Une présence déjà
  // tranchée sur l'autre moitié est la même réponse, et l'ajouter deux fois
  // ferait entrer la même personne deux fois dans le fil du chapitre.
  const [existing] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM occurrences
     WHERE entity_id IN ${sql([...members])} AND chapter_id = ${chapterId}
       AND stated AND kind = 'appearance'
  `
  if (existing && existing.n !== '0') {
    console.log(`      = présence au ch${identity.firstAppearance} déjà tranchée`)
    return
  }
  console.log(`      + vu au ch${identity.firstAppearance}`)
  if (dryRun) return
  await sql`
    INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated, chapter_number)
    VALUES (${members[0]!}, ${work.user_id}, ${chapterId}, 'appearance', true,
            ${identity.firstAppearance})
  `
}

/**
 * L'appartenance à l'équipage, à la date où le lecteur peut la lire.
 *
 * Écrite comme la parole du lecteur — `user`, verrouillée, donc à l'abri d'une
 * proposition ultérieure de l'IA — parce que c'est ce qu'elle est : une lecture
 * de la page faite à la main, pas une extraction. Sans preuve citée, et c'est
 * volontaire : la preuve serait une case, le graphe n'ancre que du texte, et
 * inventer un extrait pour satisfaire la forme serait pire que de n'en avoir
 * aucun.
 */
async function ensureMembership(
  sql: postgres.Sql,
  work: Work,
  members: readonly string[],
  crewId: string,
  identity: Identity,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const from = identity.crewFrom!

  // Cherchée sur toute la composante : une appartenance écrite sur l'autre
  // moitié est déjà celle de cette personne, et en ajouter une seconde ferait
  // lire « membre de l'équipage du Roux » deux fois sur la même fiche.
  const [existing] = await sql<Array<{ knowledge_from_chapter: number }>>`
    SELECT knowledge_from_chapter FROM assertions
     WHERE user_id = ${work.user_id} AND predicate = 'member_of'
       AND subject_entity_id IN ${sql([...members])} AND object_entity_id = ${crewId}
       AND review_status = 'accepted'
     ORDER BY knowledge_from_chapter
     LIMIT 1
  `

  if (existing && existing.knowledge_from_chapter <= from) {
    console.log(`      = membre depuis le ch${existing.knowledge_from_chapter}`)
    return
  }
  if (existing) {
    /*
     * Une appartenance déjà écrite, mais trop tard.
     *
     * Non modifiée : `assertions` est append-only et le trigger refuse tout
     * sauf le statut de revue. La ligne juste est donc ajoutée à côté, et
     * l'ancienne rendue invisible en la rejetant — ce qui est réversible d'une
     * seule instruction, contrairement à une suppression.
     */
    console.log(
      `      → membre au ch${existing.knowledge_from_chapter} → ch${from} ` +
        '(l’ancienne ligne est rejetée, pas supprimée)',
    )
  } else {
    console.log(`      + membre de l’équipage au ch${from}`)
  }
  if (dryRun) return

  await sql`
    UPDATE assertions SET review_status = 'superseded'
     WHERE user_id = ${work.user_id} AND predicate = 'member_of'
       AND subject_entity_id IN ${sql([...members])} AND object_entity_id = ${crewId}
       AND review_status = 'accepted' AND knowledge_from_chapter > ${from}
  `
  await sql`
    INSERT INTO assertions (
      work_id, user_id, subject_entity_id, predicate, object_entity_id,
      knowledge_from_chapter, observed_in_chapter, confidence,
      epistemic_status, review_status, proposed_by, locked
    ) VALUES (
      ${work.id}, ${work.user_id}, ${members[0]!}, 'member_of', ${crewId},
      ${from}, ${from}, 1, 'user_validated', 'accepted', 'user', true
    )
  `
  bump('appartenances')
}

/**
 * Ce que la fiche affiche au chapitre 1, comparé à ce qu'elle devrait afficher.
 *
 * La règle est celle de la frontière, écrite en SQL une fois de plus : le
 * libellé le mieux classé parmi ceux révélés au chapitre 1 ou avant, pris sur
 * toute la composante d'identité comme la fiche le fait. Reproduite ici plutôt
 * qu'appelée, parce qu'un script de réparation qui passerait par le code
 * applicatif vérifierait que le code est d'accord avec lui-même.
 */
async function checkNamedAtOne(
  sql: postgres.Sql,
  work: Work,
  expected: string,
): Promise<void> {
  const [entity] = await sql<Array<{ entity_id: string }>>`
    SELECT l.entity_id
      FROM entity_labels l
      JOIN entities e ON e.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND l.label = ${expected}
       AND e.review_status = 'accepted'
     LIMIT 1
  `
  if (!entity) {
    console.log(`  ! « ${expected} » introuvable`)
    return
  }

  const members = await identityComponent(sql, work, [entity.entity_id])

  const [shown] = await sql<Array<{ label: string; revealed_in_chapter: number }>>`
    SELECT label, revealed_in_chapter FROM entity_labels
     WHERE entity_id IN ${sql(members)}
       AND revealed_in_chapter IS NOT NULL
       AND revealed_in_chapter <= ${CHAPTER}
     ORDER BY precedence DESC, revealed_in_chapter DESC
     LIMIT 1
  `

  if (!shown) {
    console.log(`  ! « ${expected} » n’a aucun nom lisible au ch${CHAPTER}`)
    return
  }
  if (shown.label === expected) {
    console.log(`  = ${expected}`)
    return
  }
  console.log(
    `  ! ch${CHAPTER} affiche « ${shown.label} » (révélé ch${shown.revealed_in_chapter}) ` +
      `au lieu de « ${expected} » — à trancher à la main, ce script ne le fait pas.`,
  )
}

/**
 * Un résumé de scène qui nomme quelqu'un que le chapitre ne nomme pas.
 *
 * Un événement porte son texte à deux endroits : la ligne `events`, que lisent
 * la chronologie et le mode récit, et son libellé d'entité, que lisent la
 * recherche et toute vue qui nomme un nœud. Réécrire l'un sans l'autre laisse
 * la bibliothèque avec deux versions de la même phrase.
 */
async function rewriteScene(
  sql: postgres.Sql,
  work: Work,
  rewrite: { find: string; to: string },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const rows = await sql<Array<{ entity_id: string; summary: string }>>`
    SELECT e.entity_id, e.summary
      FROM events e
      JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id} AND e.shown_in_chapter = ${CHAPTER}
       AND en.review_status = 'accepted'
       AND replace(e.summary, '’', chr(39)) LIKE ${'%' + straight(rewrite.find) + '%'}
  `

  if (rows.length === 0) {
    const [already] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM events
       WHERE user_id = ${work.user_id} AND summary = ${rewrite.to}
    `
    console.log(
      already && already.n !== '0'
        ? `  = « ${rewrite.find} » déjà réécrite`
        : `  ! « ${rewrite.find} » introuvable`,
    )
    return
  }
  if (rows.length > 1) {
    throw new Error(
      `ch${CHAPTER} : « ${rewrite.find} » désigne ${rows.length} scènes. ` +
        'Précisez le fragment plutôt que d’en réécrire une au hasard.',
    )
  }

  console.log(`  → ${rows[0]!.summary.slice(0, 70)}…`)
  if (dryRun) return
  await sql`UPDATE events SET summary = ${rewrite.to} WHERE entity_id = ${rows[0]!.entity_id}`
  await sql`
    UPDATE entity_labels
       SET label = ${rewrite.to.slice(0, 200)},
           normalized_label = app.normalize_text(${rewrite.to.slice(0, 200)})
     WHERE entity_id = ${rows[0]!.entity_id} AND user_id = ${work.user_id}
  `
  bump('scènes')
}

/**
 * Une scène que la publication n'avait pas écrite.
 *
 * Créée comme la publication en crée une — une entité, sa ligne `events`, son
 * libellé — pour qu'elle soit indiscernable des autres partout où elle est lue,
 * et notamment retrouvée par `findEcho` si une republication proposait la même.
 * Le type est demandé à `classifyOccurrence`, qui est la fonction que le dépôt
 * emploie déjà pour les scènes sans réponse, plutôt que tranché ici : deux
 * définitions de « c'est un combat » finiraient par diverger.
 */
async function addScene(
  sql: postgres.Sql,
  work: Work,
  scene: { summary: string; probe: string },
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const { summary } = scene
  const [existing] = await sql<Array<{ entity_id: string }>>`
    SELECT entity_id FROM events
     WHERE user_id = ${work.user_id} AND shown_in_chapter = ${CHAPTER}
       AND replace(summary, '’', chr(39)) LIKE ${'%' + straight(scene.probe) + '%'}
     LIMIT 1
  `
  if (existing) {
    console.log(`  = « ${summary.slice(0, 52)}… » déjà présente`)
    return
  }

  const nodeType = classifyOccurrence(summary)
  console.log(`  + ${summary.slice(0, 66)}… (${nodeType})`)
  if (dryRun) return

  const [entity] = await sql<Array<{ id: string }>>`
    INSERT INTO entities (work_id, user_id, node_type, first_seen_chapter, review_status)
    VALUES (${work.id}, ${work.user_id}, ${nodeType}, ${CHAPTER}, 'accepted')
    RETURNING id
  `
  await sql`
    INSERT INTO events (entity_id, user_id, work_id, summary, shown_in_chapter)
    VALUES (${entity!.id}, ${work.user_id}, ${work.id}, ${summary}, ${CHAPTER})
  `
  await sql`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
    VALUES (${entity!.id}, ${work.user_id}, ${summary.slice(0, 200)},
            ${normalizeText(summary.slice(0, 200))}, 'alias', ${CHAPTER}, 10)
  `
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, 'event_created', 'entity', ${entity!.id},
            ${sql.json({ chapter: CHAPTER, summary, note: NOTE })})
  `
  bump('scènes')
}

/**
 * Le nom écrit en toutes lettres dans une phrase du chapitre 1.
 *
 * Le libellé d'un nœud est borné par sa date de révélation ; la prose d'un
 * résumé ne l'est pas. Une scène qui dit « Lucky Roux abat un bandit » révèle
 * le nom aussi sûrement qu'un libellé, et la frontière ne peut rien pour elle —
 * c'est du texte. Donc un balayage, borné au chapitre 1 comme le reste de cette
 * relecture, qui remplace chaque nom par la désignation que le lecteur a.
 *
 * Le mot entier, jamais un fragment : « Beckman » dans « Beckmann » serait un
 * demi-remplacement, et une phrase à moitié réécrite est pire que celle
 * d'origine, parce qu'elle a l'air relue.
 */
async function scrubProse(
  sql: postgres.Sql,
  work: Work,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  let touched = 0

  for (const identity of IDENTITIES) {
    // Les noms encore inconnus du lecteur au chapitre 1 — c'est-à-dire tous ceux
    // dont la révélation vient après, et ceux qu'aucun chapitre ne donne.
    if (identity.reveal.chapter !== null && identity.reveal.chapter <= CHAPTER) continue

    for (const wording of [identity.canonical, ...identity.spellings]) {
      const pattern = '\\y' + wording.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&') + '\\y'

      const events = await sql<Array<{ entity_id: string; summary: string }>>`
        SELECT entity_id, summary FROM events
         WHERE user_id = ${work.user_id} AND shown_in_chapter = ${CHAPTER}
           AND summary ~ ${pattern}
      `
      const questions = await sql<Array<{ entity_id: string; question: string }>>`
        SELECT entity_id, question FROM mysteries
         WHERE user_id = ${work.user_id} AND opened_in_chapter = ${CHAPTER}
           AND question ~ ${pattern}
      `
      if (events.length + questions.length === 0) continue

      console.log(
        `  → « ${wording} » → « ${identity.before} » : ` +
          `${events.length} scène(s), ${questions.length} question(s)`,
      )
      touched += events.length + questions.length
      if (dryRun) continue

      const swap = (text: string): string =>
        text.replace(new RegExp(`\\b${wording}\\b`, 'g'), identity.before)

      for (const row of events) {
        const next = swap(row.summary)
        await sql`UPDATE events SET summary = ${next} WHERE entity_id = ${row.entity_id}`
        await sql`
          UPDATE entity_labels
             SET label = ${next.slice(0, 200)},
                 normalized_label = app.normalize_text(${next.slice(0, 200)})
           WHERE entity_id = ${row.entity_id} AND user_id = ${work.user_id}
        `
      }
      for (const row of questions) {
        const next = swap(row.question)
        await sql`UPDATE mysteries SET question = ${next} WHERE entity_id = ${row.entity_id}`
        await sql`
          UPDATE entity_labels
             SET label = ${next.slice(0, 200)},
                 normalized_label = app.normalize_text(${next.slice(0, 200)})
           WHERE entity_id = ${row.entity_id} AND user_id = ${work.user_id}
        `
      }
    }
  }

  if (touched === 0) console.log('  = aucun nom prématuré dans la prose du chapitre 1')
  else bump('prose', touched)
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}

await main()
process.exit(0)
