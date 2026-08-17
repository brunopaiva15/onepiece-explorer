import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withIngest } from '@/db/boundary.ts'
import { knownEntitiesWithin } from '@/domains/pipeline/steps/extract.ts'
import {
  addAssertion,
  addLabel,
  addMystery,
  addPresence,
  closeDb,
  createEntity,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * La liste des entités connues, à mille chapitres.
 *
 * Elle renvoyait *tout* : chaque entité acceptée visible au chapitre. À cent
 * chapitres c'est quelques centaines de lignes et personne ne s'en aperçoit ; à
 * mille c'est la distribution de mille chapitres, et le bloc cesse d'être une
 * liste d'identifiants pour devenir une botte de foin.
 *
 * Ce que ça coûte est précis, et c'est ce qui a rendu le plafond urgent :
 * l'extraction vient d'être priée de proposer « same_as » quand un chapitre
 * révèle qui était une figure, et la figure à retrouver est une description
 * écrite six chapitres plus tôt — une ligne parmi des milliers, sans nom pour la
 * reconnaître. Demander l'identité et enterrer le candidat, c'est ne rien
 * demander.
 *
 * D'où trois groupes, chacun avec sa raison d'être là, et un plafond qui se dit.
 * Ce que ces tests épinglent : les encore-sans-nom passent devant, les questions
 * ouvertes survivent quel que soit leur âge, et une liste coupée l'annonce.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([1, 2, 3, 10, 20])
})

afterAll(async () => {
  await closeDb()
})

const listedAt = (chapterNumber: number) =>
  withIngest((db) =>
    knownEntitiesWithin(db, {
      workId: world.workId,
      userId: world.userId,
      chapterNumber,
    }),
  )

describe('les candidats à une révélation', () => {
  it('range une désignation provisoire à part, et devant le reste', async () => {
    const luffy = await createEntity(world, 'character', 1)
    await addLabel(world, luffy, 'Monkey D. Luffy', 'true_name', 1, 100)

    const silhouette = await createEntity(world, 'character', 2)
    await addLabel(world, silhouette, 'Silhouette au sommet', 'placeholder', 2, 10)

    const { entities } = await listedAt(20)

    const groups = new Map(entities.map((e) => [e.label, e.group]))
    expect(groups.get('Silhouette au sommet')).toBe('unnamed')
    expect(groups.get('Monkey D. Luffy')).toBe('other')

    // L'ordre est le point : un intertitre sous mille lignes est un intertitre
    // que personne n'atteint.
    const order = entities.map((e) => e.label)
    expect(order.indexOf('Silhouette au sommet')).toBeLessThan(
      order.indexOf('Monkey D. Luffy'),
    )
  })

  it('cesse d’en être une dès qu’un vrai nom est révélé', async () => {
    // Le même nœud, avec le nom que le chapitre 10 lui donne : ce n'est plus un
    // candidat, c'est un personnage. Et la bascule suit la frontière — au
    // chapitre 3 le nom n'est pas encore lisible.
    const butler = await createEntity(world, 'character', 2)
    await addLabel(world, butler, 'Le majordome', 'placeholder', 2, 10)
    await addLabel(world, butler, 'Kuro', 'true_name', 10, 100)

    const early = await listedAt(3)
    expect(early.entities.find((e) => e.id === butler)?.group).toBe('unnamed')

    const late = await listedAt(20)
    expect(late.entities.find((e) => e.id === butler)?.group).toBe('other')
  })

  it('trie les provisoires par la dernière fois qu’on les a vues', async () => {
    // Une silhouette vue il y a deux chapitres est un candidat ; une aperçue au
    // chapitre 1 et jamais revue est un décor.
    const vieille = await createEntity(world, 'character', 1)
    await addLabel(world, vieille, 'Ombre au loin', 'placeholder', 1, 10)
    await addPresence(world, vieille, { chapterNumber: 1, kind: 'appearance' })

    const récente = await createEntity(world, 'character', 1)
    await addLabel(world, récente, 'Silhouette au sommet', 'placeholder', 1, 10)
    await addPresence(world, récente, { chapterNumber: 10, kind: 'appearance' })

    const { entities } = await listedAt(20)
    const unnamed = entities.filter((e) => e.group === 'unnamed').map((e) => e.label)

    expect(unnamed).toEqual(['Silhouette au sommet', 'Ombre au loin'])
  })
})

