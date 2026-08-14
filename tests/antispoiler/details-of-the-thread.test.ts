import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addEvent,
  addLabel,
  addMystery,
  addPresence,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { getStoryPage } from '@/domains/temporal/story.ts'
import { displayLabel } from '@/domains/temporal/projection.ts'

/**
 * Les détails relevés en relisant le fil.
 *
 * Chacun est reproduit ici sous la forme exacte que la bibliothèque a — un nom
 * du futur dans une question, une graphie de la source dans une phrase
 * française, une entrée en scène datée de dix-huit chapitres trop tard, une
 * personne rangée en deux nœuds, un personnage rangé en groupe. Le script est
 * ensuite lancé pour de vrai, et ce sont ses effets qui sont mesurés.
 *
 * Le premier est le seul qui soit un spoiler, et c'est le même que celui du
 * chapitre 1 vu vingt-cinq chapitres plus loin : la relecture des chapitres 1
 * à 42 réécrivait « Kuro » en « Klahadore » dans les résumés d'événements et
 * jamais dans les questions, qui l'affichaient donc deux chapitres avant sa
 * révélation.
 */

const exec = promisify(execFile)

let world: SeededWorld
let zoro: string
let sorrow: string
let zeff: string
let yasopp: string

beforeAll(async () => {
  await resetDatabase()
  world = await seedWorld([2, 3, 19, 21, 24, 25, 26, 31, 36, 43, 47, 48])

  // --- Le majordome, sous le nom que le lecteur n'a pas encore lu -----------
  const butler = await createEntity(world, 'character', 23)
  await addLabel(world, butler, 'Klahadore', 'true_name', 23, 100)
  await addLabel(world, butler, 'Kuro', 'true_name', 26, 100)
  const riddle = await createEntity(world, 'mystery', 24)
  await addLabel(world, riddle, 'Kuro a-t-il des raisons cachées ?', 'alias', 24, 10)
  await addMystery(world, riddle, {
    question: 'Kuro a-t-il des raisons cachées ?',
    openedIn: 24,
  })

  // --- Une graphie de la source, dans une phrase française ------------------
  const scene = await createEntity(world, 'event', 19)
  await addLabel(world, scene, 'Buggy explique à Luffy pourquoi il déteste Shanks.', 'alias', 19, 10)
  await addEvent(world, scene, {
    summary: 'Buggy explique à Luffy pourquoi il déteste Shanks.',
    shownIn: 19,
  })

  /*
   * Zoro : nommé au 2, dessiné au 3, et le fil le fait entrer au 21.
   *
   * La forme est celle de la bibliothèque et chaque morceau compte : une
   * mention déclarée au 2, aucune déclaration aux chapitres d'avant le champ,
   * et une apparition déclarée au 21 — la première que l'extraction ait
   * énoncée. Sans la mention du 2, le fil garderait l'ancien comportement et
   * le défaut ne se produirait pas.
   */
  zoro = await createEntity(world, 'character', 2)
  await addLabel(world, zoro, 'Roronoa Zoro', 'true_name', 2, 100)
  await addPresence(world, zoro, { chapterNumber: 2, kind: 'mention' })
  await addPresence(world, zoro, { chapterNumber: 21, kind: 'appearance' })

  /*
   * Le loup d'Hermep, dont le nom est mal orthographié — et qui ressemble à
   * « Zoro » d'assez près pour qu'une première version de ce script ait voulu
   * le replier dedans. C'est pour ça qu'il est ici : la ressemblance de deux
   * libellés n'établit rien, et le test le dit en gardant deux nœuds.
   */
  sorrow = await createEntity(world, 'character', 3)
  await addLabel(world, sorrow, 'Soro', 'true_name', 3, 100)
  const wolfScene = await createEntity(world, 'event', 3)
  const wolfLine = 'Zoro a été arrêté pour avoir tué Soro, le loup d’Hermep.'
  await addLabel(world, wolfScene, wolfLine, 'alias', 3, 10)
  await addEvent(world, wolfScene, { summary: wolfLine, shownIn: 3 })

  // --- Zeff en trois nœuds, dont un rangé en concept ------------------------
  zeff = await createEntity(world, 'character', 43)
  await addLabel(world, zeff, 'Zeff', 'true_name', 43, 100)
  const nickname = await createEntity(world, 'character', 47)
  await addLabel(world, nickname, 'Zeff aux Pieds Rouges', 'true_name', 47, 100)
  const reputation = await createEntity(world, 'concept', 48)
  await addLabel(world, reputation, 'Zeff aux Pieds rouges', 'true_name', 48, 100)

  // --- Deux personnages rangés en groupes -----------------------------------
  for (const name of ['Sham', 'Buchi']) {
    const id = await createEntity(world, 'group', 31)
    await addLabel(world, id, name, 'true_name', 31, 100)
  }

  /*
   * Yasopp, et la graphie de la source à côté.
   *
   * Rangée en vrai nom plutôt qu'en formulation de recherche, ce qui est
   * l'erreur : le fil annonce alors deux révélations au même chapitre, à une
   * lettre près.
   */
  yasopp = await createEntity(world, 'character', 1)
  await addLabel(world, yasopp, 'Pirate au bandeau', 'placeholder', 1, 10)
  await addLabel(world, yasopp, 'Yasopp', 'true_name', 25, 100)
  await addLabel(world, yasopp, 'Yassop', 'true_name', 25, 100)

  await exec('pnpm', ['repair:details'], {
    env: { ...process.env, TEST_DB: '1' },
    cwd: process.cwd(),
  })
}, 120_000)

