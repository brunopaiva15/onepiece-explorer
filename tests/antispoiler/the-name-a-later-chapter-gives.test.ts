import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import { getEntitySheet } from '@/domains/temporal/entity-sheet.ts'
import { displayLabel } from '@/domains/temporal/projection.ts'
import { getNarrativeDelta } from '@/domains/temporal/timeline.ts'
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
 * Le majordome s'appelle Klahadore, puis Kuro, et jamais les deux à la fois.
 *
 * C'est la forme que prend la moitié des révélations de One Piece : quelqu'un
 * que le lecteur connaît depuis longtemps sous un nom apprend, à un chapitre
 * précis, qu'il en portait un autre. Bon Clay, Robin, Sabo, chaque imposteur et
 * chaque alias du livre.
 *
 * Le modèle de données a toujours su le dire — un nom est une ligne datée, et
 * la politique de sécurité en cache une dont le chapitre est postérieur à la
 * frontière — mais rien ne pouvait plus l'écrire. Un rapprochement accepté
 * rangeait « Kuro » *sous* « Klahadore », par précaution : une fusion ne doit
 * pas renommer un personnage dans le dos de celui qui la valide. La précaution
 * était bonne et sans issue de secours, alors la fiche disait Klahadore
 * jusqu'au chapitre mille.
 *
 * Ce que ces tests épinglent est donc en deux moitiés, et la seconde est celle
 * qui compte :
 *
 *   Le nom bascule. Répondre « oui, et c'est ici qu'on apprend son nom » écrit
 *   « Kuro » à sa propre précédence, et la fiche le suit.
 *
 *   Il ne bascule qu'à partir de là. Au chapitre 25 la fiche dit Klahadore, et
 *   « Kuro » n'est pas seulement absent du titre : il est absent de la page.
 *   Rien n'a été écrasé, le curseur remonte et redescend.
 *
 * Et la garde qui va avec, parce qu'elle manquait : un nom replié par un
 * rapprochement est un nom sur la fiche, donc il passe le même contrôle que
 * celui qu'une publication crée. Replier une proposition « Kuro » au chapitre
 * 23 affichait Kuro au chapitre 23, en plus petit, sous le bon nom.
 */

const CHAPTER_23 = [
  'Klahadore, the butler of the Kaya mansion, throws Usopp out of the grounds and',
  'forbids him from ever speaking to his mistress again.',
].join(' ')

const CHAPTER_26 = [
  'The butler drops his disguise at last: Klahadore is Kuro, captain of the Black',
  'Cat Pirates, and he means to inherit Kaya’s fortune by having her killed.',
].join(' ')

let world: SeededWorld
/** The character the reader has known since chapter 23, under that name. */
let butler: string
let runAt26: string
let chapter26: string
let runAt23: string
let chapter23: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  butler = await createEntity(world, 'character', 23)
  await addLabel(world, butler, 'Klahadore', 'true_name', 23, 100)

  const first = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 23,
    language: 'en',
    text: CHAPTER_23,
  })
  chapter23 = first.chapterId

  const second = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 26,
    language: 'en',
    text: CHAPTER_26,
  })
  chapter26 = second.chapterId

  runAt23 = await startRun(chapter23)
  runAt26 = await startRun(chapter26)
})

afterAll(async () => {
  await closeDb()
})

