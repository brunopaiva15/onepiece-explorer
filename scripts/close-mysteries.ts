/**
 * Referme les questions auxquelles les chapitres déjà lus ont répondu.
 *
 *   pnpm repair:mysteres                    # DIRECT_URL
 *   pnpm repair:mysteres -- --dry-run       # dit ce qu'il ferait, n'écrit rien
 *   pnpm repair:mysteres -- --limit=5       # les cinq plus anciennes, pour voir
 *   TEST_DB=1 pnpm repair:mysteres          # base de test
 *
 * Le nom suit celui des autres réparations parce que le bouton les appelle par
 * leur nom : `.github/workflows/repair.yml` interpole `pnpm repair:<script>`,
 * et c'est de là que celle-ci se lance sur la bibliothèque en production.
 *
 * Le rattrapage, une fois. Publier « résout le mystère » referme désormais la
 * question dans sa propre ligne — mais une bibliothèque importée avant que ce
 * prédicat ne soit jamais proposé porte des questions que l'histoire a closes
 * depuis longtemps et que personne n'a écrites : cinquante-neuf chapitres, une
 * question sur Cabaji posée au 16 et tranchée au 17, et « Refermées » vide.
 *
 * Ce qu'il fait, question par question : il donne au modèle la question et les
 * scènes publiées des chapitres suivants, et lui demande d'y répondre en citant
 * ses sources — l'appel de l'assistant, tel quel. Une réponse sourcée par une
 * scène postérieure, c'est une question à laquelle l'histoire a répondu, et la
 * scène citée est la réponse. « insufficient_data » la laisse ouverte.
 *
 * Ce qu'il écrit alors, ce sont les deux moitiés du même fait : la relation
 * « résout le mystère » de la scène vers la question, et l'état de la question.
 * Rien d'autre. Il ne crée aucune entité, ne touche à aucun chapitre, et ne
 * rouvre jamais rien.
 *
 * Trois limites, dites plutôt que tues :
 *
 *   C'est un jugement de machine, et il est enregistré comme tel —
 *   « inferred_strong », « proposed_by = 'ai' ». La fiche de la question montre
 *   la scène qui la referme : une erreur est visible là et se défait en
 *   supprimant la relation.
 *
 *   La relation n'a pas de preuve citée. Sa source est la scène elle-même, qui
 *   est un nœud du graphe daté par le chapitre où il a été publié — les
 *   événements n'en portent pas davantage. C'est plus faible qu'une assertion
 *   extraite d'une page, et c'est pourquoi le sujet est la scène et non le
 *   personnage : le lecteur peut lire ce qui referme la question.
 *
 *   Le curseur du lecteur ne le protège de rien ici : le script lit toute la
 *   bibliothèque publiée. C'est sans conséquence — la date écrite est celle de
 *   la scène qui répond, et la projection masque une résolution postérieure au
 *   chapitre où le lecteur se trouve.
 *
 *   Il demande un modèle qui lise vraiment, et refuse de tourner sans. Les modes
 *   synthétique et replay répondent en comparant des mots ; leurs verdicts
 *   entreraient dans le graphe avec l'aplomb des vrais.
 *
 * Ré-exécutable : il ne regarde que les questions dont `resolved_in_chapter` est
 * nul, et une seconde passe ne les redemande donc pas.
 *
 * `--conditions=react-server` dans le script pnpm n'est pas décoratif : les
 * modules qui atteignent un modèle sont marqués `server-only`, et c'est ce
 * drapeau qui résout le marqueur hors de Next.
 */
import '../src/lib/load-env.ts'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { modelProvider } from '../src/domains/ai/index.ts'
import { ClaudeAgentError } from '../src/domains/ai/claude-agent/runtime.ts'
import { resolvingScene, scenesFor, type Scene } from '../src/domains/review/mystery-sweep.ts'

