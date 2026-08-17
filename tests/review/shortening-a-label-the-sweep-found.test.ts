import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { applyFinding, openFindings, sweepStory } from '@/domains/review/audit-run.ts'
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
 * Le balayage trouve un libellé qui raconte, et le bouton le raccourcit.
 *
 * La règle se teste sans base, dans audit.test.ts. Ce qui se teste ici est la
 * moitié qui écrit, et elle n'est pas un UPDATE : un nom se replie s'il existe
 * déjà, l'ancienne formulation descend sous le rang d'affichage, le glossaire
 * apprend la forme retenue. `renameEntityLabel` fait tout cela et ouvre sa
 * propre transaction, ce qui est précisément pourquoi cette correction ne vit
 * pas dans celle des autres.
 *
 * Et la propriété qui compte autant que l'écriture : relancer le balayage ne
 * repropose pas ce qui vient d'être corrigé. Un constat qui revient après avoir
 * été appliqué transforme la page en liste qui ne raccourcit jamais.
 */

let world: SeededWorld

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([173])
})

afterAll(async () => {
  await closeDb()
})

const VERBOSE = 'Escargophone utilisé par Crocodile pour contacter les Billions'

async function verboseFindings() {
  const findings = await openFindings(world.userId, world.workId)
  return findings.filter((finding) => finding.kind === 'libelle_verbeux')
}

describe('raccourcir un libellé que le balayage a trouvé', () => {
  it('écrit le nom court, garde l’ancien sans l’afficher, et ne le repropose pas', async () => {
    const entityId = await createEntity(world, 'object', 173)
    await addLabel(world, entityId, VERBOSE, 'placeholder', 173, 10)

    await sweepStory(world.userId, world.workId)

    const [finding] = await verboseFindings()
    expect(finding?.fix).toMatchObject({
      action: 'raccourcir_libelle',
      label: 'Escargophone',
    })

    const applied = await applyFinding(world.userId, finding!.id)
    expect(applied.ok).toBe(true)

    const labels = (await raw`
      SELECT label, precedence FROM entity_labels
       WHERE entity_id = ${entityId}
       ORDER BY precedence DESC
    `) as unknown as Array<{ label: string; precedence: number }>

    expect(labels.map((row) => row.label)).toEqual(['Escargophone', VERBOSE])
    // La phrase reste trouvable par la recherche et ne s'affiche plus nulle
    // part : c'est aussi ce qui fait qu'un second balayage se tait.
    expect(labels[1]?.precedence).toBe(5)

    await sweepStory(world.userId, world.workId)
    expect(await verboseFindings()).toEqual([])
  })

  it('refuse deux fois le même constat', async () => {
    const entityId = await createEntity(world, 'object', 173)
    await addLabel(world, entityId, VERBOSE, 'placeholder', 173, 10)
    await sweepStory(world.userId, world.workId)

    const [finding] = await verboseFindings()
    expect((await applyFinding(world.userId, finding!.id)).ok).toBe(true)

    const again = await applyFinding(world.userId, finding!.id)
    expect(again.ok).toBe(false)
    expect(again.message).toContain('déjà tranché')
  })
})
