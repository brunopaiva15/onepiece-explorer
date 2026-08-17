import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { openQuestions } from '@/domains/review/mystery-closing.ts'
import { getTimeline } from '@/domains/temporal/timeline.ts'
import {
  addMystery,
  closeDb,
  createEntity,
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
