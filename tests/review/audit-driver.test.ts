import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Le pilote des lectures payantes, sur une vraie base et un modèle de paille.
 *
 * Les analyseurs se testent sans base, et la mémoire des passes se teste sans
 * modèle. Ce qui reste, et qui n'est vrai qu'une fois les deux assemblés, est
 * la propriété qui coûte de l'argent quand elle est fausse :
 *
 *   une passe lit son paquet, retient ce qu'elle a lu, et **ne relit rien de ce
 *   qui n'a pas changé** — même après une interruption ;
 *
 *   un sujet en échec reste à lire, et son échec est dit ;
 *
 *   les constats sont écrits sous leur analyse et leur sujet, et le nettoyage
 *   d'un sujet n'emporte pas ceux d'un autre.
 *
 * Le fournisseur est remplacé ici plutôt que configuré : il faut un modèle qui
 * réponde exactement ce que le test veut, et il faut compter les appels. Ce que
 * le pilote fait de la réponse est le vrai sujet, et il est identique quel que
 * soit le modèle qui l'a produite.
 */

const answered = vi.fn()

vi.mock('@/domains/ai/index.ts', () => ({
  modelProvider: () => ({
    name: 'anthropic',
    answer: answered,
  }),
}))

const { readWithModel } = await import('@/domains/review/audit-passes.ts')
const { openFindings, passesFor, forgetPasses } = await import(
  '@/domains/review/audit-run.ts'
)
const {
  addEvent,
  addQuote,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  addAssertion,
} = await import('../helpers/db.ts')

type World = Awaited<ReturnType<typeof seedWorld>>

let world: World

beforeEach(async () => {
  await resetDatabase()
  answered.mockReset()
  world = await seedWorld([1, 2])
})

afterAll(async () => {
  await closeDb()
})

const PASSAGE = 'Usopp quitte enfin sa maison et rejoint le Vogue Merry comme membre de l’équipage.'

/** Un chapitre avec une scène fausse et le passage qui la contredit. */
async function aChapterWithAWrongScene(chapter: number): Promise<string> {
  const sceneId = await createEntity(world, 'event', chapter)
  await addEvent(world, sceneId, {
    summary: 'Usopp devient capitaine de l’équipage de Luffy.',
    shownIn: chapter,
  })

  /*
   * Le passage passe par une assertion parce que c'est ce que l'ancrage exige :
   * une preuve sans bloc de texte est refusée par la base elle-même, et un
   * bloc de texte se rattache à une page, donc à un chapitre.
   */
  const usopp = await createEntity(world, 'character', chapter)
  const crew = await createEntity(world, 'group', chapter)
  const assertionId = await addAssertion(world, {
    subject: usopp,
    predicate: 'member_of',
    object: crew,
    knowledgeFrom: chapter,
  })
  await addQuote(world, { assertionId, chapterNumber: chapter, text: PASSAGE })

  return sceneId
}

function reply(text: string) {
  return {
    value: { insufficient_data: false, answer: text, citations: [] },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 1,
      modelId: 'claude-sonnet-5',
    },
  }
}

