/**
 * Les corrections relevées en relisant le fil des chapitres 1 à 145.
 *
 *   pnpm repair:chronologie -- --dry-run    # dit tout, n'écrit rien
 *   pnpm repair:chronologie                 # applique
 *   pnpm repair:chronologie -- --annuler    # remet les phrases comme elles étaient
 *   TEST_DB=1 pnpm repair:chronologie       # base de test
 *
 * Une relecture complète a relevé une quinzaine de défauts nommés — Usopp promu
 * capitaine, Nojiko enrôlée dans l'équipage, Crocus rangé dans l'équipage de
 * Laboon, Alvida révélée un chapitre trop tôt, le navire d'Orbit devenu
 * « Hobbit » — et une famille entière de doublons. Ce fichier les corrige, une
 * fois, sur la bibliothèque telle qu'elle est.
 *
 * --------------------------------------------------------------------------
 * Ce script est le raccourci, et le bouton « Analyser l'histoire » est la
 * réponse.
 *
 * C'est la même division que `repair:noms` et `repair:identites`. Celui-ci porte
 * une liste relevée à la main : gratuit, instantané, et exactement aussi complet
 * que cette liste — il ne trouvera jamais le seizième défaut. Le balayage de
 * `/admin/analyse`, lui, les *trouve* : il pèse toute la bibliothèque contre les
 * mêmes règles, à chaque fois qu'on le lui demande, et il continuera de le faire
 * sur les chapitres qui ne sont pas encore importés.
 *
 * Les deux se complètent. Lancer celui-ci d'abord règle les quinze connus pour
 * rien ; le balayage n'a plus qu'à chercher le reste, et un défaut déjà corrigé
 * ne se signale pas.
 *
 * Ce qui reste **hors de portée des deux** et se fait à la main sur la fiche :
 * fusionner deux nœuds — « Baggy » et « Buggy », « Vogue Merry » et « Going
 * Merry » — parce qu'une fusion réécrit ce que le lecteur savait à chaque
 * chapitre entre les deux, et que c'est le seul jugement que l'ontologie place
 * en revue humaine obligatoire. Ce script les nomme et s'arrête là.
 *
 * --------------------------------------------------------------------------
 * Deux principes, qui expliquent chaque refus de ce fichier.
 *
 * **Rien n'est supprimé.** Un doublon passe en « rejeté », une identité fausse
 * aussi : la ligne reste, datée, avec sa provenance, et cesse d'être lue par la
 * politique de frontière. C'est ce que « ce fait est faux » veut dire ici depuis
 * l'ADR 0002, et c'est réversible en une requête.
 *
 * **Rien n'est daté de mémoire.** Une entrée en scène qu'on avance, un nom qu'on
 * redate : la date vient du premier chapitre dont le *texte* écrit ce mot, pas
 * de ce que je crois savoir du manga. Une correction indatable est laissée telle
 * quelle et dit pourquoi. La seule exception est écrite en toutes lettres plus
 * bas — « Laugh Tale », dont le chapitre de révélation n'est pas dans cette
 * bibliothèque.
 *
 * Ré-exécutable : chaque correction vérifie d'abord si elle a déjà été faite.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { sameBeat } from '../src/domains/knowledge/beats.ts'
import { normalizeText } from '../src/domains/knowledge/normalize.ts'
import { scenesMatching } from '../src/domains/review/audit.ts'

const dryRun = process.argv.includes('--dry-run')
/** Remettre les phrases comme elles étaient. Voir `undoRewrites`. */
const undo = process.argv.includes('--annuler')
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

const NOTE = 'repair:chronologie — relecture des chapitres 1 à 145'

/**
 * Les phrases que le fil raconte de travers.
 *
 * Repérées par le chapitre et par des fragments que la phrase existante doit
 * tous contenir, jamais par un identifiant : deux passages du pipeline sur le
 * même chapitre écrivent deux formulations, et une correction accrochée à une
 * ligne précise raterait l'autre. Les fragments sont comparés sur le texte
 * normalisé — accents et ponctuation repliés —, donc « Bell-mère » attrape aussi
 * « Bell-mere ».
 *
 * **Les fragments doivent désigner une scène et une seule.** C'est la leçon de
 * la première exécution, et elle a coûté cher : « usopp » et « capitaine »
 * décrivaient quatre scènes du chapitre 41 — dont « Usopp suppose qu'il
 * deviendra le capitaine, mais Luffy lui rappelle qu'il occupe déjà ce rôle »,
 * qui est exactement ce que le chapitre dit — et les quatre ont été remplacées
 * par la même phrase. Un chapitre y a perdu trois scènes justes et gagné trois
 * doublons. Le script refuse maintenant d'écrire quand le compte n'est pas un,
 * et imprime les candidates pour qu'on affine.
 *
 * D'où la forme des remplacements : ils corrigent **ce qui est faux et rien
 * d'autre**. La phrase du 94 se trompe sur le propriétaire du chapeau et a
 * raison sur Nezumi ; celle du 103 se trompe sur l'équipage de Crocus et a
 * raison sur les cinquante ans d'attente. Réécrire toute la phrase autour du
 * défaut, c'est effacer ce que le chapitre disait de juste.
 *
 * `pourquoi` est ce que la relecture a constaté, et c'est ce qui rend chaque
 * ligne discutable : si la raison est fausse, la correction l'est.
 */
