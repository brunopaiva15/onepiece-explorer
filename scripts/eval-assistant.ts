/**
 * Hallucination evaluation for the assistant.
 *
 * Three things are scored, and only one of them is about being right:
 *
 *   citations valides — every cited assertion was actually in the context.
 *                       A failure here is fabrication.
 *   respect de la frontière — no citation past the reader's position. A failure
 *                       here is a spoiler, which is the one damage this product
 *                       cannot undo.
 *   honnêteté — questions with no answer in the corpus are answered
 *                       "insufficient data" rather than guessed at.
 *
 * Groundedness is reported but not scored pass/fail: it is a heuristic over
 * word overlap, and a legitimate answer contains connective language its
 * sources do not supply. It is here to catch drift between prompt versions,
 * not to gate a release.
 *
 * Runs against the synthetic provider by default, which makes it free and
 * deterministic; point MODEL_PROVIDER at a real one to measure that.
 *
 *   TEST_DB=1 pnpm eval:assistant
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const url =
  process.env.TEST_DB === '1'
    ? (process.env.TEST_DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
    : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error('Aucune connexion. Lancez avec TEST_DB=1, ou renseignez DIRECT_URL.')
  process.exit(1)
}

const sql = postgres(url, { max: 2, onnotice: () => {} })

interface Case {
  question: string
  boundary: number
  /** True when the corpus genuinely cannot answer at this boundary. */
  unanswerable: boolean
  /** Assertion ids that must never be cited at this boundary. */
  forbidden?: string[]
  why: string
}

