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
  'qu’elle a vaincu deux pirates, tandis qu’Alvida rôde dans la même rue.',
].join(' ')

const CHAPITRE_97 = [
  'À la station de la Marine, Smoker demande où se trouve Tashigi et envoie un',
  'subordonné la chercher après avoir reçu un témoignage sur des pirates.',
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
   * Et le cas que le script doit refuser, monté sur un vrai couple du tableau.
   *
   * « Belle femme observée par Sanji » entre en scène au 97 alors que la source
   * du 96 écrit déjà « Alvida ». Le nœud n'a donc jamais été provisoire : le
   * lecteur pouvait lire ce nom quand il a été créé, et les deux nœuds se
   * doublent dès le 97. Les rejoindre par une identité datée du 96 laisserait
   * la copie visible au chapitre où elle fait double emploi — c'est un doublon,
   * qui se répare avec l'outil qui la retire, et le refus est ce qui sépare
   * cette réparation-ci de celle-là.
   */
  const alvida = await createEntity(world, 'character', 96)
  await addLabel(world, alvida, 'Alvida', 'true_name', 96, 100)

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

describe('ce que le script refuse', () => {
  it('ne rejoint pas deux nœuds quand le nom était déjà lisible', async () => {
    // « Alvida » est dans la source du 96 et ce nœud entre en scène au 97 : il
    // n'a jamais été provisoire. C'est un doublon, et le réparer ici laisserait
    // la copie visible au chapitre où elle fait double emploi.
    const [row] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM assertions
       WHERE user_id = ${world.userId} AND predicate = 'same_as'
         AND (subject_entity_id = ${doublon} OR object_entity_id = ${doublon})`
    expect(row?.n).toBe('0')

    const [label] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels WHERE entity_id = ${doublon}`
    expect(label?.n).toBe('1')
  })

  it('ne se répète pas au second passage', async () => {
    await exec('pnpm', ['repair:noms'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })

    const [joins] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM assertions
       WHERE user_id = ${world.userId} AND predicate = 'same_as'`
    expect(joins?.n).toBe('1')

    const [names] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels
       WHERE entity_id = ${sabreuse} AND label = 'Tashigi'`
    expect(names?.n).toBe('1')
  })
}, 120_000)