const PHRASES: ReadonlyArray<{
  chapitre: number
  contient: string[]
  phrase: string
  pourquoi: string
}> = [
  {
    chapitre: 41,
    contient: ['devient officiellement capitaine'],
    phrase:
      'Usopp quitte enfin sa maison en la brisant, rejoint le Vogue Merry et devient ' +
      'officiellement membre de l’équipage de Luffy, sous le regard de ses anciens ' +
      'compagnons et de Kaya.',
    pourquoi: 'Usopp ne devient pas capitaine : Luffy l’est et le reste.',
  },
  {
    chapitre: 76,
    contient: ['Nojiko rejoint l’équipage'],
    phrase:
      'Nojiko rejoint Luffy et ses compagnons et accepte de leur raconter le passé de ' +
      'Nami, à condition qu’ils quittent ensuite l’île.',
    pourquoi: 'Nojiko n’entre pas dans l’équipage : elle raconte, sous condition.',
  },
  {
    chapitre: 78,
    contient: ['l’exécute néanmoins'],
    phrase:
      'Bell-mère utilise ses 100 000 berrys pour payer le tribut de Nami et Nojiko, ' +
      'refusant de nier qu’elles sont ses filles. Comme elle ne peut plus payer son ' +
      'propre tribut, Arlong l’exécute devant elles afin de servir d’exemple au village.',
    pourquoi:
      '« Elle paie et Arlong l’exécute néanmoins » laisse croire à un caprice : elle ' +
      'meurt de n’avoir pas payé pour elle-même.',
  },
  {
    chapitre: 94,
    contient: ['récupère son chapeau'],
    phrase:
      'Nezumi tente de s’approprier les richesses d’Arlong Park mais est battu par ' +
      'l’équipage du Chapeau de paille ; Nami rend son chapeau de paille à Luffy et ' +
      'exige que Nezumi rende l’argent volé au village.',
    pourquoi: 'Le chapeau est celui de Luffy : « récupère son chapeau » inverse à qui il est.',
  },
  {
    chapitre: 103,
    contient: ['appartenait à un équipage'],
    phrase:
      'Crocus raconte que Laboon accompagnait autrefois un équipage de pirates. Avant ' +
      'd’entrer sur Grand Line, ils lui ont confié la jeune baleine en promettant de ' +
      'revenir la chercher — un retour qui n’est jamais venu depuis cinquante ans.',
    pourquoi: 'Crocus n’était pas de cet équipage : c’est Laboon qui l’accompagnait.',
  },
  {
    chapitre: 110,
    contient: ['révèlent leurs véritables identités'],
    phrase:
      'Les agents de Baroque Works Mr 9, Mr 13 et Miss Friday interceptent Mr 8 et Miss ' +
      'Wednesday en fuite, puis Mr 5 et Miss Valentine révèlent que ces deux-là sont les ' +
      'infiltrés recherchés par Baroque Works et tentent de les éliminer.',
    pourquoi:
      'Les traîtres sont Mr 8 et Miss Wednesday ; Mr 5 et Miss Valentine sont envoyés ' +
      'contre eux.',
  },
  {
    chapitre: 118,
    contient: ['sans se faire connaître'],
    phrase:
      'Croyant à une trahison, Dorry attaque Luffy. Luffy utilise ses pouvoirs pour le ' +
      'mettre hors de combat, et Dorry comprend trop tard que le jeune pirate est un ' +
      'utilisateur de Fruit du Démon.',
    pourquoi: 'Dorry comprend justement que Luffy a mangé un Fruit du Démon.',
  },
]

/** Un mot pour un autre, partout où la bibliothèque l'a écrit. */
const MOTS: ReadonlyArray<{ de: string; vers: string; pourquoi: string }> = [
  { de: 'Hobbit', vers: 'Orbit', pourquoi: 'Le navire des cuisiniers s’appelle l’Orbit.' },
]

/** Les identités qui n'auraient pas dû être écrites. */
const IDENTITES_FAUSSES: ReadonlyArray<{ entre: [string[], string[]]; pourquoi: string }> = [
  {
    entre: [['Nyaban Brothers', 'Nyaban brothers'], ['Buchi']],
    pourquoi:
      'Les Nyaban Brothers sont Buchi et Sham : le duo ne peut pas être la moitié de ' +
      'lui-même.',
  },
]

/** Les identités datées du mauvais chapitre. */
const IDENTITES_REDATEES: ReadonlyArray<{
  entre: [string[], string[]]
  chapitre: number
  pourquoi: string
}> = [
  {
    entre: [['Belle femme observée par Sanji'], ['Alvida']],
    chapitre: 98,
    pourquoi: 'C’est Baggy qui l’apprend à Luffy au 98 ; au 97 rien n’est confirmé.',
  },
]

/**
 * Les noms qui doivent passer devant, et ceux qu'ils remplacent.
 *
 * Un rang, jamais une nature : la nature dit ce qu'un nom *est* — « Zeff aux
 * Pieds Rouges » reste une épithète — et le rang dit seulement lequel s'affiche.
 */
const NOMS_PREFERES: ReadonlyArray<{
  nom: string[]
  aLaPlaceDe?: string[]
  pourquoi: string
}> = [
  {
    nom: ['Zeff aux Pieds Rouges', 'Zeff aux Pieds rouges'],
    aLaPlaceDe: ['Zeff'],
    pourquoi:
      'La flèche doit aller du nom connu vers le nom révélé : « Zeff → Zeff aux Pieds ' +
      'Rouges », et non l’inverse.',
  },
]

/**
 * Les noms datés du mauvais chapitre, et ce que le lecteur avait avant eux.
 *
 * Redater un nom sans donner à la fiche ce qu'elle porte *avant* creuse un trou :
 * l'entité existe au chapitre 106 et n'a plus rien à afficher. `avant` est donc
 * la désignation que le chapitre donne vraiment — le maire de Whisky Peak se
 * présente sous une fausse identité, et c'est celle-là que le fil doit montrer
 * jusqu'à la révélation.
 */