describe('les questions ouvertes', () => {
  it('les garde à part, sans les faire vieillir', async () => {
    /*
     * Une question posée trois cents chapitres plus tôt se referme aussi bien
     * qu'une question d'hier — c'est même la raison pour laquelle les mystères
     * sont dans cette liste. Les classer par récence les aurait fait tomber du
     * plafond dans l'ordre exact où elles deviennent intéressantes.
     */
    const ancienne = await createEntity(world, 'mystery', 1)
    await addLabel(world, ancienne, 'Où est le One Piece ?', 'alias', 1, 10)
    await addMystery(world, ancienne, { question: 'Où est le One Piece ?', openedIn: 1 })

    const { entities } = await listedAt(20)
    expect(entities.find((e) => e.id === ancienne)?.group).toBe('question')
  })

  it('laisse tomber celles que l’histoire a refermées', async () => {
    // Une question résolue n'a plus à être proposée : c'est ce qui garde le
    // groupe assez petit pour être conservé en entier.
    const refermée = await createEntity(world, 'mystery', 1)
    await addLabel(world, refermée, 'Koby a-t-il survécu ?', 'alias', 1, 10)
    await addMystery(world, refermée, {
      question: 'Koby a-t-il survécu ?',
      openedIn: 1,
      state: 'resolved',
      resolvedIn: 2,
    })

    const { entities } = await listedAt(20)
    expect(entities.find((e) => e.id === refermée)?.group).not.toBe('question')
  })
})

describe('le reste, et le plafond', () => {
  it('met devant ceux qu’on vient de voir, puis les mieux reliés', async () => {
    const oublié = await createEntity(world, 'character', 1)
    await addLabel(world, oublié, 'Villageois de passage', 'true_name', 1, 100)
    await addPresence(world, oublié, { chapterNumber: 1, kind: 'appearance' })

    const courant = await createEntity(world, 'character', 1)
    await addLabel(world, courant, 'Zoro', 'true_name', 1, 100)
    await addPresence(world, courant, { chapterNumber: 10, kind: 'appearance' })

    const { entities } = await listedAt(20)
    const others = entities.filter((e) => e.group === 'other').map((e) => e.label)

    expect(others.indexOf('Zoro')).toBeLessThan(others.indexOf('Villageois de passage'))
  })

  it('départage par le degré à récence égale', async () => {
    const isolé = await createEntity(world, 'character', 1)
    await addLabel(world, isolé, 'Passant', 'true_name', 1, 100)
    await addPresence(world, isolé, { chapterNumber: 3, kind: 'appearance' })

    const central = await createEntity(world, 'character', 1)
    await addLabel(world, central, 'Nami', 'true_name', 1, 100)
    await addPresence(world, central, { chapterNumber: 3, kind: 'appearance' })

    /*
     * Deux relations pour Nami, une pour le passant — et il faut les deux pour
     * que le test mesure quelque chose. Une relation unique entre eux donne un
     * degré de 1 à chacun : une arête compte de ses deux côtés, donc « le mieux
     * relié » ne se départage pas avec une seule arête.
     */
    const tiers = await createEntity(world, 'character', 1)
    await addLabel(world, tiers, 'Usopp', 'true_name', 1, 100)
    for (const other of [isolé, tiers]) {
      await addAssertion(world, {
        subject: central,
        predicate: 'knows',
        object: other,
        knowledgeFrom: 3,
      })
    }

    const { entities } = await listedAt(20)
    const others = entities.filter((e) => e.group === 'other').map((e) => e.label)

    // Les deux ont été vus au chapitre 3 ; celui que le graphe traverse passe
    // devant.
    expect(others.indexOf('Nami')).toBeLessThan(others.indexOf('Passant'))
  })

  it('coupe pour de vrai, et dit combien il ne montre pas', async () => {
    /*
     * Le plafond des provisoires est le plus bas des trois — un nœud sans nom
     * cesse d'être un candidat à la révélation après quelques chapitres — donc
     * c'est celui qu'un test peut franchir sans écrire mille lignes.
     *
     * Ce qui est mesuré ici n'est pas le nombre 50 mais le contrat : la liste
     * est plus courte que la vérité, et `total` porte la vérité. C'est ce qui
     * permet au prompt de dire « 50 lignes sur 55 » — sans quoi une troncature
     * se lirait comme un inventaire complet, et « absent de la liste » comme
     * « n'existe pas ».
     */
    for (let index = 0; index < 55; index++) {
      const entity = await createEntity(world, 'character', 1)
      await addLabel(world, entity, `Silhouette ${index}`, 'placeholder', 1, 10)
    }

    const { entities, total } = await listedAt(20)

    expect(total).toBe(55)
    expect(entities.filter((e) => e.group === 'unnamed')).toHaveLength(50)
    expect(entities.length).toBeLessThan(total)
  })

  it('compte tout, même ce qu’il ne montre pas', async () => {
    for (let index = 0; index < 5; index++) {
      const entity = await createEntity(world, 'character', 1)
      await addLabel(world, entity, `Figurant ${index}`, 'true_name', 1, 100)
    }

    const { entities, total } = await listedAt(20)

    // `total` est ce que le prompt annonce pour dire qu'il est tronqué : sous le
    // plafond les deux sont égaux, et c'est justement ce qui fait taire la
    // phrase de troncature.
    expect(total).toBe(5)
    expect(entities).toHaveLength(5)
  })
})