async function startRun(chapterId: string): Promise<string> {
  const id = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${id}, ${chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `
  return id
}

async function propose(
  runId: string,
  chapterId: string,
  category: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; fingerprint: string }> {
  const id = randomUUID()
  const fingerprint = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${id}, ${runId}, ${chapterId}, ${world.userId}, ${category}, 50,
      ${raw.json({ evidence: [{ kind: 'text', ref: 'b1', excerpt: 'Klahadore is Kuro' }], confidence: 0.9, ...payload })},
      ${fingerprint}, true, 0.9, 'proposed'
    )
  `
  return { id, fingerprint }
}

/**
 * The chapter names the butler for real, and a rapprochement says who he is.
 *
 * The two cards the pipeline really produces: an entity proposal under the new
 * name, and the question of whether it is somebody already in the graph.
 */
async function proposeTheReveal(
  runId = runAt26,
  chapterId = chapter26,
  label = 'Kuro',
): Promise<{ entity: string; resolution: string }> {
  const entity = await propose(runId, chapterId, 'entity', {
    local_id: 'e1',
    node_type: 'character',
    label,
    label_kind: 'true_name',
    source_term: null,
    naming_confident: true,
  })

  const resolution = await propose(runId, chapterId, 'resolution', {
    candidateLabel: label,
    candidateFingerprint: entity.fingerprint,
    existingEntityId: butler,
    score: 0.8,
    suggestion: 'likely_same',
    signals: [],
    modelVerdict: null,
    modelReasoning: null,
  })

  return { entity: entity.id, resolution: resolution.id }
}

/** The answer the reviewer gives on the rapprochement card, in both shapes. */
function accept(reviewItemId: string, revealsName: boolean, payload?: unknown) {
  return revealsName
    ? {
        reviewItemId,
        decision: 'correct' as const,
        correctedPayload: { ...(payload as object), revealsName: true },
      }
    : { reviewItemId, decision: 'accept' as const }
}

describe('un nom qu’un chapitre plus tard révèle', () => {
  it('fait basculer la fiche à partir du chapitre qui le donne', async () => {
    const items = await proposeTheReveal()

    const result = await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    expect(result.failures).toEqual([])
    // Rien de créé : c'est le même personnage, pas un second nœud.
    expect(result.entitiesCreated).toBe(0)
    expect(result.entitiesMerged).toBe(1)
    // Et le compte qui dit à voix haute que la fiche ne dira plus pareil.
    expect(result.namesRevealed).toBe(1)

    const at25 = await displayLabel(world.userId, 25, butler)
    const at26 = await displayLabel(world.userId, 26, butler)
    const at40 = await displayLabel(world.userId, 40, butler)

    expect(at25?.label).toBe('Klahadore')
    expect(at26?.label).toBe('Kuro')
    expect(at40?.label).toBe('Kuro')
  })

  it('n’écrase pas l’ancien nom : les deux lignes existent, datées', async () => {
    const items = await proposeTheReveal()

    await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    const labels = await raw<
      Array<{ label: string; precedence: number; revealed_in_chapter: number }>
    >`SELECT label, precedence, revealed_in_chapter FROM entity_labels
        WHERE entity_id = ${butler} ORDER BY revealed_in_chapter`

    expect(labels).toHaveLength(2)
    expect(labels[0]).toMatchObject({ label: 'Klahadore', revealed_in_chapter: 23 })
    expect(labels[1]).toMatchObject({ label: 'Kuro', revealed_in_chapter: 26 })
    // À égalité de précédence : c'est la date qui tranche, pas un rang inventé
    // pour l'occasion.
    expect(labels[1]!.precedence).toBe(labels[0]!.precedence)
  })

  it('ne laisse pas « Kuro » sur la fiche du chapitre 25, même en petit', async () => {
    const items = await proposeTheReveal()

    await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    /*
     * La fiche liste tous les noms visibles sous le nom d'affichage, alors
     * vérifier le titre ne suffit pas : le spoiler tiendrait dans la ligne
     * « aussi appelé ».
     */
    const before = await getEntitySheet(world.userId, 25, butler)
    expect(before?.displayLabel).toBe('Klahadore')
    expect(before?.labels.map((row) => row.label)).toEqual(['Klahadore'])

    const after = await getEntitySheet(world.userId, 26, butler)
    expect(after?.displayLabel).toBe('Kuro')
    expect(after?.labels.map((row) => row.label)).toContain('Klahadore')
  })

  it('donne au delta sa phrase : jusqu’ici Klahadore, désormais Kuro', async () => {
    const items = await proposeTheReveal()

    await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    /*
     * Le delta lit deux frontières : ce chapitre pour les noms qu'il donne, et
     * celui d'avant pour ce qu'ils remplacent. Les deux noms étant à la même
     * précédence, c'est la date qui décide lequel est « l'ancien » — sans quoi
     * la ligne dirait « jusqu'ici Kuro, désormais Kuro ».
     */
    const delta = await getNarrativeDelta(world.userId, 26)

    expect(delta?.newNames).toEqual([
      { entityId: butler, label: 'Kuro', kind: 'true_name', previous: 'Klahadore' },
    ])
  })

  it('ne bascule pas quand la réponse est « c’est un autre de ses noms »', async () => {
    const items = await proposeTheReveal()

    const result = await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, false),
    ])

    expect(result.failures).toEqual([])
    expect(result.entitiesMerged).toBe(1)
    expect(result.namesRevealed).toBe(0)

    // Le comportement d'avant, intact : le graphe apprend le nom, la recherche
    // le trouve, et l'affichage ne bouge pas sous le relecteur.
    const at26 = await displayLabel(world.userId, 26, butler)
    expect(at26?.label).toBe('Klahadore')

    const [kuro] = await raw<Array<{ precedence: number }>>`
      SELECT precedence FROM entity_labels
      WHERE entity_id = ${butler} AND label = 'Kuro'`
    expect(kuro!.precedence).toBeLessThan(100)
  })
})

