import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { projectGraph } from '@/domains/temporal/projection.ts'
import {
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce que la relecture des chapitres 1 à 137 laisse derrière elle.
 *
 * Le fil cesse de renommer au chapitre 51 — les six lignes « un nom : » tombent
 * toutes dans la portée des relectures déjà écrites — et au-delà, un chapitre
 * qui apprend au lecteur le vrai nom de quelqu'un qu'il connaît écrit un second
 * nœud. Les deux vivent alors côte à côte pour le reste de l'histoire :
 * « Homme mystérieux debout sur l'eau » et Wapol entrent en scène au même
 * chapitre 131, Mr 8 et Igaram se croisent dans la prose du 110, et Tashigi est
 * nommée dans les phrases du 97 sans être nulle part un nœud.
 *
 * Les deux formes sont reproduites ici, avec la seule chose qui les distingue
 * — l'existence d'un second nœud — et le script est ensuite lancé pour de vrai.
 *
 * Ce que ces tests épinglent tient en une phrase : la fusion est **datée**, et
 * les deux nœuds restent. Sous le chapitre qui révèle, la silhouette est encore
 * une silhouette ; à partir de lui, c'est Wapol. Un script qui rejetterait le
 * nœud provisoire — ce que fait la réparation des vrais doublons, à raison —
 * effacerait ici l'état que la frontière existe pour garder.
 *
 * Et la date ne vient pas du tableau du script : elle est lue dans les sources.
 * D'où les deux chapitres importés, dont un seul écrit le nom.
 */

const exec = promisify(execFile)

const CHAPITRE_130 = [
  'Un jour plus tard, Zoro aperçoit un homme qui se tient debout à la surface de',
  'l’eau, parfaitement immobile, et n’en croit pas ses yeux.',
].join(' ')

const CHAPITRE_131 = [
  'Le navire pirate surgit des flots et son capitaine, Wapol, se met à dévorer le',
  'Vogue Merry sous les yeux stupéfaits de tout l’équipage.',
].join(' ')

const CHAPITRE_96 = [
  'À Loguetown, Zoro aide une jeune sabreuse à retrouver ses lunettes après',
  'qu’elle a vaincu deux pirates, et lui trouve un air étrangement familier.',
].join(' ')

const CHAPITRE_97 = [
  'À la station de la Marine, Smoker demande où se trouve Tashigi et envoie un',
  'subordonné la chercher ; plus loin, Sanji découvre que la belle femme qu’il',
  'observait est en réalité Alvida, transformée.',
].join(' ')

let world: SeededWorld
/** Le nœud provisoire : ce que le lecteur voit au 130, sans nom. */
let silhouette: string
let wapol: string
/** Le nœud du 96, que rien ne relie au nom qui circule au 97. */
let sabreuse: string
/** Deux nœuds pour une personne que la source nommait déjà : un doublon. */
let doublon: string

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld([])

  for (const [number, text] of [
    [96, CHAPITRE_96],
    [97, CHAPITRE_97],
    [130, CHAPITRE_130],
    [131, CHAPITRE_131],
  ] as const) {
    await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: number,
      language: 'fr',
      text,
    })
  }

  // --- Deux nœuds, et le nom au second ------------------------------------
  silhouette = await createEntity(world, 'character', 130)
  await addLabel(world, silhouette, 'Homme mystérieux debout sur l’eau', 'placeholder', 130, 10)

  wapol = await createEntity(world, 'character', 131)
  await addLabel(world, wapol, 'Wapol', 'true_name', 131, 100)

  // --- Un nom qui circule dans la prose et n'est nulle part un nœud --------
  sabreuse = await createEntity(world, 'character', 96)
  await addLabel(
    world,
    sabreuse,
    'Fille au sabre ressemblant à Kuina',
    'placeholder',
    96,
    10,
  )

  /*
   * La révélation qui tient dans un seul chapitre, montée sur un vrai couple.
   *
   * « Belle femme observée par Sanji » et Alvida entrent en scène au même
   * chapitre 97, dont la source écrit déjà le nom : le lecteur rencontre la
   * belle femme et apprend qui elle est dans les mêmes pages. C'est la forme la
   * plus courante, et le script l'a d'abord refusée en la prenant pour un
   * doublon. Elle ne l'est pas : la frontière n'a pas de grain plus fin que le
   * chapitre, donc replier au 97 ne cache rien — au 96, aucun des deux n'existe.
   */
  const alvida = await createEntity(world, 'character', 97)
  await addLabel(world, alvida, 'Alvida', 'true_name', 97, 100)

  doublon = await createEntity(world, 'character', 97)
  await addLabel(world, doublon, 'Belle femme observée par Sanji', 'placeholder', 97, 10)

  await exec('pnpm', ['repair:noms'], {
    env: { ...process.env, TEST_DB: '1' },
    cwd: process.cwd(),
  })
}, 120_000)

afterAll(async () => {
  await closeDb()
})

