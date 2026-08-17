import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getStoryPage } from '@/domains/temporal/story.ts'
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
 * « Homme mystérieux debout sur l'eau → Wapol », sur le fil.
 *
 * Le fil sait annoncer une révélation de nom depuis toujours, et le lecteur la
 * voit : une flèche, l'ancien nom barré, le nouveau à côté. Mais elle ne
 * couvrait qu'une seule des deux formes que prend une révélation.
 *
 *   Un nœud, deux libellés. « Klahadore » au 23, « Kuro » au 26 : un libellé
 *   arrive sur quelqu'un qui en avait déjà un, et le fil le dit.
 *
 *   Deux nœuds, une identité. « Homme mystérieux debout sur l'eau » et Wapol
 *   entrent en scène au chapitre 131, et c'est la relation d'identité — pas un
 *   libellé — qui les réunit. Aucun libellé n'est écrit, donc le fil ne disait
 *   rien : le lecteur voyait deux entrées en scène côte à côte, la fiche les
 *   affichait sous un seul nom au chapitre suivant, et rien à l'écran ne
 *   reliait les deux. La même révélation, racontée dans un cas et avalée dans
 *   l'autre.
 *
 * La flèche se lit donc aussi depuis la fusion, et dans les deux sens : `same_as`
 * est symétrique, le côté écrit à gauche est un accident de qui l'a écrit, et
 * c'est le classement des noms — le mieux classé à droite, le moins bien à
 * gauche — qui fait la phrase.
 */

let world: SeededWorld
let silhouette: string
let wapol: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([130, 131])

  silhouette = await createEntity(world, 'character', 131)
  await addLabel(
    world,
    silhouette,
    'Homme mystérieux debout sur l’eau',
    'placeholder',
    131,
    10,
  )

  wapol = await createEntity(world, 'character', 131)
  await addLabel(world, wapol, 'Wapol', 'true_name', 131, 100)
})

afterAll(async () => {
  await closeDb()
})

async function beatsAt(chapter: number) {
  const page = await getStoryPage(world.userId, world.workId, {
    from: chapter,
    count: 1,
    ceiling: chapter,
  })
  return page.beats
}

describe('une fusion racontée comme un nom', () => {
  it('écrit la flèche de l’ancien nom vers le nouveau', async () => {
    await addAssertion(world, {
      subject: silhouette,
      predicate: 'same_as',
      object: wapol,
      knowledgeFrom: 131,
    })

    const noms = (await beatsAt(131)).filter((beat) => beat.kind === 'nom')

    expect(noms).toHaveLength(1)
    expect(noms[0]!.text).toBe('Wapol')
    expect(noms[0]!.detail).toBe('Homme mystérieux debout sur l’eau')
  })

  it('lit la même flèche quand l’identité est écrite dans l’autre sens', async () => {
    // `same_as` est symétrique et rien ne contraint l'ordre : une identité
    // écrite depuis la fiche de Wapol dit exactement la même chose, et doit se
    // lire pareil.
    await addAssertion(world, {
      subject: wapol,
      predicate: 'same_as',
      object: silhouette,
      knowledgeFrom: 131,
    })

    const noms = (await beatsAt(131)).filter((beat) => beat.kind === 'nom')

    expect(noms).toHaveLength(1)
    expect(noms[0]!.text).toBe('Wapol')
    expect(noms[0]!.detail).toBe('Homme mystérieux debout sur l’eau')
  })

  it('ne dit rien avant le chapitre qui révèle', async () => {
    await addAssertion(world, {
      subject: silhouette,
      predicate: 'same_as',
      object: wapol,
      knowledgeFrom: 131,
    })

    // Une identité datée du 131 est invisible au 130, comme tout le reste : la
    // flèche est une révélation, elle n'a pas le droit d'arriver plus tôt.
    const noms = (await beatsAt(130)).filter((beat) => beat.kind === 'nom')
    expect(noms).toHaveLength(0)
  })

  it('se tait quand la fusion ne déplace aucun nom', async () => {
    /*
     * Deux descriptions d'une même silhouette, rapprochées. C'est une fusion
     * qui vaut d'être faite et ce n'est pas une révélation : personne n'apprend
     * de nom, et « X → X » sur la ligne dont le seul travail est de dire qu'un
     * nom a changé serait du bruit.
     */
    const autre = await createEntity(world, 'character', 131)
    await addLabel(world, autre, 'Homme mystérieux debout sur l’eau', 'placeholder', 131, 10)

    await addAssertion(world, {
      subject: silhouette,
      predicate: 'same_as',
      object: autre,
      knowledgeFrom: 131,
    })

    const noms = (await beatsAt(131)).filter((beat) => beat.kind === 'nom')
    expect(noms).toHaveLength(0)
  })

  it('laisse intacte la révélation portée par un libellé', async () => {
    // L'autre forme, sur le même fil : un nœud, deux noms. Le bras ajouté ne
    // doit pas la doubler.
    const majordome = await createEntity(world, 'character', 130)
    await addLabel(world, majordome, 'Klahadore', 'true_name', 130, 100)
    await addLabel(world, majordome, 'Kuro', 'true_name', 131, 100)

    const noms = (await beatsAt(131)).filter((beat) => beat.kind === 'nom')

    expect(noms.map((beat) => beat.text)).toEqual(['Kuro'])
    expect(noms[0]!.detail).toBe('Klahadore')

    const [rows] = await raw<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM assertions WHERE user_id = ${world.userId}`
    expect(rows?.n).toBe('0')
  })
})