describe('la garde, sur un nom replié comme sur un nom créé', () => {
  it('refuse « Kuro » au chapitre 23, où le lecteur ne l’a pas lu', async () => {
    // Le même rapprochement, trois chapitres trop tôt. La source du 26 est déjà
    // dans la bibliothèque : c'est elle qui rend la question décidable.
    const items = await proposeTheReveal(runAt23, chapter23)

    const result = await publishDecisions(world.userId, runAt23, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    expect(result.entitiesMerged).toBe(0)
    expect(result.namesRevealed).toBe(0)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures[0]!.reason).toContain('chapitre 26')

    // Rien d'écrit : ni le nom, ni la moitié « sûre » du repli.
    const labels = await raw<Array<{ label: string }>>`
      SELECT label FROM entity_labels WHERE entity_id = ${butler}`
    expect(labels.map((row) => row.label)).toEqual(['Klahadore'])

    // Et la carte reste ouverte, pour être répondue autrement.
    const open = await raw<Array<{ status: string }>>`
      SELECT status FROM review_items WHERE id IN (${items.entity}, ${items.resolution})`
    expect(open.map((row) => row.status)).toEqual(['proposed', 'proposed'])
  })

  it('dit que c’est le nom qui bloque, pas un lot déjà décidé', async () => {
    const items = await proposeTheReveal(runAt23, chapter23)

    const result = await publishDecisions(world.userId, runAt23, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    /*
     * Les deux cartes échouent ensemble, et le rapprochement a longtemps eu une
     * seule explication à offrir : « la proposition d'entité a déjà été décidée
     * dans un lot précédent ». Elle est fausse ici, et c'est celle qui dit au
     * relecteur d'abandonner.
     */
    const onResolution = result.failures.find(
      (failure) => failure.reviewItemId === items.resolution,
    )
    expect(onResolution?.reason).toContain('à cause du nom')
    expect(onResolution?.reason).not.toContain('lot précédent')
  })

  it('laisse passer le même nom au chapitre qui l’écrit', async () => {
    // Le contrôle n'est pas un seuil ni un modèle : « Kuro » est dans la source
    // du 26, donc il passe au 26 et à rien avant.
    const items = await proposeTheReveal()

    const result = await publishDecisions(world.userId, runAt26, [
      { reviewItemId: items.entity, decision: 'accept' },
      accept(items.resolution, true),
    ])

    expect(result.failures).toEqual([])
    expect(result.namesRevealed).toBe(1)
  })
})