describe('deux nœuds que le chapitre 131 réunit', () => {
  it('écrit une identité datée du chapitre qui donne le nom', async () => {
    const [row] = await raw<
      Array<{ knowledge_from_chapter: number; review_status: string; locked: boolean }>
    >`SELECT knowledge_from_chapter, review_status, locked FROM assertions
        WHERE user_id = ${world.userId} AND predicate = 'same_as'
          AND subject_entity_id = ${silhouette} AND object_entity_id = ${wapol}`

    expect(row).toBeDefined()
    // 131 lu dans la source, pas écrit dans le tableau du script : le chapitre
    // 130 parle du même homme et ne l'appelle pas Wapol.
    expect(row!.knowledge_from_chapter).toBe(131)
    expect(row!.review_status).toBe('accepted')
    expect(row!.locked).toBe(true)
  })

  it('garde les deux nœuds : la silhouette est encore une silhouette au 130', async () => {
    const before = await getEntitySheet(world.userId, 130, silhouette)
    expect(before?.displayLabel).toBe('Homme mystérieux debout sur l’eau')
    // Et « Wapol » n'est pas sur la page, pas même en petit sous le titre.
    expect(before?.labels.map((row) => row.label)).toEqual([
      'Homme mystérieux debout sur l’eau',
    ])

    const [row] = await raw<Array<{ review_status: string }>>`
      SELECT review_status FROM entities WHERE id = ${silhouette}`
    expect(row?.review_status).toBe('accepted')
  })

  it('l’appelle Wapol à partir du 131, sur la fiche comme dans le graphe', async () => {
    const after = await getEntitySheet(world.userId, 131, silhouette)
    expect(after?.displayLabel).toBe('Wapol')
    // L'ancienne désignation reste lisible dessous : c'est sous ce nom que le
    // lecteur l'a rencontré, et la recherche doit encore le trouver ainsi.
    expect(after?.labels.map((row) => row.label)).toContain(
      'Homme mystérieux debout sur l’eau',
    )

    /*
     * Le graphe est l'autre moitié de la démonstration. La fusion n'est pas une
     * opération sur des lignes : c'est l'union-find de la projection qui lit
     * l'identité à sa frontière, donc deux nœuds au 130 et un seul au 131.
     */
    const at130 = await projectGraph(world.userId, 130)
    const at131 = await projectGraph(world.userId, 131)

    const silhouettes130 = at130.nodes.filter((node) =>
      node.memberIds.includes(silhouette),
    )
    expect(silhouettes130).toHaveLength(1)
    expect(silhouettes130[0]!.memberIds).toEqual([silhouette])

    const folded = at131.nodes.filter((node) => node.memberIds.includes(silhouette))
    expect(folded).toHaveLength(1)
    expect(folded[0]!.memberIds.sort()).toEqual([silhouette, wapol].sort())
    expect(folded[0]!.label).toBe('Wapol')
  })
})

describe('un nom qui circule sans nœud', () => {
  it('l’écrit sur le nœud qui existe, daté du chapitre qui l’écrit', async () => {
    const [row] = await raw<
      Array<{ kind: string; revealed_in_chapter: number; precedence: number }>
    >`SELECT kind, revealed_in_chapter, precedence FROM entity_labels
        WHERE entity_id = ${sabreuse} AND label = 'Tashigi'`

    expect(row).toBeDefined()
    expect(row!.kind).toBe('true_name')
    expect(row!.revealed_in_chapter).toBe(97)
    // À sa pleine précédence : « elle s'appelle ainsi », et non « on l'appelle
    // aussi ainsi ».
    expect(row!.precedence).toBe(100)
  })

  it('ne crée pas de second nœud pour elle', async () => {
    const [row] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Tashigi'`
    expect(row?.n).toBe('1')
  })

  it('bascule au 97 et pas au 96', async () => {
    const before = await getEntitySheet(world.userId, 96, sabreuse)
    expect(before?.displayLabel).toBe('Fille au sabre ressemblant à Kuina')
    expect(before?.labels.map((row) => row.label)).toEqual([
      'Fille au sabre ressemblant à Kuina',
    ])

    const after = await getEntitySheet(world.userId, 97, sabreuse)
    expect(after?.displayLabel).toBe('Tashigi')
  })
})

describe('une révélation qui tient dans un seul chapitre', () => {
  it('rejoint quand même, daté de ce chapitre-là', async () => {
    /*
     * Le cas que le script refusait. « Belle femme observée par Sanji » et
     * Alvida entrent en scène au 97, et la source du 97 écrit le nom : la
     * rencontre et la révélation sont dans les mêmes pages. C'est la forme la
     * plus courante — Wapol entre en scène au 131 et est nommé douze pages plus
     * loin — et la refuser laissait deux nœuds pour le reste de l'œuvre.
     */
    const [row] = await raw<Array<{ knowledge_from_chapter: number }>>`
      SELECT knowledge_from_chapter FROM assertions
       WHERE user_id = ${world.userId} AND predicate = 'same_as'
         AND (subject_entity_id = ${doublon} OR object_entity_id = ${doublon})`

    expect(row).toBeDefined()
    expect(row!.knowledge_from_chapter).toBe(97)
  })

  it('affiche Alvida au 97, et rien du tout au 96', async () => {
    const after = await getEntitySheet(world.userId, 97, doublon)
    expect(after?.displayLabel).toBe('Alvida')

    // Au 96 le nœud n'existe pas encore : il n'y a rien à cacher, et c'est
    // pourquoi replier au 97 ne coûte aucune frontière.
    const before = await getEntitySheet(world.userId, 96, doublon)
    expect(before).toBeNull()
  })

  it('ne se répète pas au second passage', async () => {
    // Compté avant et après plutôt que comparé à un nombre écrit ici : le
    // tableau du script grandira, et une assertion sur « 1 » se serait mise à
    // échouer pour la seule raison qu'un couple de plus a été trouvé — ce qui
    // n'est pas ce que ce test surveille.
    const count = async (): Promise<string> => {
      const [row] = await raw<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM assertions
         WHERE user_id = ${world.userId} AND predicate = 'same_as'`
      return row?.n ?? '0'
    }

    const before = await count()
    expect(Number(before)).toBeGreaterThan(0)

    await exec('pnpm', ['repair:noms'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })

    expect(await count()).toBe(before)

    const [names] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels
       WHERE entity_id = ${sabreuse} AND label = 'Tashigi'`
    expect(names?.n).toBe('1')
  })
}, 120_000)
