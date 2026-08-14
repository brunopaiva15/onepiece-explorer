import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildAnchorSources, filterExtraction, type OntologyView } from '@/domains/ai/anchoring.ts'
import type { Extraction } from '@/domains/ai/schemas.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { NODE_TYPES, PREDICATES, checkTypes } from '@/domains/knowledge/ontology.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
import {
  addAssertion,
  addEvent,
  addLabel,
  addMystery,
  closeDb,
  createEntity,
  raw,
  resetDatabase,
  seedWorld,
  type SeededWorld,
} from '../helpers/db.ts'

/**
 * Une question ne répond pas à une question.
 *
 * The card, as it read in review at chapter 120:
 *
 *   MYSTÈRE  Qui a réellement fait exploser le rhum de Dorry ?
 *            résout le mystère
 *   MYSTÈRE  Qui a réellement fait exploser le rhum de Dorry ?
 *
 * The same question on both sides of the arrow, at 80 % confidence, in
 * mandatory explicit review. Nothing stopped it because nothing said it was
 * wrong: `resolves_mystery` was written with `ANY_ENTITY` for its subject, and
 * `ANY_ENTITY` contains `mystery`. Both ends were therefore well typed and the
 * 0006 trigger agreed.
 *
 * The cost is not a stray edge. Accepting a resolution writes
 * `resolved_in_chapter` on the question itself, so /mystères showed
 * « refermée » under a question no chapter had answered — and the reader never
 * met it again on the day the answer really arrived.
 *
 * Four guards, and the fourth is the one that matters for a library already
 * imported: the ontology refuses the type, the extraction refuses a relation
 * whose two ends are one identifier, publication refuses it again once the
 * identifiers are resolved to rows, and migration 0028 undoes what was written
 * before any of them existed.
 */

const REPAIR = path.join(process.cwd(), 'drizzle', '0028_a_question_does_not_answer_itself.sql')

const QUESTION = 'Qui a réellement fait exploser le rhum de Dorry, provoquant sa colère ?'

const SUMMARY = [
  'Usopp demande à Mr. 5 et Miss Valentine s’ils ont mis la bombe dans le rhum de Dorry.',
  '',
  'Ils le confirment, et Usopp comprend enfin qui a trahi les géants.',
].join('\n')

/** An excerpt of the passage above, so the anchoring trigger accepts it. */
const EVIDENCE = [{ kind: 'text', ref: 'b2', excerpt: 'Ils le confirment' }]

let world: SeededWorld
let mysteryId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])
  mysteryId = await createEntity(world, 'mystery', 119)
  await addLabel(world, mysteryId, QUESTION, 'alias', 119, 10)
  await addMystery(world, mysteryId, { question: QUESTION, openedIn: 119 })
})

afterAll(async () => {
  await closeDb()
})

async function storedMystery(
  entityId = mysteryId,
): Promise<{ state: string; resolvedIn: number | null }> {
  const [row] = await raw`
    SELECT state, resolved_in_chapter FROM mysteries WHERE entity_id = ${entityId}
  `
  return { state: row!.state as string, resolvedIn: row!.resolved_in_chapter as number | null }
}