const NOMS_REDATES: ReadonlyArray<{
  nom: string[]
  chapitre: number
  avant?: { nom: string; chapitre: number }
  pourquoi: string
}> = [
  {
    nom: ['Igaram'],
    chapitre: 110,
    avant: { nom: 'Igarappoi, maire de Whisky Peak', chapitre: 106 },
    pourquoi:
      'Au 106 il se présente sous une fausse identité ; son vrai nom arrive au 110.',
  },
  {
    /*
     * La seule date de ce fichier qui ne vienne pas des sources, et elle est
     * assumée : « Laugh Tale » n'est pas une graphie de « Raftel », c'est une
     * révélation — le chapitre 967 apprend au lecteur ce que le nom veut dire.
     * Aucune source de cette bibliothèque ne l'écrit, donc rien ne peut la
     * dater ; la porter au 967 revient à dire « pas avant », ce qui est
     * exactement ce que la frontière doit faire d'un nom qu'on n'a pas encore lu.
     *
     * Si la bibliothèque atteint un jour ce chapitre, la date est déjà juste.
     */
    nom: ['Laugh Tale'],
    chapitre: 967,
    avant: { nom: 'Raftel', chapitre: 105 },
    pourquoi:
      'Laugh Tale est une révélation du chapitre 967 ; à Reverse Mountain, l’île ' +
      's’appelle Raftel.',
  },
]

/**
 * Les entrées en scène à ramener au chapitre qui en parle en premier.
 *
 * La date vient des sources, jamais d'ici : le tableau ne porte que des noms.
 */
const ENTREES_TARDIVES: ReadonlyArray<{ nom: string[]; pourquoi: string }> = [
  {
    nom: ['Oni Giri'],
    pourquoi: 'L’attaque est déjà nommée au chapitre 17 ; le 51 la rejoue comme nouvelle.',
  },
  {
    nom: ['Gomu Gomu no Bazooka', 'Gum Gum Bazooka'],
    pourquoi: 'L’attaque est déjà citée au chapitre 55.',
  },
]

/**
 * La scène qui manque, et la seule de ce fichier.
 *
 * Entre le 143 et le 144 il manque une information sans laquelle les deux
 * chapitres se contredisent : Hiluluk n'a plus que trois ou quatre jours, et
 * Kureha estime au 144 qu'il lui en reste deux semaines. Ce que le 143 dit et
 * que la bibliothèque n'a pas retenu, c'est que Kureha accepte de le traiter.
 *
 * Écrite comme la parole du lecteur — c'est lui qui l'a relevée — et donc sans
 * citation : une scène ajoutée à la main n'a pas de preuve dans les blocs, et
 * prétendre le contraire serait pire que de l'assumer.
 */
const SCENES_MANQUANTES: ReadonlyArray<{
  chapitre: number
  phrase: string
  pourquoi: string
}> = [
  {
    chapitre: 143,
    phrase:
      'Kureha accepte finalement de traiter Hiluluk et de tromper temporairement son ' +
      'organisme afin de prolonger sa vie d’environ trois semaines, lui donnant ' +
      'davantage de temps pour achever ses recherches.',
    pourquoi:
      'Sans elle, les trois jours du 143 et les deux semaines du 144 se contredisent.',
  },
]

/**
 * Les graphies concurrentes, nommées et jamais fusionnées.
 *
 * Rapprocher deux nœuds réécrit ce que le lecteur savait entre les deux, et
 * aucune liste écrite d'avance ne peut décider ça pour une bibliothèque qu'elle
 * n'a pas vue. Le script les cherche, dit lesquelles existent en double, et
 * s'arrête là.
 */
const GRAPHIES: ReadonlyArray<[string, string]> = [
  ['Baggy', 'Buggy'],
  ['Vogue Merry', 'Going Merry'],
  ['Octo', 'Hatchan'],
  ['Gomu Gomu no Fuusen', 'Gum Gum Balloon'],
]

/** Les chapitres où la relecture a compté des scènes racontées deux fois. */
const CHAPITRES_A_DOUBLONS = [2, 3, 4, 5, 14, 38, 41, 43, 44, 52, 136, 138]

interface Work {
  id: string
  user_id: string
}

interface Counters {
  [key: string]: number
}

const sql = postgres(url, { max: 2, onnotice: () => {} })

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => sql.end({ timeout: 5 }))

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })

  const [work] = await sql<Work[]>`SELECT id, user_id FROM works ORDER BY created_at LIMIT 1`
  if (!work) {
    console.log('Aucune œuvre dans cette base : rien à réparer.')
    return
  }

  const done: Counters = {}
  const bump = (key: string, by = 1): number => (done[key] = (done[key] ?? 0) + by)

  if (dryRun) console.log('— dry-run : rien ne sera écrit —\n')

  if (undo) {
    console.log('ANNULER LES PHRASES RÉÉCRITES PAR CE SCRIPT')
    await undoRewrites(work, bump)
    console.log(
      '\n' +
        (dryRun ? '[dry-run] Rien écrit. ' : '') +
        summarise(done) +
        '\nLes autres corrections — mot, identités, doublons — n’ont pas été touchées.',
    )
    return
  }

  if (await clobbered(work)) return

  /*
   * Une correction qui échoue ne coûte que la sienne.
   *
   * La première exécution est morte à la quatrième famille sur un déclencheur de
   * la base, en emportant les six familles suivantes — le chapitre 143 n'a
   * jamais eu sa scène manquante, et personne ne l'a su avant de lire la trace.
   * Un script qui applique une liste doit se perdre ligne par ligne, comme le
   * balayage d'identités se perd figure par figure ; le code de sortie reste 1
   * pour que le workflow le signale.
   */
  await run('PHRASES QUI DISENT AUTRE CHOSE QUE LE CHAPITRE', PHRASES, (entry) =>
    rewriteSummary(work, entry, bump),
  )
  await run('UN MOT POUR UN AUTRE', MOTS, (entry) => renameEverywhere(work, entry, bump))
  await run('IDENTITÉS À RETIRER', IDENTITES_FAUSSES, (entry) =>
    retractIdentity(work, entry, bump),
  )
  await run('IDENTITÉS À REDATER', IDENTITES_REDATEES, (entry) =>
    redateIdentity(work, entry, bump),
  )
  await run('NOMS QUI DOIVENT PASSER DEVANT', NOMS_PREFERES, (entry) =>
    preferName(work, entry, bump),
  )
  await run('NOMS DATÉS TROP TÔT', NOMS_REDATES, (entry) => redateName(work, entry, bump))
  await run('ENTRÉES EN SCÈNE TROP TARDIVES', ENTREES_TARDIVES, (entry) =>
    moveEntrance(work, entry, bump),
  )
  await run('CE QUI MANQUE', SCENES_MANQUANTES, (entry) => addScene(work, entry, bump))
  // Un seul « élément », parce que le repli est une passe et non une liste : ce
  // qu'il traite, ce sont les chapitres qu'il lit lui-même.
  await run('SCÈNES RACONTÉES DEUX FOIS', [null], () => foldDuplicates(work, bump))
  await run('DEUX GRAPHIES POUR UNE CHOSE (constat, jamais corrigé ici)', GRAPHIES, (pair) =>
    reportVariants(work, pair),
  )

  console.log(
    '\n' +
      (dryRun ? '[dry-run] Rien écrit. ' : '') +
      summarise(done) +
      (failures === 0 ? '' : ` · ${failures} correction(s) en échec`),
  )
  if (failures > 0) process.exitCode = 1
}

