import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import {
  identifyEntities,
  proposeIdentity,
  IdentifyRefusal,
} from '@/domains/knowledge/identify.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
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
 * Le dernier recours : dire à la main que deux fiches sont la même personne.
 *
 * Le chemin normal est en amont — le chapitre qui révèle propose la relation,
 * citée, et un humain la tranche au centre de revue. Mais une révélation portée
 * par une image, une phrase que l'extraction a lue autrement, ou un chapitre
 * publié avant que le prompt ne sache la demander, laissait le lecteur devant
 * deux nœuds qu'il savait être un seul, sans aucun geste à sa disposition.
 *
 * Ce que ces tests épinglent, c'est ce qui distingue ce geste d'une fusion
 * brutale : il est **daté**, il propose sa date **sans la deviner**, et il
 * refuse celles qui rapprocheraient quelque chose que le lecteur n'a pas
 * rencontré.
 */

const CHAPITRE_130 = [
  'Un jour plus tard, Zoro aperçoit un homme qui se tient debout à la surface de',
  'l’eau, parfaitement immobile, et n’en croit pas ses yeux.',
].join(' ')

const CHAPITRE_131 = [
  'Le navire pirate surgit des flots et son capitaine, Wapol, se met à dévorer le',
  'Vogue Merry sous les yeux stupéfaits de tout l’équipage.',
].join(' ')

let world: SeededWorld
let silhouette: string
let wapol: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  for (const [number, text] of [
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

  silhouette = await createEntity(world, 'character', 130)
  await addLabel(world, silhouette, 'Homme mystérieux debout sur l’eau', 'placeholder', 130, 10)

  wapol = await createEntity(world, 'character', 131)
  await addLabel(world, wapol, 'Wapol', 'true_name', 131, 100)
})

afterAll(async () => {
  await closeDb()
})

describe('ce que le rapprochement propose avant d’écrire', () => {
  it('lit la date dans les sources plutôt que de la deviner', async () => {
    const proposal = await proposeIdentity(world.userId, {
      entityId: silhouette,
      otherId: wapol,
    })

    // 131 parce que c'est le premier chapitre dont une source écrit « Wapol » —
    // le 130 parle du même homme sans le nommer.
    expect(proposal.suggestedChapter).toBe(131)
    expect(proposal.suggestedFrom).toBe('Wapol')
    expect(proposal.earliest).toBe(131)
    expect(proposal.alreadyJoined).toBeNull()
  })

  it('n’avance aucun nombre quand aucune source ne porte le nom', async () => {
    const sansNom = await createEntity(world, 'character', 130)
    await addLabel(world, sansNom, 'Ombre au sommet', 'placeholder', 130, 10)

    const proposal = await proposeIdentity(world.userId, {
      entityId: silhouette,
      otherId: sansNom,
    })

    // Deux descriptions : rien à chercher dans le texte, et la date sera
    // entièrement celle du lecteur. Dire « je ne sais pas » vaut mieux
    // qu'avancer un chapitre au hasard.
    expect(proposal.suggestedChapter).toBeNull()
    expect(proposal.suggestedFrom).toBeNull()
  })

  it('refuse une fiche avec elle-même', async () => {
    await expect(
      proposeIdentity(world.userId, { entityId: silhouette, otherId: silhouette }),
    ).rejects.toBeInstanceOf(IdentifyRefusal)
  })
})

describe('ce que le rapprochement écrit', () => {
  it('fait basculer la fiche à partir du chapitre, et pas avant', async () => {
    await identifyEntities(world.userId, {
      entityId: silhouette,
      otherId: wapol,
      chapter: 131,
    })

    const before = await getEntitySheet(world.userId, 130, silhouette)
    expect(before?.displayLabel).toBe('Homme mystérieux debout sur l’eau')
    expect(before?.labels.map((row) => row.label)).toEqual([
      'Homme mystérieux debout sur l’eau',
    ])

    const after = await getEntitySheet(world.userId, 131, silhouette)
    expect(after?.displayLabel).toBe('Wapol')
    expect(after?.labels.map((row) => row.label)).toContain(
      'Homme mystérieux debout sur l’eau',
    )
  })

  it('l’écrit comme votre parole, et garde les deux nœuds', async () => {
    await identifyEntities(world.userId, {
      entityId: silhouette,
      otherId: wapol,
      chapter: 131,
    })

    const [row] = await raw<
      Array<{ epistemic_status: string; proposed_by: string; locked: boolean }>
    >`SELECT epistemic_status, proposed_by, locked FROM assertions
        WHERE user_id = ${world.userId} AND predicate = 'same_as'`
    expect(row).toMatchObject({
      epistemic_status: 'user_validated',
      proposed_by: 'user',
      locked: true,
    })

    // La désignation provisoire est ce que le lecteur savait au 130 : la
    // retirer effacerait l'état que la frontière existe pour garder.
    const [kept] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM entities
       WHERE user_id = ${world.userId} AND review_status = 'accepted'`
    expect(kept?.n).toBe('2')
  })

  it('refuse une date antérieure à l’entrée en scène du second nœud', async () => {
    // Datée du 130, l'identité rapprocherait la silhouette de quelqu'un que le
    // lecteur n'a pas encore rencontré — et l'union-find lirait une relation
    // vers une entité que la politique de ligne cache encore.
    await expect(
      identifyEntities(world.userId, {
        entityId: silhouette,
        otherId: wapol,
        chapter: 130,
      }),
    ).rejects.toThrow(/131/)

    const [row] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM assertions WHERE user_id = ${world.userId}`
    expect(row?.n).toBe('0')
  })

  it('ne rejoint pas deux fois', async () => {
    await identifyEntities(world.userId, {
      entityId: silhouette,
      otherId: wapol,
      chapter: 131,
    })

    await expect(
      identifyEntities(world.userId, {
        entityId: silhouette,
        otherId: wapol,
        chapter: 131,
      }),
    ).rejects.toBeInstanceOf(IdentifyRefusal)

    // Et le sens inverse est la même relation : la refuser demande de la
    // chercher dans les deux ordres, ce que `same_as` étant symétrique impose.
    await expect(
      identifyEntities(world.userId, {
        entityId: wapol,
        otherId: silhouette,
        chapter: 131,
      }),
    ).rejects.toBeInstanceOf(IdentifyRefusal)
  })
})