/** A « résout le mystère » card, waiting on a decision like any other. */
async function proposeResolution(
  subject: string,
  chapterNumber: number,
): Promise<{ itemId: string; runId: string }> {
  const imported = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber,
    language: 'fr',
    text: SUMMARY,
  })
  const runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${imported.chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
  `

  const itemId = randomUUID()
  await raw`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${itemId}, ${runId}, ${imported.chapterId}, ${world.userId}, 'assertion', 80,
      ${raw.json({
        subject,
        predicate: 'resolves_mystery',
        object: mysteryId,
        object_value: null,
        epistemic_status: 'explicit',
        evidence: EVIDENCE,
        confidence: 0.8,
      })},
      ${randomUUID()}, true, 0.8, 'proposed'
    )
  `

  return { itemId, runId }
}

describe('l’ontologie : une question n’est pas ce qui répond', () => {
  it('refuse un mystère en sujet de « résout le mystère »', () => {
    const mismatch = checkTypes('resolves_mystery', 'mystery', 'mystery')

    expect(mismatch).not.toBeNull()
    expect(mismatch?.subjectAccepted).toBe(false)
    expect(mismatch?.expectedSubjectTypes).not.toContain('mystery')
  })

  it('accepte la scène qui apporte la réponse', () => {
    expect(checkTypes('resolves_mystery', 'event', 'mystery')).toBeNull()
    // Une personne, une chose, un lieu répondent aussi : ce que le chapitre
    // montre. Seule la question est exclue.
    expect(checkTypes('resolves_mystery', 'character', 'mystery')).toBeNull()
    expect(checkTypes('resolves_mystery', 'object', 'mystery')).toBeNull()
  })

  it('dit la même chose de « réouvre » et de « donne un indice sur »', () => {
    expect(checkTypes('reopens_mystery', 'mystery', 'mystery')?.subjectAccepted).toBe(false)
    expect(checkTypes('hints_at', 'mystery', 'mystery')?.subjectAccepted).toBe(false)
  })
})

describe('l’extraction : une relation joint deux choses', () => {
  const ONTOLOGY: OntologyView = {
    nodeTypes: new Set(NODE_TYPES.map((t) => t.key)),
    predicates: new Set(PREDICATES.map((p) => p.key)),
  }

  const sources = () =>
    buildAnchorSources({
      textBlocks: [{ ref: 'b1', text: 'Ils le confirment, et Usopp comprend enfin.' }],
      descriptions: [],
      allowedRefs: ['b1'],
      tolerateNoise: false,
    })

  const loop = (subject: string, object: string): Extraction => ({
    entities: [],
    assertions: [
      {
        subject,
        predicate: 'resolves_mystery',
        object,
        object_value: null,
        epistemic_status: 'explicit',
        evidence: [{ ref: 'b1', kind: 'text', excerpt: 'Ils le confirment' }],
        confidence: 0.8,
      },
    ],
    events: [],
    mysteries: [],
  })

  it('met en quarantaine une relation dont les deux bouts sont le même identifiant', () => {
    const known = new Set(['11111111-1111-4111-8111-111111111111'])
    const id = '11111111-1111-4111-8111-111111111111'

    const result = filterExtraction(loop(id, id), sources(), ONTOLOGY, known)

    expect(result.accepted.assertions).toHaveLength(0)
    expect(result.quarantined).toHaveLength(1)
    expect(result.quarantined[0]!.reason).toBe('self_reference')
    // La raison doit enseigner : c'est la phrase du panneau qui empêche la
    // prochaine occurrence, pas le code.
    expect(result.quarantined[0]!.detail).toContain('elle-même')
  })

  it('laisse passer la même relation entre deux entités distinctes', () => {
    const scene = '22222222-2222-4222-8222-222222222222'
    const question = '11111111-1111-4111-8111-111111111111'

    const result = filterExtraction(
      loop(scene, question),
      sources(),
      ONTOLOGY,
      new Set([scene, question]),
    )

    expect(result.quarantined).toHaveLength(0)
    expect(result.accepted.assertions).toHaveLength(1)
  })
})

describe('la publication : refusée, et la question reste ouverte', () => {
  it('refuse une question qui se résout elle-même', async () => {
    const { itemId, runId } = await proposeResolution(mysteryId, 120)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    expect(result.assertionsCreated).toBe(0)
    expect(result.mysteriesResolved).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.reason).toContain('elle-même')
    expect(await storedMystery()).toEqual({ state: 'open', resolvedIn: null })
  })

  it('refuse aussi une question qui en résout une autre', async () => {
    const other = await createEntity(world, 'mystery', 119)
    await addLabel(world, other, 'Où Dorry et Broggy se battent-ils depuis cent ans ?', 'alias', 119, 10)
    await addMystery(world, other, {
      question: 'Où Dorry et Broggy se battent-ils depuis cent ans ?',
      openedIn: 119,
    })

    const { itemId, runId } = await proposeResolution(other, 120)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    expect(result.assertionsCreated).toBe(0)
    expect(result.failures).toHaveLength(1)
    expect(await storedMystery()).toEqual({ state: 'open', resolvedIn: null })
  })

  it('publie la scène qui répond vraiment', async () => {
    const scene = await createEntity(world, 'event', 120)
    await addLabel(world, scene, 'Mr. 5 confirme avoir piégé le rhum de Dorry.', 'alias', 120, 10)
    await addEvent(world, scene, {
      summary: 'Mr. 5 confirme avoir piégé le rhum de Dorry.',
      shownIn: 120,
    })

    const { itemId, runId } = await proposeResolution(scene, 120)

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    expect(result.failures).toEqual([])
    expect(result.assertionsCreated).toBe(1)
    expect(result.mysteriesResolved).toBe(1)
    expect(await storedMystery()).toEqual({ state: 'resolved', resolvedIn: 120 })
  })
})

describe('la réparation : ce qui était déjà écrit', () => {
  /**
   * The graph as it stood before any of the guards existed.
   *
   * Written with the type trigger off, which is the only honest way to
   * reproduce it: the database now refuses on insert exactly what this repairs.
   */
  async function seedTheBug(): Promise<{ assertionId: string; itemId: string }> {
    await raw`ALTER TABLE assertions DISABLE TRIGGER assertions_validate_types_trg`
    let assertionId: string
    try {
      assertionId = await addAssertion(world, {
        subject: mysteryId,
        predicate: 'resolves_mystery',
        object: mysteryId,
        knowledgeFrom: 120,
      })
    } finally {
      await raw`ALTER TABLE assertions ENABLE TRIGGER assertions_validate_types_trg`
    }

    await raw`
      UPDATE mysteries SET state = 'resolved', resolved_in_chapter = 120
       WHERE entity_id = ${mysteryId}
    `

    const imported = await importSummary({
      userId: world.userId,
      workId: world.workId,
      chapterNumber: 121,
      language: 'fr',
      text: SUMMARY,
    })
    const runId = randomUUID()
    await raw`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
      VALUES (${runId}, ${imported.chapterId}, ${world.userId}, 'succeeded', 'test', 'replay')
    `
    const itemId = randomUUID()
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${itemId}, ${runId}, ${imported.chapterId}, ${world.userId}, 'assertion', 80,
        ${raw.json({
          subject: mysteryId,
          predicate: 'resolves_mystery',
          object: mysteryId,
          object_value: null,
          epistemic_status: 'explicit',
          evidence: EVIDENCE,
          confidence: 0.8,
        })},
        ${randomUUID()}, true, 0.8, 'proposed'
      )
    `

    return { assertionId, itemId }
  }

  async function repair(): Promise<void> {
    await raw.unsafe(await readFile(REPAIR, 'utf8')).simple()
  }

  it('écarte le lien, rouvre la question et vide la carte de la file', async () => {
    const { assertionId, itemId } = await seedTheBug()

    await repair()

    const [assertion] = await raw`SELECT review_status FROM assertions WHERE id = ${assertionId}`
    const [item] = await raw`SELECT status FROM review_items WHERE id = ${itemId}`

    expect(assertion!.review_status).toBe('rejected')
    expect(item!.status).toBe('rejected')
    // Sans réponse, elle l'a toujours été : la date écrite était celle d'un lien
    // qui ne disait rien.
    expect(await storedMystery()).toEqual({ state: 'open', resolvedIn: null })
  })

  it('laisse debout une résolution que le graphe justifie encore', async () => {
    await seedTheBug()

    const scene = await createEntity(world, 'event', 130)
    await addEvent(world, scene, { summary: 'La vérité sur le rhum.', shownIn: 130 })
    await addAssertion(world, {
      subject: scene,
      predicate: 'resolves_mystery',
      object: mysteryId,
      knowledgeFrom: 130,
    })

    await repair()

    // La boucle disparaît, la vraie réponse reste — et la question porte
    // désormais la date du chapitre qui répond réellement, pas celle du lien
    // vide qui la précédait.
    expect(await storedMystery()).toEqual({ state: 'resolved', resolvedIn: 130 })
  })

  it('est rejouable', async () => {
    await seedTheBug()

    await repair()
    await repair()

    expect(await storedMystery()).toEqual({ state: 'open', resolvedIn: null })
  })
})