/**
 * Refuser de repasser sur des scènes que ce script a déjà écrasées.
 *
 * L'ordre compte plus qu'il n'en a l'air. Tant que quatre scènes du chapitre 41
 * portent la même phrase, le repli des doublons plus bas ferait exactement ce
 * qu'on lui demande — en rejeter trois — et les trois scènes qu'il rejetterait
 * sont des scènes *justes*, dont seul le texte a été détruit. La réparation
 * effacerait alors définitivement ce que l'annulation savait encore rendre.
 *
 * La détection est exacte plutôt que prudente : deux scènes d'un même chapitre
 * portant mot pour mot une phrase que le journal enregistre comme écrite par ce
 * script. Rien d'autre ne produit cette empreinte, et elle disparaît d'elle-même
 * une fois l'annulation passée — donc ce garde-fou ne devient jamais un bruit
 * qu'on apprend à ignorer.
 */
async function clobbered(work: Work): Promise<boolean> {
  const rows = await sql<Array<{ summary: string; n: number }>>`
    SELECT e.summary, count(*)::int AS n
      FROM events e
      JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id} AND e.work_id = ${work.id}
       AND en.review_status = 'accepted'
       AND EXISTS (
         SELECT 1 FROM audit_log a
          WHERE a.user_id = ${work.user_id}
            AND a.action = 'scene_rewritten'
            AND a.detail->>'note' = ${NOTE}
            AND a.detail->>'after' = e.summary)
     GROUP BY e.summary, COALESCE(e.told_in_chapter, e.shown_in_chapter, 0)
    HAVING count(*) > 1
  `

  if (rows.length === 0) return false

  console.log(
    'ARRÊT : une exécution précédente a écrasé des scènes qui n’étaient pas visées.\n',
  )
  for (const row of rows) {
    console.log(`  ${row.n} scènes portent « ${row.summary} »`)
  }
  console.log(
    '\nCes phrases identiques sont le reste d’un bug de sélection : des fragments trop\n' +
      'larges ont désigné plusieurs scènes d’un même chapitre. Continuer maintenant\n' +
      'ferait rejeter ces scènes comme des doublons, ce qui rendrait la perte définitive.\n\n' +
      '  pnpm repair:chronologie -- --annuler     puis      pnpm repair:chronologie -- --dry-run\n',
  )
  process.exitCode = 1
  return true
}

/** Combien de corrections se sont plantées sans arrêter les suivantes. */
let failures = 0
let firstFamily = true

/** Une famille, dont chaque ligne a le droit d'échouer toute seule. */
async function run<T>(
  title: string,
  entries: readonly T[],
  apply: (entry: T) => Promise<void>,
): Promise<void> {
  console.log(firstFamily ? title : `\n${title}`)
  firstFamily = false
  for (const entry of entries) {
    try {
      await apply(entry)
    } catch (error) {
      failures += 1
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      console.log(`  ✗ ${reason}`)
    }
  }
}