describe('une lecture des scènes, du premier paquet à la reprise', () => {
  it('lit, écrit ses constats, et ne relit pas ce qui n’a pas changé', async () => {
    const first = await aChapterWithAWrongScene(1)
    await aChapterWithAWrongScene(2)

    answered.mockImplementation(async (request: { question: string }) =>
      request.question.includes('chapitre 1')
        ? reply(
            `${first} | Le chapitre en fait un membre, pas le capitaine. | ` +
              `Usopp rejoint le Vogue Merry comme membre. | rejoint le Vogue Merry comme membre de l’équipage`,
          )
        : reply('insufficient_data'),
    )

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4)

    expect(run.read).toBe(2)
    expect(run.found).toBe(1)
    expect(run.costCents).toBe(2)
    expect(answered).toHaveBeenCalledTimes(2)

    const findings = await openFindings(world.userId, world.workId)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'relecture', analysis: 'scenes', chapter: 1 })
    expect(findings[0]?.fix).toMatchObject({ action: 'reecrire_scene' })

    // Deuxième clic : rien n'a changé, donc rien n'est repayé.
    answered.mockClear()
    const again = await readWithModel(world.userId, world.workId, 'scenes', 4)

    expect(answered).not.toHaveBeenCalled()
    expect(again.read).toBe(0)
    expect(again.skipped).toBe(2)
    expect(again.costCents).toBe(0)
  })

  it('reprend là où une interruption l’a laissée, sans relire le premier paquet', async () => {
    await aChapterWithAWrongScene(1)
    await aChapterWithAWrongScene(2)

    answered.mockImplementation(async () => reply('insufficient_data'))

    const first = await readWithModel(world.userId, world.workId, 'scenes', 1)
    expect(first.read).toBe(1)
    expect(first.remaining).toBe(1)
    expect(answered).toHaveBeenCalledTimes(1)

    answered.mockClear()
    const second = await readWithModel(world.userId, world.workId, 'scenes', 1)

    expect(second.read).toBe(1)
    expect(second.remaining).toBe(0)
    expect(second.skipped).toBe(1)
    expect(answered).toHaveBeenCalledTimes(1)
  })

  it('repaye quand la scène a été reformulée entre-temps', async () => {
    const sceneId = await aChapterWithAWrongScene(1)
    answered.mockImplementation(async () => reply('insufficient_data'))

    await readWithModel(world.userId, world.workId, 'scenes', 4)
    answered.mockClear()

    await raw`UPDATE events SET summary = 'Usopp rejoint l’équipage.' WHERE entity_id = ${sceneId}`

    const again = await readWithModel(world.userId, world.workId, 'scenes', 4)
    expect(again.read).toBe(1)
    expect(answered).toHaveBeenCalledTimes(1)
  })

  it('repaye tout quand on le demande explicitement, et pas avant', async () => {
    await aChapterWithAWrongScene(1)
    answered.mockImplementation(async () => reply('insufficient_data'))

    await readWithModel(world.userId, world.workId, 'scenes', 4)
    // Les deux chapitres publiés ont été examinés ; seul le premier a coûté un
    // appel, l'autre n'ayant aucune scène à relire.
    expect(await forgetPasses(world.userId, world.workId, 'scenes')).toBe(2)

    answered.mockClear()
    const again = await readWithModel(world.userId, world.workId, 'scenes', 4)
    expect(again.read).toBe(2)
    expect(answered).toHaveBeenCalledTimes(1)
  })
})

describe('un sujet qui échoue', () => {
  it('reste à lire, et son échec est dit', async () => {
    await aChapterWithAWrongScene(1)

    answered.mockImplementation(async () => {
      throw Object.assign(new Error('jeton révoqué'), { kind: 'auth' })
    })

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4)

    // Le chapitre 2 n'a rien à relire et compte comme lu sans appel ; le 1 a
    // échoué.
    expect(run.read).toBe(1)
    expect(run.failures).toEqual([
      { subject: '1', label: 'chapitre 1', reason: 'jeton révoqué' },
    ])

    const passes = await passesFor(world.userId, world.workId, 'scenes')
    // La ligne existe pour que la page compte l'échec ; son empreinte est vide,
    // donc le chapitre est toujours à lire.
    expect(passes.get('1')?.inputFingerprint).toBe('')

    answered.mockClear()
    answered.mockImplementation(async () => reply('insufficient_data'))
    const again = await readWithModel(world.userId, world.workId, 'scenes', 4)
    expect(again.read).toBe(1)
  })

  it('est mis de côté quand l’appelant le lui demande', async () => {
    await aChapterWithAWrongScene(1)
    await aChapterWithAWrongScene(2)
    answered.mockImplementation(async () => reply('insufficient_data'))

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4, ['1'])

    expect(run.read).toBe(1)
    expect(answered).toHaveBeenCalledTimes(1)
  })
})

describe('un chapitre qui n’a rien à lire', () => {
  it('est retenu sans coûter un appel', async () => {
    answered.mockImplementation(async () => reply('insufficient_data'))

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4)

    expect(run.read).toBe(2)
    expect(run.costCents).toBe(0)
    expect(answered).not.toHaveBeenCalled()
  })
})

describe('ce qu’une réponse n’a pas le droit de faire écrire', () => {
  it('refuse une scène que le modèle a formée', async () => {
    await aChapterWithAWrongScene(1)

    answered.mockImplementation(async () =>
      reply('scene-inventee | faux | - | rejoint le Vogue Merry comme membre de l’équipage'),
    )

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4)

    expect(run.found).toBe(0)
    expect(await openFindings(world.userId, world.workId)).toEqual([])
  })

  it('refuse une citation absente du chapitre', async () => {
    const sceneId = await aChapterWithAWrongScene(1)

    answered.mockImplementation(async () =>
      reply(`${sceneId} | faux | - | Usopp est nommé capitaine par Luffy`),
    )

    const run = await readWithModel(world.userId, world.workId, 'scenes', 4)

    expect(run.found).toBe(0)
    expect(await openFindings(world.userId, world.workId)).toEqual([])
  })
})