/**
 * Combien d'échecs d'affilée avant d'admettre que ce n'est pas la question.
 *
 * Trois, comme la page : une panne isolée se saute, une panne qui se répète est
 * une panne du montage, et poursuivre cent trente fois contre elle ne fait que
 * remplir un journal. Le compteur est remis à zéro par chaque succès, donc une
 * question difficile de temps en temps n'arrête rien.
 */
const CONSECUTIVE_LIMIT = 3

const dryRun = process.argv.includes('--dry-run')
const limitFlag = process.argv.find((arg) => arg.startsWith('--limit='))
const limit = limitFlag ? Number.parseInt(limitFlag.slice('--limit='.length), 10) : Infinity

if (Number.isNaN(limit) || limit <= 0) {
  console.error('--limit attend un entier positif.')
  process.exit(1)
}

const testDb = process.env.TEST_DB === '1'
const url = testDb
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

interface OpenQuestion {
  entity_id: string
  user_id: string
  work_id: string
  question: string
  opened_in_chapter: number
}

interface SceneRow {
  entity_id: string
  summary: string | null
  chapter: number
}

/**
 * Le dernier chapitre publié d'une œuvre.
 *
 * C'est jusque-là que le script lit, et pas plus loin : un chapitre importé
 * mais non relu n'est pas de l'histoire lue, ses scènes ne sont pas validées,
 * et une question refermée sur l'une d'elles daterait la réponse d'un chapitre
 * que le lecteur ne voit pas encore.
 */
async function boundaryOf(workId: string): Promise<number> {
  const [row] = await sql<Array<{ boundary: number | null }>>`
    SELECT max(number) AS boundary FROM chapters
     WHERE work_id = ${workId} AND status = 'published'
  `
  return row?.boundary ?? 0
}

async function scenesAfter(
  workId: string,
  userId: string,
  from: number,
  to: number,
): Promise<Scene[]> {
  const rows = await sql<SceneRow[]>`
    SELECT e.entity_id, e.summary,
           coalesce(e.shown_in_chapter, e.told_in_chapter) AS chapter
      FROM events e
     WHERE e.work_id = ${workId}
       AND e.user_id = ${userId}
       AND coalesce(e.shown_in_chapter, e.told_in_chapter) > ${from}
       AND coalesce(e.shown_in_chapter, e.told_in_chapter) <= ${to}
     ORDER BY chapter
  `

  return rows
    .filter((row): row is SceneRow & { summary: string } => (row.summary ?? '').trim().length > 0)
    .map((row) => ({ entityId: row.entity_id, chapter: row.chapter, summary: row.summary }))
}

