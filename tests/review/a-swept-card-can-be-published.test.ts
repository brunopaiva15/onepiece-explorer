import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { identityCard, revealedIdentity } from '@/domains/review/identity-sweep.ts'
import { publishDecisions } from '@/domains/review/publish.ts'
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
 * Une carte écrite par le rattrapage doit être publiable.
 *
 * C'est la moitié du balayage qui peut échouer sans bruit. Sa règle est testée
 * ailleurs, sans base et sans appel payant ; ce qui n'y est pas vérifié, c'est
 * que la carte qu'elle produit **s'ancre** : la référence `b3` doit se résoudre
 * contre les blocs du chapitre, et l'extrait doit se trouver dans le bloc cité.
 * Un déclencheur refuse le contraire, mais il le refuse *au moment de publier* —
 * des jours après l'écriture, dans un lot de vingt autres cartes, sur une
 * réparation qu'on a payée.
 *
 * Le chemin complet est donc joué ici sans modèle : la réponse est fabriquée à
 * la main, la règle en tire une carte, la carte est mise en file comme le script
 * la met, et la publication l'accepte. Ce qui doit sortir au bout est la fusion
 * datée — deux nœuds au chapitre d'avant, un seul à partir de celui qui révèle.
 */

const CHAPITRE_131 = [
  'Un homme se tient debout à la surface de l’eau, immobile, et un navire pirate',
  'surgit soudainement des flots à cet endroit précis.',
].join(' ')

const CHAPITRE_132 = [
  'Le capitaine du navire se présente enfin : c’est Wapol, l’ancien roi de Drum,',
  'et il se met à dévorer le bastingage du Vogue Merry.',
].join(' ')

let world: SeededWorld
let silhouette: string
let wapol: string
let chapter132: string
let runId: string

beforeEach(async () => {
  await resetDatabase()
  world = await seedWorld([])

  await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 131,
    language: 'fr',
    text: CHAPITRE_131,
  })
  const second = await importSummary({
    userId: world.userId,
    workId: world.workId,
    chapterNumber: 132,
    language: 'fr',
    text: CHAPITRE_132,
  })
  chapter132 = second.chapterId

  silhouette = await createEntity(world, 'character', 131)
  await addLabel(world, silhouette, 'Homme mystérieux debout sur l’eau', 'placeholder', 131, 10)

  wapol = await createEntity(world, 'character', 132)
  await addLabel(world, wapol, 'Wapol', 'true_name', 132, 100)

  runId = randomUUID()
  await raw`
    INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
    VALUES (${runId}, ${chapter132}, ${world.userId}, 'succeeded', 'sweep-identities', 'anthropic')
  `
})

afterAll(async () => {
  await closeDb()
})

/**
 * Les passages du chapitre 132, lus comme le script les lit.
 *
 * `b<n>` sur les blocs triés par ordre de lecture, ce que `rebuildRefTable`
 * refera au moment de publier — c'est précisément l'accord entre les deux que ce
 * test met à l'épreuve.
 */
async function passagesOf132() {
  const rows = await raw<Array<{ text: string; position: string }>>`
    SELECT t.text,
           row_number() OVER (ORDER BY t.reading_order) AS position
      FROM text_blocks t
     WHERE t.chapter_id = ${chapter132}
     ORDER BY t.reading_order
  `
  return rows.map((row) => ({
    id: `132:b${row.position}`,
    ref: `b${row.position}`,
    chapter: 132,
    text: row.text,
  }))
}