/** Le premier nœud accepté portant l'une de ces graphies. */
async function entityByLabels(
  work: Work,
  labels: readonly string[],
): Promise<{
  id: string
  labelId: string
  label: string
  firstSeen: number
  precedence: number
  revealedIn: number | null
} | null> {
  for (const label of labels) {
    const [row] = await sql<
      Array<{
        entity_id: string
        label_id: string
        label: string
        first_seen_chapter: number
        precedence: number
        revealed_in_chapter: number | null
      }>
    >`
      SELECT l.entity_id, l.id AS label_id, l.label, en.first_seen_chapter,
             l.precedence, l.revealed_in_chapter
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
        labelId: row.label_id,
        label: row.label,
        firstSeen: Number(row.first_seen_chapter),
        precedence: Number(row.precedence),
        revealedIn: row.revealed_in_chapter === null ? null : Number(row.revealed_in_chapter),
      }
    }
  }
  return null
}

/**
 * Le premier chapitre dont la source écrit ce nom.
 *
 * La même requête que `repair:noms`, et pour la même raison : dater une
 * révélation de mémoire, c'est écrire le spoiler que tout ce système existe pour
 * empêcher. Un mot entier — « Vivi » dans « Vivienne » n'est pas une occurrence.
 */
async function firstChapterNaming(work: Work, name: string): Promise<number | null> {
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

interface SceneRow {
  entity_id: string
  summary: string
  chapter: number
}

/** Les scènes d'un chapitre, dans l'ordre où le fil les raconte. */
async function scenesOf(work: Work, chapter: number): Promise<SceneRow[]> {
  return sql<SceneRow[]>`
    SELECT e.entity_id, e.summary,
           COALESCE(e.told_in_chapter, e.shown_in_chapter, 0)::int AS chapter
      FROM events e
      JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id} AND e.work_id = ${work.id}
       AND en.review_status = 'accepted'
       AND e.summary IS NOT NULL
       AND COALESCE(e.told_in_chapter, e.shown_in_chapter, 0) = ${chapter}
     ORDER BY e.created_at
  `
}

/**
 * Une phrase corrigée, et une seule à la fois.
 *
 * Le refus au pluriel est la garde principale de ce fichier. Une correction
 * écrite d'avance sait ce qu'elle veut dire et ne sait pas contre quelles
 * phrases elle va tomber : si ses fragments en désignent deux, elle n'a aucun
 * moyen de savoir laquelle est la fautive, et écrire les deux fabrique un
 * doublon en effaçant une scène juste. C'est arrivé — quatre scènes du chapitre
 * 41 remplacées par la même ligne — et le compte rendu ci-dessous est ce qui
 * permet d'affiner les fragments plutôt que de recommencer.
 */
async function rewriteSummary(
  work: Work,
  entry: (typeof PHRASES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const scenes = await scenesOf(work, entry.chapitre)
  const matched = scenesMatching(scenes, entry.contient)

  const already = scenes.some(
    (scene) => normalizeText(scene.summary) === normalizeText(entry.phrase),
  )

  if (matched.length === 0) {
    console.log(
      already
        ? `  = ch.${entry.chapitre} — déjà corrigée`
        : `  ! ch.${entry.chapitre} — aucune scène contenant ${entry.contient
            .map((fragment) => `« ${fragment} »`)
            .join(' et ')}`,
    )
    return
  }

  if (matched.length > 1) {
    console.log(
      `  ! ch.${entry.chapitre} — ${matched.length} scènes correspondent : rien écrit. ` +
        `Affinez les fragments pour n’en désigner qu’une.`,
    )
    for (const scene of matched) console.log(`      · « ${scene.summary} »`)
    return
  }

  const scene = matched[0]!
  console.log(`  → ch.${entry.chapitre} — ${entry.pourquoi}`)
  console.log(`      avant : « ${scene.summary} »`)
  console.log(`      après : « ${entry.phrase} »`)
  if (dryRun) return

  await writeSummary(work, scene.entity_id, scene.summary, entry.phrase)
  await log(work, 'scene_rewritten', 'entity', scene.entity_id, {
    chapter: entry.chapitre,
    before: scene.summary,
    after: entry.phrase,
  })
  bump('phrases')
}

/**
 * La phrase d'une scène, et le nom qui la recopie.
 *
 * Une scène n'a pas de titre : la publication écrit son libellé à partir de la
 * phrase, coupé à deux cents caractères. Corriger la phrase sans lui laisse la
 * fiche, la recherche et le graphe sous l'ancienne version — le fil, lui,
 * afficherait la nouvelle, ce qui est la pire des deux : deux textes pour une
 * scène, et rien pour dire lequel est à jour.
 *
 * Le libellé n'est réécrit que s'il recopiait vraiment l'ancienne phrase. Un nom
 * choisi à la main est un nom choisi à la main.
 */
async function writeSummary(
  work: Work,
  entityId: string,
  before: string,
  after: string,
): Promise<void> {
  await sql`
    UPDATE events SET summary = ${after}
     WHERE entity_id = ${entityId} AND user_id = ${work.user_id}
  `
  await sql`
    UPDATE entity_labels
       SET label = ${after.slice(0, 200)},
           normalized_label = ${normalizeText(after.slice(0, 200))}
     WHERE entity_id = ${entityId} AND user_id = ${work.user_id}
       AND normalized_label = ${normalizeText(before.slice(0, 200))}
  `
}

/**
 * Remettre les phrases comme elles étaient avant ce script.
 *
 *   pnpm repair:chronologie -- --annuler
 *
 * Existe parce que la première exécution a écrasé des scènes justes : des
 * fragments trop larges ont désigné quatre phrases là où une seule était fautive.
 * La garde est corrigée au-dessus ; ceci répare ce qu'elle n'a pas empêché.
 *
 * Ce qui rend l'annulation possible, c'est que chaque réécriture a écrit son
 * « avant » dans le journal. Le plus ancien par scène est le texte d'origine —
 * donc annuler deux fois ne fait rien de plus, et annuler après une seconde
 * exécution revient bien au point de départ et non à l'étape intermédiaire.
 *
 * N'annule que les phrases. Le mot corrigé — « Hobbit » devenu « Orbit » —,
 * l'identité retirée et le reste sont justes et restent : ce qui a mal tourné
 * est cette famille-là, et une annulation qui défait aussi le bon travail oblige
 * à tout refaire pour rien.
 */
async function undoRewrites(work: Work, bump: (key: string, by?: number) => number): Promise<void> {
  const entries = await sql<Array<{ subject_id: string; before: string; after: string }>>`
    SELECT DISTINCT ON (subject_id)
           subject_id, detail->>'before' AS before, detail->>'after' AS after
      FROM audit_log
     WHERE user_id = ${work.user_id}
       AND action = 'scene_rewritten'
       AND detail->>'note' = ${NOTE}
       AND detail->>'before' IS NOT NULL
     ORDER BY subject_id, created_at ASC
  `

  if (entries.length === 0) {
    console.log('  Aucune réécriture de ce script dans le journal : rien à annuler.')
    return
  }

  for (const entry of entries) {
    const [current] = await sql<Array<{ summary: string | null }>>`
      SELECT summary FROM events
       WHERE entity_id = ${entry.subject_id} AND user_id = ${work.user_id}
    `
    if (!current) {
      console.log(`  ! scène ${entry.subject_id} disparue : laissée`)
      continue
    }
    if (normalizeText(current.summary ?? '') === normalizeText(entry.before)) {
      console.log(`  = déjà revenue à « ${entry.before} »`)
      continue
    }

    console.log(`  ↩ « ${current.summary} »`)
    console.log(`      redevient « ${entry.before} »`)
    if (dryRun) continue

    await writeSummary(work, entry.subject_id, current.summary ?? '', entry.before)
    await log(work, 'scene_restored', 'entity', entry.subject_id, {
      restored: entry.before,
      undone: current.summary,
    })
    bump('phrases rendues')
  }
}

/**
 * Un mot corrigé partout : sur les fiches et dans la prose.
 *
 * Les deux, parce qu'un nom vit aux deux endroits. Le renommage de la fiche ne
 * touche pas les phrases déjà écrites — c'est `renameEntityLabel` qui fait les
 * deux dans l'application —, et ici la prose compte autant : c'est elle que le
 * lecteur lit sur le fil.
 */
async function renameEverywhere(
  work: Work,
  entry: (typeof MOTS)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const labels = await sql<Array<{ id: string; label: string }>>`
    SELECT l.id, l.label
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND en.work_id = ${work.id}
       AND l.label ILIKE ${`%${entry.de}%`}
  `
  const summaries = await sql<Array<{ entity_id: string; summary: string }>>`
    SELECT entity_id, summary FROM events
     WHERE user_id = ${work.user_id} AND work_id = ${work.id}
       AND summary ILIKE ${`%${entry.de}%`}
  `

  if (labels.length === 0 && summaries.length === 0) {
    console.log(`  = « ${entry.de} » nulle part : rien à corriger`)
    return
  }

  console.log(
    `  → « ${entry.de} » → « ${entry.vers} » : ${labels.length} nom(s), ` +
      `${summaries.length} phrase(s) — ${entry.pourquoi}`,
  )
  if (dryRun) return

  for (const row of labels) {
    const corrected = replaceWord(row.label, entry.de, entry.vers)
    await sql`
      UPDATE entity_labels
         SET label = ${corrected}, normalized_label = ${normalizeText(corrected)}
       WHERE id = ${row.id} AND user_id = ${work.user_id}
    `
    bump('noms corrigés')
  }

  for (const row of summaries) {
    const corrected = replaceWord(row.summary, entry.de, entry.vers)
    await sql`
      UPDATE events SET summary = ${corrected}
       WHERE entity_id = ${row.entity_id} AND user_id = ${work.user_id}
    `
    bump('phrases')
  }

  await log(work, 'term_corrected', null, null, { from: entry.de, to: entry.vers })
}

/** Le mot entier, à la casse près : « Hobbit » et jamais « Hobbits ». */
function replaceWord(text: string, from: string, to: string): string {
  const escaped = from.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
  return text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to)
}

async function identityBetween(
  work: Work,
  a: string,
  b: string,
): Promise<{ id: string; knowledge_from_chapter: number } | null> {
  const [row] = await sql<Array<{ id: string; knowledge_from_chapter: number }>>`
    SELECT id, knowledge_from_chapter FROM assertions
     WHERE user_id = ${work.user_id} AND predicate = 'same_as'
       AND review_status = 'accepted'
       AND ((subject_entity_id = ${a} AND object_entity_id = ${b})
         OR (subject_entity_id = ${b} AND object_entity_id = ${a}))
     LIMIT 1
  `
  return row ?? null
}

async function retractIdentity(
  work: Work,
  entry: (typeof IDENTITES_FAUSSES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const left = await entityByLabels(work, entry.entre[0])
  const right = await entityByLabels(work, entry.entre[1])
  if (!left || !right) {
    console.log(`  ! « ${entry.entre[0][0]} » ou « ${entry.entre[1][0]} » introuvable`)
    return
  }

  const identity = await identityBetween(work, left.id, right.id)
  if (!identity) {
    console.log(`  = « ${left.label} » et « ${right.label} » ne sont pas rapprochés`)
    return
  }

  console.log(`  → « ${left.label} » ⇎ « ${right.label} » — ${entry.pourquoi}`)
  if (dryRun) return

  await sql`
    UPDATE assertions SET review_status = 'rejected'
     WHERE id = ${identity.id} AND user_id = ${work.user_id}
  `
  await log(work, 'identity_retracted', 'assertion', identity.id, {
    between: [left.label, right.label],
  })
  bump('identités retirées')
}

async function redateIdentity(
  work: Work,
  entry: (typeof IDENTITES_REDATEES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const left = await entityByLabels(work, entry.entre[0])
  const right = await entityByLabels(work, entry.entre[1])
  if (!left || !right) {
    console.log(`  ! « ${entry.entre[0][0]} » ou « ${entry.entre[1][0]} » introuvable`)
    return
  }

  const identity = await identityBetween(work, left.id, right.id)
  if (!identity) {
    console.log(`  ! « ${left.label} » et « ${right.label} » ne sont pas rapprochés`)
    return
  }
  if (Number(identity.knowledge_from_chapter) === entry.chapitre) {
    console.log(`  = « ${left.label} » → « ${right.label} » est déjà datée du ${entry.chapitre}`)
    return
  }

  console.log(
    `  → « ${left.label} » → « ${right.label} » : ch.${identity.knowledge_from_chapter} ` +
      `devient ch.${entry.chapitre} — ${entry.pourquoi}`,
  )
  if (dryRun) return

  /*
   * Une ligne de plus, jamais une date corrigée.
   *
   * Les assertions sont en ajout seul (ADR 0002) et un déclencheur le fait
   * respecter : seuls `review_status` et `superseded_by` changent après
   * insertion. Ce script a d'abord tenté l'UPDATE et s'est fait refuser en
   * production, à mi-parcours — le déclencheur a fait exactement son travail.
   *
   * La forme correcte est celle de `reviseAssertion` : la version corrigée est
   * écrite, et l'ancienne ligne est marquée « superseded » en pointant vers la
   * neuve. Le graphe cesse de lire l'ancienne sans que le dossier perde ce qui
   * avait été affirmé.
   *
   * La preuve, elle, n'est **pas** recopiée, et c'est la seule différence avec
   * `reviseAssertion`. Là-bas la phrase lue reste la bonne et seule la
   * conclusion change ; ici c'est le contraire — la citation vient du chapitre
   * 97, et l'attacher à une révélation datée du 98 ferait apparaître une phrase
   * du 97 sous le chapitre 98 sur le fil. La ligne neuve est donc écrite comme
   * la parole du lecteur, sans citation, exactement comme le fait `repair:noms`
   * quand il rapproche deux nœuds ; l'ancienne garde sa preuve pour le dossier.
   *
   * Les deux colonnes de date ensemble : `knowledge_from_chapter` est ce que la
   * frontière lit, `observed_in_chapter` est le chapitre qui porte la preuve, et
   * les laisser diverger ferait dire à la fiche que la révélation vient d'un
   * chapitre qui ne la contient pas.
   */
  const [fresh] = await sql<Array<{ id: string }>>`
    INSERT INTO assertions (
      work_id, user_id, subject_entity_id, predicate, object_entity_id,
      knowledge_from_chapter, knowledge_until_chapter,
      story_valid_from, story_valid_until, observed_in_chapter,
      confidence, epistemic_status, review_status, proposed_by, locked,
      pipeline_version, prompt_version, run_id, proposal_fingerprint
    )
    SELECT work_id, user_id, subject_entity_id, predicate, object_entity_id,
           ${entry.chapitre}, knowledge_until_chapter,
           story_valid_from, story_valid_until, ${entry.chapitre},
           confidence, 'user_validated', 'accepted', 'user', true,
           pipeline_version, prompt_version, run_id, proposal_fingerprint
      FROM assertions
     WHERE id = ${identity.id} AND user_id = ${work.user_id}
    RETURNING id
  `
  if (!fresh) {
    console.log('      ! la version redatée n’a pas pu être écrite')
    return
  }

  await sql`
    UPDATE assertions
       SET review_status = 'superseded', superseded_by = ${fresh.id}
     WHERE id = ${identity.id} AND user_id = ${work.user_id}
  `
  await log(work, 'identity_redated', 'assertion', identity.id, {
    chapter: entry.chapitre,
    between: [left.label, right.label],
    replacedBy: fresh.id,
  })
  bump('identités redatées')
}

async function preferName(
  work: Work,
  entry: (typeof NOMS_PREFERES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const preferred = await entityByLabels(work, entry.nom)
  if (!preferred) {
    console.log(`  ! « ${entry.nom[0]} » introuvable`)
    return
  }

  if (preferred.precedence >= 100) {
    console.log(`  = « ${preferred.label} » s’affiche déjà en premier`)
    return
  }

  console.log(`  → « ${preferred.label} » passe devant — ${entry.pourquoi}`)
  if (dryRun) return

  await sql`
    UPDATE entity_labels SET precedence = 100
     WHERE id = ${preferred.labelId} AND user_id = ${work.user_id}
  `
  await log(work, 'label_promoted', 'entity', preferred.id, { label: preferred.label })
  bump('noms remis devant')

  /*
   * L'ancien nom garde sa date et son rang.
   *
   * Le rétrograder effacerait ce que le lecteur avait avant la révélation, qui
   * est précisément ce que la frontière existe pour garder : sous le chapitre
   * qui révèle, c'est encore le seul nom qu'il connaisse. Il n'est mentionné ici
   * que pour dire ce qui n'a pas bougé.
   */
  if (entry.aLaPlaceDe) {
    const previous = await entityByLabels(work, entry.aLaPlaceDe)
    if (previous && previous.id === preferred.id) {
      console.log(`      « ${previous.label} » reste, sous sa date : c’est l’avant.`)
    }
  }
}

async function redateName(
  work: Work,
  entry: (typeof NOMS_REDATES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const found = await entityByLabels(work, entry.nom)
  if (!found) {
    console.log(`  ! « ${entry.nom[0]} » introuvable`)
    return
  }

  if (found.revealedIn === entry.chapitre) {
    console.log(`  = « ${found.label} » est déjà daté du ch.${entry.chapitre}`)
  } else {
    console.log(
      `  → « ${found.label} » : ch.${found.revealedIn ?? '—'} devient ch.${entry.chapitre} ` +
        `— ${entry.pourquoi}`,
    )
    if (!dryRun) {
      await sql`
        UPDATE entity_labels SET revealed_in_chapter = ${entry.chapitre}
         WHERE id = ${found.labelId} AND user_id = ${work.user_id}
      `
      await log(work, 'label_redated', 'entity', found.id, {
        label: found.label,
        revealedInChapter: entry.chapitre,
      })
      bump('noms redatés')
    }
  }

  if (!entry.avant) return

  /*
   * Ce que la fiche porte avant la révélation.
   *
   * Sans lui, redater le vrai nom laisse l'entité sans aucun libellé visible aux
   * chapitres qui précèdent — elle existe, elle est dans le fil, et elle n'a
   * plus de nom à afficher. La désignation est écrite comme une désignation :
   * rang le plus bas, donc elle disparaît d'elle-même le jour où le vrai nom
   * devient lisible.
   */
  const [existing] = await sql<Array<{ id: string }>>`
    SELECT id FROM entity_labels
     WHERE user_id = ${work.user_id} AND entity_id = ${found.id}
       AND normalized_label = ${normalizeText(entry.avant.nom)}
     LIMIT 1
  `
  if (existing) {
    console.log(`      = « ${entry.avant.nom} » est déjà sur la fiche`)
    return
  }

  console.log(`      + « ${entry.avant.nom} », ce que le lecteur a jusqu’au ch.${entry.chapitre}`)
  if (dryRun) return

  await sql`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
    VALUES
      (${found.id}, ${work.user_id}, ${entry.avant.nom}, ${normalizeText(entry.avant.nom)},
       'placeholder', ${entry.avant.chapitre}, 10)
  `
  await log(work, 'label_added', 'entity', found.id, {
    label: entry.avant.nom,
    revealedInChapter: entry.avant.chapitre,
  })
  bump('désignations rendues')
}

async function moveEntrance(
  work: Work,
  entry: (typeof ENTREES_TARDIVES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const found = await entityByLabels(work, entry.nom)
  if (!found) {
    console.log(`  ! « ${entry.nom[0]} » introuvable`)
    return
  }

  const written = await firstChapterNaming(work, found.label)
  if (written === null) {
    console.log(`  ! « ${found.label} » n’apparaît dans aucune source : indatable, laissé tel quel`)
    return
  }
  if (written >= found.firstSeen) {
    console.log(`  = « ${found.label} » entre en scène au ch.${found.firstSeen}, et c’est juste`)
    return
  }

  console.log(
    `  → « ${found.label} » : ch.${found.firstSeen} devient ch.${written} — ${entry.pourquoi}`,
  )
  if (dryRun) return

  await sql`
    UPDATE entities SET first_seen_chapter = ${written}
     WHERE id = ${found.id} AND user_id = ${work.user_id}
  `
  await log(work, 'entrance_moved', 'entity', found.id, {
    label: found.label,
    firstSeenChapter: written,
  })
  bump('entrées avancées')
}

/**
 * Une scène de plus, écrite comme la parole du lecteur.
 *
 * Le même triplet que la publication écrit : une entité de type « event », la
 * scène elle-même, et un libellé — c'est lui que le fil affiche à côté de la
 * perle. Sans preuve, parce qu'il n'y en a pas : personne n'a cité de bloc, et
 * une citation inventée pour faire bonne figure serait le seul vrai mensonge que
 * ce fichier puisse commettre.
 */
async function addScene(
  work: Work,
  entry: (typeof SCENES_MANQUANTES)[number],
  bump: (key: string, by?: number) => number,
): Promise<void> {
  const scenes = await scenesOf(work, entry.chapitre)
  const twin = scenes.find((scene) => sameBeat(scene.summary, entry.phrase))
  if (twin) {
    console.log(`  = ch.${entry.chapitre} — déjà racontée : « ${twin.summary} »`)
    return
  }

  console.log(`  + ch.${entry.chapitre} — ${entry.pourquoi}`)
  console.log(`      « ${entry.phrase} »`)
  if (dryRun) return

  const [entity] = await sql<Array<{ id: string }>>`
    INSERT INTO entities (work_id, user_id, node_type, first_seen_chapter, review_status)
    VALUES (${work.id}, ${work.user_id}, 'event', ${entry.chapitre}, 'accepted')
    RETURNING id
  `
  if (!entity) {
    console.log('      ! création refusée')
    return
  }

  await sql`
    INSERT INTO events (entity_id, user_id, work_id, summary, is_flashback, shown_in_chapter)
    VALUES (${entity.id}, ${work.user_id}, ${work.id}, ${entry.phrase}, false, ${entry.chapitre})
  `
  await sql`
    INSERT INTO entity_labels
      (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
    VALUES
      (${entity.id}, ${work.user_id}, ${entry.phrase.slice(0, 200)},
       ${normalizeText(entry.phrase.slice(0, 200))}, 'alias', ${entry.chapitre}, 10)
  `
  await log(work, 'scene_added', 'entity', entity.id, {
    chapter: entry.chapitre,
    summary: entry.phrase,
  })
  bump('scènes ajoutées')
}

/**
 * Les scènes racontées deux fois, repliées sur la plus complète.
 *
 * `sameBeat` est la règle, partagée avec le centre de revue, avec le fil et avec
 * le bouton d'analyse : deux orthographes de « c'est la même scène » est
 * exactement comment une carte dit « copie 2 sur 2 » à propos d'une paire que le
 * fil raconte deux fois.
 *
 * Sur les chapitres relevés par la relecture, et pas sur toute la bibliothèque —
 * non par prudence sur la règle, mais parce que ce fichier applique une liste
 * vérifiée. Le balayage de `/admin/analyse` fait le reste, et le montre avant
 * d'écrire.
 */
async function foldDuplicates(
  work: Work,
  bump: (key: string, by?: number) => number,
): Promise<void> {
  for (const chapter of CHAPITRES_A_DOUBLONS) {
    const scenes = await scenesOf(work, chapter)
    const folded = new Set<string>()

    for (const [index, scene] of scenes.entries()) {
      if (folded.has(scene.entity_id)) continue

      const family = [
        scene,
        ...scenes
          .slice(index + 1)
          .filter(
            (other) => !folded.has(other.entity_id) && sameBeat(scene.summary, other.summary),
          ),
      ]
      if (family.length < 2) continue

      const kept = family.reduce((best, candidate) =>
        candidate.summary.length > best.summary.length ? candidate : best,
      )

      for (const copy of family) {
        if (copy.entity_id === kept.entity_id) continue
        folded.add(copy.entity_id)

        console.log(`  → ch.${chapter} — « ${copy.summary} »`)
        console.log(`      redit « ${kept.summary} »`)
        if (dryRun) continue

        await sql`
          UPDATE entities SET review_status = 'rejected'
           WHERE id = ${copy.entity_id} AND user_id = ${work.user_id}
        `
        await log(work, 'duplicate_scene_rejected', 'entity', copy.entity_id, {
          chapter,
          kept: kept.entity_id,
          summary: copy.summary,
        })
        bump('doublons repliés')
      }
    }
  }
}

async function reportVariants(work: Work, [preferred, variant]: [string, string]): Promise<void> {
  const left = await entityByLabels(work, [preferred])
  const right = await entityByLabels(work, [variant])

  if (!left || !right) return
  if (left.id === right.id) {
    console.log(`  = « ${preferred} » et « ${variant} » sont déjà la même fiche`)
    return
  }

  const identity = await identityBetween(work, left.id, right.id)
  if (identity) {
    console.log(`  = « ${preferred} » et « ${variant} » sont déjà rapprochés`)
    return
  }

  console.log(
    `  ? « ${preferred} » (ch.${left.firstSeen}) et « ${variant} » (ch.${right.firstSeen}) ` +
      `sont deux fiches. Fusionner réécrit ce que le lecteur savait entre les deux : ` +
      `à trancher sur la fiche, jamais ici.`,
  )
}

async function log(
  work: Work,
  action: string,
  subjectKind: string | null,
  subjectId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, ${action}, ${subjectKind}, ${subjectId},
            ${sql.json({ ...detail, note: NOTE })})
  `
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}