async function close(
  question: OpenQuestion,
  verdict: { sceneId: string; chapter: number },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO assertions (
        id, work_id, user_id, subject_entity_id, predicate, object_entity_id,
        knowledge_from_chapter, observed_in_chapter, confidence,
        epistemic_status, review_status, proposed_by, pipeline_version
      ) VALUES (
        ${randomUUID()}, ${question.work_id}, ${question.user_id}, ${verdict.sceneId},
        'resolves_mystery', ${question.entity_id},
        ${verdict.chapter}, ${verdict.chapter}, 0.8,
        'inferred_strong', 'accepted', 'ai', 'sweep'
      )
    `
    await tx`
      UPDATE mysteries
         SET state = 'resolved', resolved_in_chapter = ${verdict.chapter}
       WHERE entity_id = ${question.entity_id}
         AND resolved_in_chapter IS NULL
    `
  })
}

async function main(): Promise<void> {
  const questions = await sql<OpenQuestion[]>`
    SELECT entity_id, user_id, work_id, question, opened_in_chapter
      FROM mysteries
     WHERE resolved_in_chapter IS NULL
     ORDER BY opened_in_chapter, question
  `

  if (questions.length === 0) {
    console.log('Aucune question ouverte : rien à refermer.')
    return
  }

  const selected = questions.slice(0, limit === Infinity ? undefined : limit)
  console.log(
    `${questions.length} question(s) ouverte(s)` +
      (selected.length < questions.length ? `, ${selected.length} examinée(s)` : '') +
      (dryRun ? ' — essai à blanc, rien ne sera écrit.' : '.'),
  )

  /*
   * Un fournisseur qui ne lit pas ne referme rien.
   *
   * Le mode synthétique répond en comptant les mots communs entre la question et
   * chaque scène, et il rend des citations comme les autres. Sur cette base
   * « Où se trouve le trésor que Gold Roger a laissé derrière lui ? » se
   * refermerait sur la première scène contenant le mot « trésor » — un verdict
   * faux, écrit dans le graphe avec l'aplomb d'un vrai, sur une question dont la
   * réponse est le sujet de toute l'œuvre. Le mode replay a le même défaut par
   * un autre chemin : il répond ce qu'une autre question a fait enregistrer.
   *
   * C'est la seule vérification qui doit exister ici plutôt que dans la règle :
   * tout le reste du script se contente de ce que le modèle dit, et ce garde-fou
   * est ce qui rend cette confiance défendable.
   */
  const provider = modelProvider()
  if (
    provider.name !== 'claude-max' &&
    provider.name !== 'anthropic' &&
    provider.name !== 'local'
  ) {
    console.error(
      `Fournisseur « ${provider.name} » : il ne lit pas les scènes, il compare des mots.\n` +
        'Refermer une question demande de la comprendre. Configurez CLAUDE_CODE_OAUTH_TOKEN ' +
        '(`claude setup-token`), ou ANTHROPIC_API_KEY, ou LOCAL_AI_BASE_URL et LOCAL_AI_MODEL ' +
        'pour un modèle auto-hébergé.',
    )
    process.exitCode = 1
    return
  }

  const boundaries = new Map<string, number>()
  let closed = 0
  let left = 0
  let failed = 0
  let consecutive = 0
  let stopped = false
  let costCents = 0

  for (const question of selected) {
    if (!boundaries.has(question.work_id)) {
      boundaries.set(question.work_id, await boundaryOf(question.work_id))
    }
    const boundary = boundaries.get(question.work_id)!

    const { offered, dropped } = scenesFor(
      await scenesAfter(
        question.work_id,
        question.user_id,
        question.opened_in_chapter,
        boundary,
      ),
    )

    if (offered.length === 0) {
      left++
      console.log(`  · ch.${question.opened_in_chapter} — ${question.question}`)
      console.log('      aucune scène publiée après elle : laissée ouverte.')
      continue
    }

    let result: Awaited<ReturnType<typeof provider.answer>>
    try {
      result = await provider.answer({
        question: question.question,
        /*
         * Des scènes, là où l'assistant passe des assertions. Le champ porte son
         * nom parce que c'est ce que l'assistant y met ; ce que la fonction en
         * fait est plus général — un identifiant, un chapitre, une phrase datée,
         * et l'obligation de citer l'identifiant. Une scène est exactement cela,
         * et c'est aussi ce qui répond à une question d'histoire : « Zoro achève
         * Cabaji » est un événement, pas une relation.
         */
        context: offered.map((scene) => ({
          assertionId: scene.entityId,
          chapter: scene.chapter,
          statement: scene.summary,
          excerpt: null,
        })),
        boundaryChapter: boundary,
      })
      consecutive = 0
    } catch (error: unknown) {
      failed++
      consecutive++
      /*
       * Tout sur la même sortie, et la taille avec.
       *
       * `console.error` écrit sur un autre flux que `console.log`, et les deux
       * arrivent entrelacés dans le journal d'une Action : le premier run avec
       * ces messages a affiché « 3 échecs de suite : le balayage s'arrête »
       * *avant* l'échec qui l'avait déclenché. Un journal dont l'ordre ment sur
       * la causalité est pire qu'un journal avare.
       *
       * Et le nombre de scènes, parce que c'est la seule variable qui distingue
       * ces appels les uns des autres : un CLI qui meurt sans un mot ne dit rien,
       * mais si ce sont toujours les plus gros envois qui meurent, la ligne le
       * dira au run suivant sans qu'il faille instrumenter quoi que ce soit.
       */
      console.log(`  · ch.${question.opened_in_chapter} — ${question.question}`)
      console.log(`      ${offered.length} scènes envoyées.`)
      console.log(`      échec : ${error instanceof Error ? error.message : String(error)}`)

      if (condemnsTheRest(error)) {
        console.log(
          '      cette panne vaudra pour toutes les suivantes : le balayage s’arrête ici. ' +
            'Les questions déjà refermées le restent ; relancez quand la cause est levée.',
        )
        stopped = true
        break
      }

      if (consecutive >= CONSECUTIVE_LIMIT) {
        console.log(
          `      ${CONSECUTIVE_LIMIT} échecs de suite : le balayage s’arrête plutôt que de ` +
            'poursuivre contre une panne qui ne passe pas. Les questions déjà refermées ' +
            'le restent ; relancez pour reprendre les autres.',
        )
        stopped = true
        break
      }

      console.log('      le balayage continue — elle reste ouverte et sera reposée.')
      continue
    }

    costCents += result.usage.costCents

    const verdict = result.refusal
      ? null
      : resolvingScene(
          {
            insufficientData: result.value.insufficient_data,
            citations: result.value.citations.map((citation) => ({
              assertionId: citation.assertion_id,
              chapter: citation.chapter,
            })),
          },
          offered,
          question.opened_in_chapter,
        )

    console.log(`  · ch.${question.opened_in_chapter} — ${question.question}`)
    if (dropped > 0) {
      console.log(`      ${offered.length} scènes lues, ${dropped} non lues (plafond).`)
    }

    if (verdict === null) {
      left++
      console.log('      laissée ouverte.')
      continue
    }

    const scene = offered.find((candidate) => candidate.entityId === verdict.sceneId)!
    console.log(`      refermée au chapitre ${verdict.chapter} : ${scene.summary}`)
    if (!dryRun) await close(question, verdict)
    closed++
  }

  console.log('')
  console.log(
    `${closed} refermée(s), ${left} laissée(s) ouverte(s)` +
      (failed > 0 ? `, ${failed} en échec` : '') +
      (dryRun ? ' — essai à blanc : rien n’a été écrit.' : '.'),
  )
  if (failed > 0) {
    console.log(
      'Les questions en échec n’ont rien changé : elles restent ouvertes et une ' +
        'relance les reposera.',
    )
  }
  console.log(`Coût des appels : ${(costCents / 100).toFixed(2)} $.`)

  // Un balayage qui s'est arrêté avant la fin, ou qui a laissé des questions
  // sans réponse faute d'avoir pu demander, n'est pas un succès : le bouton des
  // Actions doit le montrer en rouge plutôt qu'en vert.
  if (stopped || failed > 0) process.exitCode = 1
}

/**
 * Cette panne emporte-t-elle aussi les questions qu'on n'a pas encore posées ?
 *
 * La même règle que `/mysteres`, et pour la même raison — sauf qu'ici elle
 * manquait. Le script n'avait aucun `try` autour de l'appel : la première panne,
 * quelle qu'elle fût, emportait tout le reste. Mesuré sur un runner — quatre
 * questions refermées, la cinquième rencontrant un CLI mort sans un mot, et
 * cent vingt-six qui n'ont jamais été posées à cause d'elle, alors que l'erreur
 * elle-même se déclarait `retryable`.
 *
 * Quatre genres condamnent la suite, et ce sont ceux qui décrivent l'accès
 * plutôt que la requête : un jeton refusé, une allocation épuisée, un hébergeur
 * qui ne fournit pas la machine, un hôte où Claude Code n'est pas installable.
 * Le reste n'engage que la question rencontrée.
 */
function condemnsTheRest(error: unknown): boolean {
  if (!(error instanceof ClaudeAgentError)) return false

  return (
    error.kind === 'auth' ||
    error.kind === 'quota' ||
    error.kind === 'billing' ||
    error.kind === 'runtime'
  )
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => sql.end())