describe('la carte que le rattrapage écrit', () => {
  it('s’ancre, se publie, et date la fusion du chapitre qui révèle', async () => {
    const passages = await passagesOf132()
    const figure = {
      entityId: silhouette,
      label: 'Homme mystérieux debout sur l’eau',
      firstSeenChapter: 131,
    }
    const options = [{ entityId: wapol, label: 'Wapol', revealedInChapter: 132 }]

    // La réponse qu'un modèle aurait rendue : le nom cité, et la phrase du
    // passage qui l'établit — recopiée depuis le texte réel, ce qui est ce que
    // l'ancrage exige et ce que la règle vérifie avant d'écrire.
    const excerpt = 'c’est Wapol, l’ancien roi de Drum'
    expect(passages.some((passage) => passage.text.includes(excerpt))).toBe(true)

    const finding = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: wapol, excerpt: '' },
          { id: passages[0]!.id, excerpt },
        ],
      },
      figure,
      options,
      passages,
    )

    expect(finding).not.toBeNull()
    expect(finding!.chapter).toBe(132)

    const card = identityCard(figure, finding!, 'Wapol')
    const itemId = randomUUID()
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${itemId}, ${runId}, ${chapter132}, ${world.userId}, 'assertion', 90,
        ${raw.json({ ...card })}, ${randomUUID()}, true, 0.9, 'proposed'
      )
    `

    const result = await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    // Le point du test : aucune raison de refus. Une référence qui ne se résout
    // pas ou un extrait absent de son bloc apparaîtraient ici.
    expect(result.failures).toEqual([])
    expect(result.assertionsCreated).toBe(1)

    const [row] = await raw<Array<{ knowledge_from_chapter: number }>>`
      SELECT knowledge_from_chapter FROM assertions
       WHERE user_id = ${world.userId} AND predicate = 'same_as'`
    expect(row?.knowledge_from_chapter).toBe(132)
  })

  it('porte la citation jusque dans la preuve stockée', async () => {
    const passages = await passagesOf132()
    const excerpt = 'c’est Wapol, l’ancien roi de Drum'
    const figure = {
      entityId: silhouette,
      label: 'Homme mystérieux debout sur l’eau',
      firstSeenChapter: 131,
    }

    const finding = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: wapol, excerpt: '' },
          { id: passages[0]!.id, excerpt },
        ],
      },
      figure,
      [{ entityId: wapol, label: 'Wapol', revealedInChapter: 132 }],
      passages,
    )

    const itemId = randomUUID()
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${itemId}, ${runId}, ${chapter132}, ${world.userId}, 'assertion', 90,
        ${raw.json({ ...identityCard(figure, finding!, 'Wapol') })},
        ${randomUUID()}, true, 0.9, 'proposed'
      )
    `

    await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    /*
     * La preuve est ce qui rend la fusion vérifiable après coup : la fiche
     * montre la phrase, et c'est elle qui distingue « le graphe l'affirme » de
     * « le chapitre le dit ». Une preuve rattachée à son bloc est aussi ce que
     * le déclencheur exige.
     */
    const [evidence] = await raw<Array<{ excerpt: string; text_block_id: string | null }>>`
      SELECT ev.excerpt, ev.text_block_id FROM evidence ev
       JOIN assertions a ON a.id = ev.assertion_id
      WHERE a.predicate = 'same_as' AND a.user_id = ${world.userId}`

    expect(evidence?.excerpt).toBe(excerpt)
    expect(evidence?.text_block_id).not.toBeNull()
  })

  it('donne au lecteur deux nœuds au 131 et un seul au 132', async () => {
    const passages = await passagesOf132()
    const figure = {
      entityId: silhouette,
      label: 'Homme mystérieux debout sur l’eau',
      firstSeenChapter: 131,
    }
    const finding = revealedIdentity(
      {
        insufficientData: false,
        citations: [
          { id: wapol, excerpt: '' },
          { id: passages[0]!.id, excerpt: 'c’est Wapol, l’ancien roi de Drum' },
        ],
      },
      figure,
      [{ entityId: wapol, label: 'Wapol', revealedInChapter: 132 }],
      passages,
    )

    const itemId = randomUUID()
    await raw`
      INSERT INTO review_items (
        id, run_id, chapter_id, user_id, category, priority, payload,
        proposal_fingerprint, requires_explicit_review, confidence, status
      ) VALUES (
        ${itemId}, ${runId}, ${chapter132}, ${world.userId}, 'assertion', 90,
        ${raw.json({ ...identityCard(figure, finding!, 'Wapol') })},
        ${randomUUID()}, true, 0.9, 'proposed'
      )
    `
    await publishDecisions(world.userId, runId, [
      { reviewItemId: itemId, decision: 'accept' },
    ])

    // Ce que tout le dossier vise : la révélation est datée, et le curseur la
    // défait en reculant.
    const before = await getEntitySheet(world.userId, 131, silhouette)
    expect(before?.displayLabel).toBe('Homme mystérieux debout sur l’eau')
    expect(before?.labels.map((row) => row.label)).toEqual([
      'Homme mystérieux debout sur l’eau',
    ])

    const after = await getEntitySheet(world.userId, 132, silhouette)
    expect(after?.displayLabel).toBe('Wapol')
  })
})