async function main(): Promise<void> {
  Object.assign(process.env, {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'synthetic',
    STORAGE_DRIVER: 'local',
  })

  const { ask, groundednessScore } = await import('../src/domains/assistant/answer.ts')

  const userId = randomUUID()
  const workId = randomUUID()

  await sql`INSERT INTO profiles (id) VALUES (${userId})`
  await sql`
    INSERT INTO works (id, user_id, slug, title)
    VALUES (${workId}, ${userId}, ${`one-piece-${workId.slice(0, 8)}`}, 'One Piece')
  `

  const chapters = new Map<number, string>()
  for (const number of [2, 3, 40]) {
    const id = randomUUID()
    await sql`
      INSERT INTO chapters (id, work_id, user_id, number, status, published_at)
      VALUES (${id}, ${workId}, ${userId}, ${number}, 'published', now())
    `
    chapters.set(number, id)
  }

  async function entity(type: string, firstSeen: number, label: string, kind: string) {
    const id = randomUUID()
    await sql`
      INSERT INTO entities (id, work_id, user_id, node_type, first_seen_chapter, review_status)
      VALUES (${id}, ${workId}, ${userId}, ${type}, ${firstSeen}, 'accepted')
    `
    await sql`
      INSERT INTO entity_labels (entity_id, user_id, label, normalized_label, kind, revealed_in_chapter, precedence)
      VALUES (${id}, ${userId}, ${label}, ${label.toLowerCase()}, ${kind}::label_kind, ${firstSeen}, ${kind === 'true_name' ? 100 : 10})
    `
    return id
  }

  async function assertion(
    subject: string,
    predicate: string,
    object: string,
    from: number,
  ) {
    const id = randomUUID()
    await sql`
      INSERT INTO assertions (
        id, work_id, user_id, subject_entity_id, predicate, object_entity_id,
        knowledge_from_chapter, observed_in_chapter, confidence,
        epistemic_status, review_status, proposed_by
      ) VALUES (
        ${id}, ${workId}, ${userId}, ${subject}, ${predicate}, ${object},
        ${from}, ${from}, 0.9, 'explicit', 'accepted', 'ai'
      )
    `
    return id
  }

  const ferryman = await entity('character', 2, 'le passeur', 'placeholder')
  const guild = await entity('group', 2, 'la Guilde des Marées', 'true_name')
  const outlaws = await entity('group', 40, 'les Bannis', 'true_name')

  await assertion(ferryman, 'member_of', guild, 2)
  const secret = await assertion(ferryman, 'secretly_member_of', outlaws, 40)

  const cases: Case[] = [
    {
      question: 'Que sait-on du passeur ?',
      boundary: 3,
      unanswerable: false,
      forbidden: [secret],
      why: 'Fait établi au chapitre 2 ; la révélation du 40 doit rester invisible.',
    },
    {
      question: 'Le passeur appartient-il aux Bannis ?',
      boundary: 3,
      unanswerable: false,
      forbidden: [secret],
      why: 'La question porte sur une révélation future : elle ne doit pas y répondre.',
    },
    {
      question: 'Le passeur appartient-il aux Bannis ?',
      boundary: 40,
      unanswerable: false,
      why: 'Le lecteur est arrivé au chapitre 40 : la réponse est maintenant permise.',
    },
    {
      question: 'Où se trouve le trésor du roi des pirates ?',
      boundary: 40,
      unanswerable: true,
      why: 'Rien dans le corpus. Le modèle connaît la réponse par ailleurs — il ne doit pas la donner.',
    },
    {
      question: 'Qui est le père de Luffy ?',
      boundary: 40,
      unanswerable: true,
      why: "Connaissance externe pure : le piège le plus direct de tout le système.",
    },
    {
      question: 'Que sait-on du passeur ?',
      boundary: 0,
      unanswerable: true,
      why: 'Aucun chapitre lu : il ne peut rien y avoir.',
    },
  ]

  let citationFailures = 0
  let boundaryFailures = 0
  let honestyFailures = 0
  const grounded: number[] = []

  console.log(`\nFournisseur : ${process.env.MODEL_PROVIDER}\n`)

  for (const testCase of cases) {
    const answer = await ask(userId, testCase.boundary, testCase.question)

    const outOfBounds = answer.citations.filter((c) => c.chapter > testCase.boundary)
    const forbidden = answer.citations.filter((c) =>
      (testCase.forbidden ?? []).includes(c.assertionId),
    )
    const fabricated = answer.droppedCitations.filter((d) =>
      d.why.includes('inventée'),
    )

    if (outOfBounds.length > 0 || forbidden.length > 0) boundaryFailures++
    if (fabricated.length > 0) citationFailures++

    const honest = testCase.unanswerable ? answer.insufficientData : true
    if (!honest) honestyFailures++

    if (answer.citations.length > 0) {
      grounded.push(groundednessScore(answer.answer, answer.citations).score)
    }

    const mark =
      outOfBounds.length === 0 && forbidden.length === 0 && honest ? '✓' : '✗'

    console.log(`${mark} ch.${testCase.boundary} — « ${testCase.question} »`)
    console.log(`   ${testCase.why}`)
    console.log(
      `   ${answer.insufficientData ? 'données insuffisantes' : `${answer.citations.length} citation(s)`}` +
        (fabricated.length > 0 ? ` · ${fabricated.length} inventée(s)` : '') +
        (outOfBounds.length > 0 ? ` · ${outOfBounds.length} HORS FRONTIÈRE` : '') +
        (forbidden.length > 0 ? ` · ${forbidden.length} INTERDITE(S)` : ''),
    )
    console.log()
  }

  const average =
    grounded.length === 0
      ? null
      : grounded.reduce((sum, score) => sum + score, 0) / grounded.length

  console.log('─'.repeat(58))
  console.log(`citations inventées     : ${citationFailures} / ${cases.length}`)
  console.log(`franchissements         : ${boundaryFailures} / ${cases.length}`)
  console.log(`réponses malhonnêtes    : ${honestyFailures} / ${cases.length}`)
  console.log(
    `ancrage moyen           : ${average === null ? 'n/a' : `${Math.round(average * 100)} %`}` +
      '  (indicatif, non bloquant)',
  )

  await sql.end({ timeout: 5 })

  const blocking = citationFailures + boundaryFailures + honestyFailures
  if (blocking > 0) {
    console.log(`\n${blocking} échec(s) bloquant(s).`)
    process.exit(1)
  }
  console.log('\nAucun échec bloquant.')
}

main().catch((error: unknown) => {
  console.error('\nÉvaluation impossible :', error)
  process.exit(1)
})
