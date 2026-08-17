import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { unnamedFigures } from '@/domains/review/identity-candidates.ts'
import {
  addAssertion,
  addLabel,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Ce que le rattrapage a le droit d'interroger, et ce que ça coûte de se tromper.
 *
 * Ce test existe à cause d'une exécution réelle. Le premier passage sur une
 * bibliothèque de 140 chapitres a annoncé **141 figures encore sans nom** et s'est
 * mis à demander à un modèle qui étaient « Chapeau de paille », « Base de la
 * Marine », « Statue de Morgan », « Clé de la cage » et « Prime d'Alvida » — des
 * objets et des lieux dont le libellé est le nom, un appel payé chacun pour se
 * faire répondre non.
 *
 * La faute était de prendre « sans `true_name` » pour « sans nom ». La
 * publication ne range en `true_name` que ce que le modèle a marqué ainsi, et
 * pour un lieu ou un objet elle met autre chose : le critère mesurait la
 * nomenclature du modèle et non l'ignorance du lecteur.
 *
 * D'où ce fichier, sur la moitié du balayage qui coûte de l'argent quand elle est
 * fausse. La règle se testait déjà sans base ni appel ; la sélection se teste
 * maintenant contre une base, et sans appel non plus.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2])
})

afterAll(async () => {
  await closeDb()
})

const asked = async (): Promise<string[]> =>
  (await unnamedFigures(raw)).map((row) => row.label)

describe('les types qu’une révélation concerne', () => {
  it('interroge les personnes et les groupes', async () => {
    const silhouette = await createEntity(world, 'character', 1)
    await addLabel(world, silhouette, 'Homme mystérieux debout sur l’eau', 'placeholder', 1, 10)

    const crew = await createEntity(world, 'group', 1)
    await addLabel(world, crew, 'Équipage du navire noir', 'placeholder', 1, 10)

    expect((await asked()).sort()).toEqual(
      ['Homme mystérieux debout sur l’eau', 'Équipage du navire noir'].sort(),
    )
  })

  it('laisse tranquilles les objets, les lieux, les concepts et les espèces', async () => {
    // Les cinq premiers noms de la liste de 141, dans les types qui les portent :
    // leur libellé est leur nom, il n'y a rien à révéler.
    for (const [nodeType, label] of [
      ['object', 'Chapeau de paille'],
      ['place', 'Base de la Marine'],
      ['object', 'Statue de Morgan'],
      ['concept', 'Prime d’Alvida'],
      ['species', 'Roi des Mers'],
    ] as const) {
      const entity = await createEntity(world, nodeType, 1)
      await addLabel(world, entity, label, 'alias', 1, 50)
    }

    expect(await asked()).toEqual([])
  })
})

describe('ce qu’une seconde exécution ne repaye pas', () => {
  it('ne redemande pas une figure déjà nommée', async () => {
    const butler = await createEntity(world, 'character', 1)
    await addLabel(world, butler, 'Le majordome', 'placeholder', 1, 10)
    await addLabel(world, butler, 'Kuro', 'true_name', 2, 100)

    expect(await asked()).toEqual([])
  })

  it('ne redemande pas une figure déjà rejointe', async () => {
    const silhouette = await createEntity(world, 'character', 1)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 1, 10)

    const named = await createEntity(world, 'character', 2)
    await addLabel(world, named, 'Wapol', 'true_name', 2, 100)

    await addAssertion(world, {
      subject: silhouette,
      predicate: 'same_as',
      object: named,
      knowledgeFrom: 2,
    })

    expect(await asked()).toEqual([])
  })

  it('ne redemande pas une figure dont une carte attend une réponse', async () => {
    // C'est ce qui rend le second passage gratuit : la carte écrite par le
    // premier vaut « question déjà posée », pas « question sans réponse ».
    const silhouette = await createEntity(world, 'character', 1)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 1, 10)

    const chapterId = world.chapterIds.get(2)!
    const runId = randomUUID()
    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
      VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'anthropic')
    `
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${randomUUID()}, ${runId}, ${chapterId}, ${world.userId}, 'assertion', 90,
        ${raw.json({ subject: silhouette, predicate: 'same_as', object: randomUUID() })},
        ${randomUUID()}, true, 0.9, 'proposed'
      )
    `

    expect(await asked()).toEqual([])
  })

  it('redemande une figure dont la carte a été rejetée', async () => {
    /*
     * Rejeter une proposition n'est pas répondre à la question : le lecteur a dit
     * « pas celui-là », pas « personne ». Une carte close ne doit donc pas retirer
     * la figure du balayage pour toujours — sans quoi une seule mauvaise
     * proposition la condamnerait à rester sans nom.
     */
    const silhouette = await createEntity(world, 'character', 1)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 1, 10)

    const chapterId = world.chapterIds.get(2)!
    const runId = randomUUID()
    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
      VALUES (${runId}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'anthropic')
    `
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${randomUUID()}, ${runId}, ${chapterId}, ${world.userId}, 'assertion', 90,
        ${raw.json({ subject: silhouette, predicate: 'same_as', object: randomUUID() })},
        ${randomUUID()}, true, 0.9, 'rejected'
      )
    `

    expect(await asked()).toEqual(['Silhouette au sommet'])
  })
})

describe('ce qu’il n’a rien à demander', () => {
  it('écarte un nœud qu’aucun libellé ne nomme', async () => {
    // Rien à dire au modèle, et « entité sans nom » n'est pas une description
    // dont on puisse reconnaître quelqu'un.
    await createEntity(world, 'character', 1)
    expect(await asked()).toEqual([])
  })

  it('écarte un nœud qui n’est pas accepté', async () => {
    const proposed = await createEntity(world, 'character', 1)
    await addLabel(world, proposed, 'Ombre au loin', 'placeholder', 1, 10)
    await raw`UPDATE entities SET review_status = 'rejected' WHERE id = ${proposed}`

    expect(await asked()).toEqual([])
  })
})