describe('un nom que le lecteur n’a pas encore lu', () => {
  it('retire « Kuro » des questions ouvertes avant sa révélation', async () => {
    const [row] = await raw<Array<{ question: string }>>`
      SELECT question FROM mysteries
       WHERE user_id = ${world.userId} AND opened_in_chapter = 24
    `
    expect(row?.question).toBe('Klahadore a-t-il des raisons cachées ?')
  })

  it('réécrit aussi le libellé, que lisent la recherche et le fil', async () => {
    const [row] = await raw<Array<{ label: string }>>`
      SELECT l.label FROM entity_labels l
       JOIN mysteries m ON m.entity_id = l.entity_id
      WHERE m.user_id = ${world.userId} AND m.opened_in_chapter = 24
    `
    expect(row?.label).toMatch(/^Klahadore/)
  })

  it('laisse la révélation du chapitre 26 intacte', async () => {
    // La borne est ce qui distingue une correction d'un effacement : « Kuro »
    // reste le nom du majordome à partir du 26, sans quoi le script détruirait
    // la révélation qu'il protège.
    const [row] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Kuro' AND revealed_in_chapter = 26
    `
    expect(row?.n).toBe('1')
  })
})

describe('une graphie de la source dans une phrase française', () => {
  it('écrit Baggy là où le résumé disait Buggy', async () => {
    const [row] = await raw<Array<{ summary: string }>>`
      SELECT summary FROM events
       WHERE user_id = ${world.userId} AND shown_in_chapter = 19
    `
    expect(row?.summary).toBe('Baggy explique à Luffy pourquoi il déteste Shanks.')
  })
})

describe('l’entrée en scène de Zoro', () => {
  it('le fait entrer au chapitre 3, où il est dessiné', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 2,
      count: 25,
      ceiling: 48,
    })
    const entrance = page.beats.find(
      (beat) => beat.kind === 'entree' && beat.text === 'Roronoa Zoro',
    )
    expect(entrance?.chapter).toBe(3)
  })

  it('le laisse mentionné, et non vu, au chapitre 2', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 2,
      count: 2,
      ceiling: 48,
    })
    const mention = page.beats.find(
      (beat) => beat.kind === 'mention' && beat.text === 'Roronoa Zoro',
    )
    expect(mention?.chapter).toBe(2)
  })

  it('ne replie rien dans Zoro', async () => {
    /*
     * Le test de la faute évitée.
     *
     * « Soro » ressemble à « Zoro » à une lettre près, et c'est tout ce que
     * cette ressemblance établit : c'est Sorrow, le loup d'Hermep, celui que
     * Zoro tue et pour lequel il est arrêté. Une fusion aurait rangé un animal
     * dans un personnage et donné à Zoro les faits du loup. Deux nœuds, donc,
     * et cette assertion existe pour que la fusion ne revienne pas.
     */
    const sheet = await getEntitySheet(world.userId, 48, zoro)
    expect(sheet?.memberIds).toEqual([zoro])
    expect(sheet?.displayLabel).toBe('Roronoa Zoro')
  })
})

describe('le loup d’Hermep, sous son nom', () => {
  it('corrige l’orthographe sans toucher au chapitre', async () => {
    const sheet = await getEntitySheet(world.userId, 48, sorrow)
    expect(sheet?.displayLabel).toBe('Sorrow')
    const name = sheet?.labels.find((label) => label.label === 'Sorrow')
    // Le même nom, mieux écrit : le dater d'aujourd'hui ouvrirait dans le
    // curseur un chapitre où l'animal n'aurait pas de nom.
    expect(name?.revealedInChapter).toBe(3)
  })

  it('garde « Soro » trouvable par la recherche', async () => {
    const [row] = await raw<Array<{ precedence: number }>>`
      SELECT precedence FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Soro'
    `
    expect(row?.precedence).toBe(5)
  })

  it('fait suivre les phrases qui l’épelaient', async () => {
    const [row] = await raw<Array<{ summary: string }>>`
      SELECT summary FROM events
       WHERE user_id = ${world.userId} AND shown_in_chapter = 3
    `
    expect(row?.summary).toBe('Zoro a été arrêté pour avoir tué Sorrow, le loup d’Hermep.')
  })
})

describe('Zeff, en un seul homme', () => {
  it('replie les trois nœuds et garde « Zeff » pour l’appeler', async () => {
    const sheet = await getEntitySheet(world.userId, 48, zeff)
    expect(sheet?.memberIds.length).toBe(3)
    expect(sheet?.displayLabel).toBe('Zeff')
  })

  it('garde le surnom à sa date, comme un surnom', async () => {
    // Le rang est ce qui l'empêche de devenir le nom affiché ; la date reste,
    // parce que le lecteur a bien lu ce mot au chapitre 47.
    const sheet = await getEntitySheet(world.userId, 48, zeff)
    const nickname = sheet?.labels.find((l) => l.label === 'Zeff aux Pieds Rouges')
    expect(nickname?.kind).toBe('epithet')
    expect(nickname?.revealedInChapter).toBe(47)
  })
})

describe('ce qu’un nœud est', () => {
  it('range Sham et Buchi parmi les personnages', async () => {
    const rows = await raw<Array<{ label: string; node_type: string }>>`
      SELECT l.label, en.node_type
        FROM entity_labels l JOIN entities en ON en.id = l.entity_id
       WHERE l.user_id = ${world.userId} AND l.label IN ('Sham', 'Buchi')
    `
    expect(rows.map((row) => row.node_type)).toEqual(['character', 'character'])
  })
})

describe('une graphie que rien n’affiche n’est pas une révélation', () => {
  it('n’annonce qu’un seul nom pour Yasopp au chapitre 25', async () => {
    const page = await getStoryPage(world.userId, world.workId, {
      from: 25,
      count: 1,
      ceiling: 48,
    })
    const names = page.beats.filter((beat) => beat.kind === 'nom')
    expect(names.map((beat) => beat.text)).toEqual(['Yasopp'])
  })

  it('garde « Yassop » trouvable, et jamais affiché', async () => {
    expect((await displayLabel(world.userId, 25, yasopp))?.label).toBe('Yasopp')
    const [row] = await raw<Array<{ precedence: number }>>`
      SELECT precedence FROM entity_labels
       WHERE user_id = ${world.userId} AND label = 'Yassop'
    `
    expect(row?.precedence).toBe(5)
  })
})

describe('rejouable', () => {
  it('n’écrit rien la seconde fois', async () => {
    const { stdout } = await exec('pnpm', ['repair:details'], {
      env: { ...process.env, TEST_DB: '1' },
      cwd: process.cwd(),
    })
    expect(stdout).toMatch(/Rien à corriger\./)
  }, 120_000)
})
