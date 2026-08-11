/**
 * The whole journey, on synthetic pages, without a key.
 *
 *   pnpm demo
 *
 * Always against the local test database — the script sets `TEST_DB=1` itself.
 * That is not a convenience: this inserts three invented chapters and accepts
 * every proposal without review, and doing that to someone's real library
 * because they typed the wrong command would be unforgivable.
 *
 * Import → pipeline → review → publication → graphe → recherche → question,
 * three chapters, printed as it happens. What it demonstrates is the one
 * property that cannot be shown by a screenshot: the same graph, read from
 * three different places in the story, is three different graphs.
 *
 * The pages are the generated fixtures — invented characters, invented text,
 * drawn by `pnpm fixtures:generate`. Nothing here touches One Piece. That is
 * what makes this runnable in CI and on a fresh clone, and it is also the
 * honest limit of the demo: the extraction below is derived from text the
 * generator wrote, not from a model reading a page.
 *
 * Everything is accepted without human review, which the real product never
 * does. A demo that stopped at the review queue would demonstrate the review
 * queue and nothing after it.
 */
import 'dotenv/config'
import { readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const url =
  process.env.TEST_DB === '1'
    ? (process.env.TEST_DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
    : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error(
    'Aucune connexion. Lancez avec TEST_DB=1 pour la base locale, ou renseignez DIRECT_URL.',
  )
  process.exit(1)
}

const sql = postgres(url, { max: 2, onnotice: () => {} })

const CHAPTERS = [
  { number: 1, title: 'Le quai nord', file: 'chapitre-01.pdf' },
  { number: 2, title: 'Le Corbeau', file: 'chapitre-02.pdf' },
  { number: 3, title: 'Douze ans', file: 'chapitre-03.pdf' },
]

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`)
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'ope-demo-'))
  Object.assign(process.env, {
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_ROOT: root,
    // The connection was already resolved above, defaults included; hand the
    // same one to the application modules rather than let them re-derive it.
    ...(process.env.TEST_DB === '1' ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url }),
    // Synthetic rather than replay: the recorded responses cover the test
    // scenarios, and a demo that fails on a cache miss is worse than one that
    // says out loud where its extraction comes from.
    MODEL_PROVIDER: process.env.MODEL_PROVIDER ?? 'synthetic',
  })

  const { importChapter } = await import('../src/domains/ingestion/import.ts')
  const { createRun } = await import('../src/domains/pipeline/runs.ts')
  const { executeRun } = await import('../src/domains/pipeline/execute.ts')
  const { getReviewQueue } = await import('../src/domains/review/queue.ts')
  const { publishDecisions } = await import('../src/domains/review/publish.ts')
  const { projectGraph } = await import('../src/domains/temporal/projection.ts')
  const { search } = await import('../src/domains/search/index.ts')
  const { ask } = await import('../src/domains/assistant/answer.ts')
  const { effectiveModelProvider } = await import('../src/lib/env.ts')
  const { stopQueue } = await import('../src/domains/pipeline/queue.ts')

  console.log(`Fournisseur de modèle : ${effectiveModelProvider()}`)
  if (effectiveModelProvider() !== 'anthropic') {
    console.log(
      "Sans clé Anthropic, l'extraction est dérivée du texte des pages, pas d'une\n" +
        'lecture des images. Le parcours est réel, la lecture ne l’est pas.',
    )
  }

  const userId = randomUUID()
  const workId = randomUUID()

  await sql`INSERT INTO profiles (id) VALUES (${userId})`
  await sql`
    INSERT INTO works (id, user_id, slug, title)
    VALUES (${workId}, ${userId}, ${`demo-${workId.slice(0, 8)}`}, 'Planches de démonstration')
  `

  for (const chapter of CHAPTERS) {
    heading(`Chapitre ${chapter.number} — ${chapter.title}`)

    const fixture = path.join(process.cwd(), 'fixtures', 'generated', chapter.file)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(fixture))
    } catch {
      console.error(`Fixture manquante : ${fixture}\nLancez « pnpm fixtures:generate ».`)
      process.exit(1)
    }

    const imported = await importChapter({
      userId,
      workId,
      chapterNumber: chapter.number,
      title: chapter.title,
      file: { filename: chapter.file, bytes },
    })
    console.log(`  import       ${imported.pages.length} page(s)`)

    const runId = await createRun(userId, imported.chapterId)
    const run = await executeRun(userId, imported.chapterId, runId)
    if (run.status !== 'succeeded') {
      console.error(`  pipeline     échec : ${run.error ?? 'raison inconnue'}`)
      process.exit(1)
    }
    console.log(`  pipeline     ${run.status}`)

    // The queue already excludes decided items; everything it returns is
    // awaiting a human.
    const items = (await getReviewQueue(userId, runId, { limit: 500 }))?.items ?? []

    const published = await publishDecisions(
      userId,
      runId,
      items.map((item) => ({ reviewItemId: item.id, decision: 'accept' as const })),
    )
    console.log(
      `  revue        ${items.length} proposition(s) acceptée(s) sans relecture (démo)`,
    )
    console.log(
      `  publication  ${published.entitiesCreated} entité(s), ` +
        `${published.assertionsCreated} fait(s), ${published.labelsCreated} libellé(s)`,
    )
    if (published.failures.length > 0) {
      for (const failure of published.failures.slice(0, 5)) {
        console.log(`               · non appliqué : ${failure.reason}`)
      }
    }
  }

  /*
   * The point of the whole exercise.
   *
   * The same query, at three boundaries. The ferryman is a description at
   * chapter 1 and a name at chapter 3; the scarf and the hood are two people
   * until chapter 3 says otherwise. Nothing was rewritten in between — the
   * rows are identical, the boundary is the only thing that moved.
   */
  heading('Le même graphe, lu depuis trois endroits de l’histoire')
  for (const boundary of [1, 2, 3]) {
    const graph = await projectGraph(userId, boundary)
    const characters = graph.nodes.filter((node) => node.nodeType === 'character')
    console.log(
      `  chapitre ${boundary} : ${graph.nodes.length} nœud(s), ${graph.edges.length} lien(s)` +
        (graph.mergedAway > 0 ? `, ${graph.mergedAway} fusionné(s)` : ''),
    )
    for (const node of characters.slice(0, 6)) {
      console.log(
        `      ${node.label}` +
          (node.memberIds.length > 1
            ? ` (${node.memberIds.length} identités confondues)`
            : ''),
      )
    }
  }

  heading('Recherche')
  for (const boundary of [1, 3]) {
    const results = await search(userId, boundary, 'Kaelo Renn', { limit: 5 })
    console.log(`  « Kaelo Renn » au chapitre ${boundary} : ${results.hits.length} résultat(s)`)
    for (const hit of results.hits.slice(0, 3)) {
      console.log(`      [${hit.mode}] ch.${hit.chapterNumber} ${hit.title} — ${hit.reason}`)
    }
    if (results.hits.length === 0) {
      console.log(
        '      Rien. Ce nom est révélé au chapitre 3 ; à la frontière 1 il n’existe pas encore.',
      )
    }
  }

  /*
   * The same question at two boundaries.
   *
   * Not for the prose — the synthetic provider's prose is not worth reading.
   * For the citations: at chapter 1 the assistant can only cite chapter 1, and
   * when it has nothing it says so instead of composing something plausible.
   */
  heading('La même question, à deux frontières')
  const question = 'Que sait-on de la Guilde des Marées ?'
  for (const boundary of [1, 3]) {
    const answer = await ask(userId, boundary, question)
    console.log(`  chapitre ${boundary} — ${answer.answer}`)
    for (const citation of answer.citations) {
      console.log(`      ↳ ch.${citation.chapter} « ${citation.excerpt} »`)
    }
    if (answer.droppedCitations.length > 0) {
      console.log(
        `      ${answer.droppedCitations.length} citation(s) écartée(s) : la source n’était pas dans le contexte.`,
      )
    }
    if (answer.insufficientData && answer.citations.length === 0) {
      console.log('      (Données déclarées insuffisantes plutôt que devinées.)')
    }
  }

  await stopQueue()
  await sql.end({ timeout: 5 })
  console.log('\nParcours complet. Les données de démonstration restent en base.')
}

main().catch((error: unknown) => {
  console.error('\nÉchec de la démonstration :', error)
  process.exit(1)
})
