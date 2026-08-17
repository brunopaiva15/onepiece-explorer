import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { openQuestions } from '@/domains/review/mystery-closing.ts'
import { getTimeline } from '@/domains/temporal/timeline.ts'
import {
  addMystery,
  closeDb,
  createEntity,
  publishChapter,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce que le bouton de /mystères propose d'examiner.
 *
 * La page et le balayage lisent la même table et n'y voient pas la même chose,
 * et c'est voulu des deux côtés. « Sans réponse » à l'écran veut dire « sans
 * réponse *pour vous* » : une question que l'histoire referme trois cents
 * chapitres plus loin y figure, parce que le contraire serait un spoiler. Le
 * balayage, lui, écrit dans le graphe, et le graphe sait déjà.
 *
 * D'où ce fichier. Prendre la liste de la page reviendrait à payer un appel de
 * modèle par question déjà refermée — sur une bibliothèque relue depuis le
 * début, c'est la facture entière pour rien — et à annoncer « déjà refermée »
 * sur des questions dont la page ne peut pas dire pourquoi.
 */

let world: SeededWorld

/** Une question ouverte au 16, à laquelle le 17 répond. */
let cabaji: string
/** Une question ouverte au 2, restée sans réponse. */
let treasure: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([2, 16, 17, 60])

  cabaji = await createEntity(world, 'mystery', 16)
  await addMystery(world, cabaji, {
    question: 'Zoro peut-il encore se battre après Baggy ?',
    openedIn: 16,
    state: 'resolved',
    resolvedIn: 60,
  })

  treasure = await createEntity(world, 'mystery', 2)
  await addMystery(world, treasure, {
    question: 'Où se trouve le trésor que Gold Roger a laissé derrière lui ?',
    openedIn: 2,
  })
})

afterAll(closeDb)

describe('les questions que le balayage propose', () => {
  it('laisse de côté celles que le graphe sait refermées', async () => {
    const questions = await openQuestions(world.userId)

    expect(questions.map((question) => question.entityId)).toEqual([treasure])
  })

  it('les laisse de côté même quand le lecteur les voit ouvertes', async () => {
    // Le lecteur en est au 20 ; la réponse est au 60.
    const timeline = await getTimeline(world.userId, 20)
    const open = timeline.byRevelation.filter(
      (entry) => entry.kind === 'mystery' && entry.resolvedInChapter === null,
    )

    // La page en montre deux : c'est la projection qui fait son travail.
    expect(open.map((entry) => entry.entityId).sort()).toEqual([cabaji, treasure].sort())

    // Le balayage n'en propose qu'une : c'est la table qui fait le sien.
    expect((await openQuestions(world.userId)).map((q) => q.entityId)).toEqual([treasure])
  })

  it('ne propose pas les questions d’un autre lecteur', async () => {
    const other = await seedWorld([1])
    const theirs = await createEntity(other, 'mystery', 1)
    await addMystery(other, theirs, { question: 'Qui est Imu ?', openedIn: 1 })

    expect((await openQuestions(world.userId)).map((q) => q.entityId)).toEqual([treasure])
    expect((await openQuestions(other.userId)).map((q) => q.entityId)).toEqual([theirs])
  })
})

/**
 * Ce qu'une relance repose, et ce qu'elle ne repose pas.
 *
 * Le défaut, mesuré sur un runner : `resolved_in_chapter IS NULL` étant le seul
 * filtre, une question examinée contre neuf cents scènes et laissée ouverte
 * revenait à la passe suivante, qui relisait les neuf cents pour rendre le même
 * verdict. Comme le balayage s'arrête de lui-même après trois échecs d'affilée et
 * que le CLI meurt sans un mot sur quatre appels sur dix, il mourait vers la
 * vingtième question et la relance recommençait par celles qu'il venait de lire.
 * Cent trente et une questions dont la plupart sont de vraies énigmes que
 * l'histoire n'a pas refermées : le lot ne convergeait jamais.
 *
 * `swept_to_chapter` est la mémoire qui manquait, et ce qu'elle retient est un
 * état de la bibliothèque plutôt qu'une date — ce qui rend l'oubli automatique et
 * juste : publier un chapitre de plus, c'est créer des scènes qu'aucune passe n'a
 * lues, donc une raison de reposer la question.
 */
describe('une question déjà posée à toute l’histoire', () => {
  /** 60 est le dernier chapitre publié de cette bibliothèque. */
  const SWEPT_TO_THE_END = 60

  it('n’est pas reposée tant que rien de neuf n’est publié', async () => {
    const shanks = await createEntity(world, 'mystery', 1)
    await addMystery(world, shanks, {
      question: 'Comment Shanks a-t-il fait fuir le Monstre de la Baie ?',
      openedIn: 1,
      sweptTo: SWEPT_TO_THE_END,
    })

    expect((await openQuestions(world.userId)).map((q) => q.entityId)).toEqual([treasure])
  })

  it('redevient à poser dès que la bibliothèque grandit', async () => {
    const shanks = await createEntity(world, 'mystery', 1)
    await addMystery(world, shanks, {
      question: 'Comment Shanks a-t-il fait fuir le Monstre de la Baie ?',
      openedIn: 1,
      sweptTo: SWEPT_TO_THE_END,
    })

    // Le 61 entre dans la bibliothèque : il porte des scènes qu'aucune passe n'a
    // lues, et c'est la seule chose qui peut changer la réponse.
    await publishChapter(world, 61)

    expect((await openQuestions(world.userId)).map((q) => q.entityId).sort()).toEqual(
      [shanks, treasure].sort(),
    )
  })

  it('est proposée quand elle n’a jamais été examinée', async () => {
    // Le null est le cas ordinaire, et celui des cent trente et une questions
    // existantes le jour où la colonne est ajoutée : la première passe après la
    // migration travaille comme avant, c'est la seconde qui devient une reprise.
    const shanks = await createEntity(world, 'mystery', 1)
    await addMystery(world, shanks, {
      question: 'Comment Shanks a-t-il fait fuir le Monstre de la Baie ?',
      openedIn: 1,
    })

    expect((await openQuestions(world.userId)).map((q) => q.entityId).sort()).toEqual(
      [shanks, treasure].sort(),
    )
  })

  /*
   * La marque d'une œuvre ne parle pas d'une autre.
   *
   * La frontière est par œuvre, donc la comparaison doit l'être. Une marque lue
   * contre la frontière du voisin retiendrait une question qu'il faut poser, ou
   * reposerait indéfiniment une question déjà lue jusqu'au bout.
   */
  it('se compare à la frontière de sa propre œuvre', async () => {
    const other = await seedWorld([1, 2])
    const theirs = await createEntity(other, 'mystery', 1)
    await addMystery(other, theirs, {
      question: 'Qui est Imu ?',
      openedIn: 1,
      // Déjà examinée jusqu'au 2, qui est tout ce que cette œuvre-là publie.
      sweptTo: 2,
    })

    expect((await openQuestions(other.userId)).map((q) => q.entityId)).toEqual([])
    // Et la voisine, dont la frontière est au 60, n'en est pas affectée.
    expect((await openQuestions(world.userId)).map((q) => q.entityId)).toEqual([treasure])
  })
})
