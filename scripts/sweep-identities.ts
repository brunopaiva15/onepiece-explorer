/**
 * Retrouve, dans les chapitres qui suivent, qui étaient les figures sans nom.
 *
 *   pnpm repair:identites                    # DIRECT_URL
 *   pnpm repair:identites -- --dry-run       # dit ce qu'il ferait, n'écrit rien
 *   pnpm repair:identites -- --limit=5       # les cinq plus anciennes, pour voir
 *   TEST_DB=1 pnpm repair:identites          # base de test
 *
 * Le rattrapage, une fois — la dernière pièce. Le mécanisme normal est complet
 * en amont : le chapitre qui révèle propose lui-même « same_as » (prompt '12'),
 * les candidats sont en tête de la liste qu'il reçoit ('13'), un humain tranche
 * au centre de revue, et la fiche offre le geste manuel pour le reste. Rien de
 * tout cela n'aide une bibliothèque **déjà importée** : ses chapitres ont été lus
 * par un prompt qui ne demandait pas l'identité, donc elle porte deux nœuds pour
 * chaque révélation que l'histoire a faite — « Homme mystérieux debout sur
 * l'eau » et Wapol, « Silhouette au sommet » et Chopper, et ainsi de suite.
 *
 * Ce qu'il remplace, c'est `repair:noms` : un tableau de couples relevés à la
 * main, qui ne passe pas l'échelle de mille chapitres. Ici les couples sont
 * trouvés, pas listés.
 *
 * Ce qu'il fait, figure par figure : il donne au modèle la désignation
 * provisoire, les passages des chapitres qui suivent, et les noms qui y
 * apparaissent — puis lui demande lequel est cette figure, en citant la phrase
 * qui le dit. L'appel de l'assistant, tel quel, comme le balayage des mystères.
 *
 * **Ce qu'il écrit n'entre pas dans le graphe.** C'est la différence avec
 * `repair:mysteres`, et elle est voulue : une identité est le seul jugement que
 * l'ontologie place en revue humaine obligatoire, parce qu'une fusion fausse
 * détruit la chronologie des révélations que tout ce système existe pour tenir.
 * Un modèle ne la publie donc pas. Le balayage écrit une **carte de revue** —
 * une assertion « same_as » proposée, avec sa citation — et vous l'acceptez ou la
 * rejetez sur la carte, qui montre les deux nœuds et la phrase.
 *
 * Trois refus, dans la règle plutôt que dans ce fichier — voir
 * `domains/review/identity-sweep.ts`, qui se teste sans base et sans appel :
 * un nom sans phrase citée, une phrase qui ne contient pas l'extrait mot pour
 * mot, un identifiant que le modèle a formé. Et la date vient du passage, jamais
 * de la citation.
 *
 * Trois limites, dites plutôt que tues :
 *
 *   Des personnes et des groupes seulement. Une révélation d'identité porte sur
 *   quelqu'un ou sur une organisation, et le premier passage l'a appris à ses
 *   frais : sans cette borne il a proposé 141 figures dont « Chapeau de paille »,
 *   « Base de la Marine » et « Clé de la cage » — des objets dont le libellé est
 *   le nom, un appel payé chacun pour se faire répondre non. Ce qu'elle laisse de
 *   côté est réel et rare, et reste au geste manuel de la fiche. Voir
 *   `domains/review/identity-candidates.ts`, qui porte la sélection et se teste.
 *
 *   La fenêtre. Quinze chapitres après la rencontre, parce qu'une révélation
 *   arrive d'ordinaire peu après et qu'une bibliothèque de mille chapitres se
 *   pèserait sinon contre elle-même. Une identité révélée deux cents chapitres
 *   plus tard n'est pas trouvée ici : elle reste au geste manuel de la fiche.
 *
 *   Il demande un modèle qui lise vraiment, et refuse de tourner sans. Les modes
 *   synthétique et replay répondent en comparant des mots ; ils proposeraient des
 *   fusions avec l'aplomb des vraies.
 *
 * Et il se perd figure par figure. Le premier passage est mort à la
 * trente-septième d'un « Overloaded » de l'API, en emportant les trente-six
 * appels déjà payés — et, en mode « appliquer », les cartes qu'il restait à
 * écrire. Un appel a maintenant droit à trois tentatives espacées, un échec ne
 * coûte que sa figure, et le compte rendu — dont le coût — sort même si le
 * balayage est interrompu.
 *
 * Ré-exécutable : une figure déjà rejointe, ou déjà portée par une carte en
 * attente, n'est pas redemandée — donc une seconde passe ne repaye pas ce que la
 * première a trouvé.
 *
 * `--conditions=react-server` dans le script pnpm n'est pas décoratif : les
 * modules qui atteignent un modèle sont marqués `server-only`.
 */
import '../src/lib/load-env.ts'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { modelProvider } from '../src/domains/ai/index.ts'
import { unnamedFigures, type UnnamedFigureRow } from '../src/domains/review/identity-candidates.ts'
import {
  identityCard,
  revealedIdentity,
  windowFor,
  SWEEP_WINDOW,
  type IdentityFinding,
  type NamedOption,
  type SweptPassage,
  type UnnamedFigure,
} from '../src/domains/review/identity-sweep.ts'

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
    'Aucune connexion configurée.\n' +
      '  • Production : DIRECT_URL dans .env.local (connexion directe, port 5432).\n' +
      '  • Tests : TEST_DB=1, et TEST_DATABASE_URL si la base n’est pas celle par défaut.',
  )
  process.exit(1)
}

const sql = postgres(url, { max: 2, onnotice: () => {} })

type FigureRow = UnnamedFigureRow

/*
 * Pas de `process.exit(0)` au bout, et c'est le seul détail de plomberie qui
 * mérite un mot : il écraserait le code de sortie que le refus de fournisseur
 * vient de poser, et le bouton de réparation lirait un refus comme un succès.
 * La forme est celle de `close-mysteries` — l'erreur se signale, la connexion se
 * referme, et le code de sortie reste celui que le script a décidé.
 */
main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => sql.end({ timeout: 5 }))

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })

  /*
   * Le seul garde-fou qui doive être ici et non dans la règle.
   *
   * Tout le reste du script se contente de ce que le modèle dit ; c'est ce
   * contrôle qui rend cette confiance défendable. Le mode synthétique répond en
   * comptant les mots communs, donc « Homme mystérieux debout sur l'eau » se
   * rapprocherait du premier nom contenant « homme ». Le mode replay a le même
   * défaut par un autre chemin : il répond ce qu'une autre question a enregistré.
   */
  const provider = modelProvider()
  if (provider.name !== 'anthropic' && provider.name !== 'local') {
    console.error(
      `Fournisseur « ${provider.name} » : il ne lit pas les passages, il compare des mots.\n` +
        'Reconnaître une figure demande de la lire. Configurez ANTHROPIC_API_KEY, ' +
        'ou LOCAL_AI_BASE_URL et LOCAL_AI_MODEL pour un modèle auto-hébergé.',
    )
    process.exitCode = 1
    return
  }

  const figures = await unnamedFigures(sql)
  if (figures.length === 0) {
    console.log('Aucune figure sans nom en attente : rien à rattraper.')
    return
  }

  const selected = figures.slice(0, limit === Infinity ? figures.length : limit)
  console.log(
    `${figures.length} figure(s) encore sans nom` +
      (selected.length < figures.length ? `, ${selected.length} examinée(s)` : '') +
      (dryRun ? ' — dry-run : rien ne sera écrit' : '') +
      '\n',
  )

  let proposed = 0
  let left = 0
  let failed = 0
  let costCents = 0

  /*
   * Le compte rendu, même interrompu.
   *
   * Il était imprimé après la boucle, donc une interruption — la nôtre, un
   * plafond de temps du workflow, un Ctrl-C — emportait le coût avec elle : on
   * avait payé et on ne savait pas combien. Posé ici, il sort quoi qu'il arrive.
   */
  const report = (): void =>
    console.log(
      `\n${proposed} carte(s) proposée(s) · ${left} laissée(s)` +
        (failed > 0 ? ` · ${failed} en échec` : '') +
        ` · ${(costCents / 100).toFixed(2)} $` +
        (dryRun ? ' — rien écrit' : ''),
    )
  process.on('SIGINT', () => {
    report()
    process.exit(130)
  })

  for (const row of selected) {
    const figure: UnnamedFigure = {
      entityId: row.entity_id,
      label: row.label,
      firstSeenChapter: row.first_seen_chapter,
    }

    console.log(`  · ch.${figure.firstSeenChapter} — « ${figure.label} »`)

    const passages = windowFor(figure, await passagesAfter(row), SWEEP_WINDOW)
    const options = await namesWithin(row)

    if (passages.length === 0 || options.length === 0) {
      left++
      console.log(
        `      ${passages.length === 0 ? 'aucun passage' : 'aucun nom'} dans les ` +
          `${SWEEP_WINDOW} chapitres suivants : laissée telle quelle.`,
      )
      continue
    }

    const result = await askWithRetry(provider, {
      question:
        `Une figure entre en scène au chapitre ${figure.firstSeenChapter} sans être ` +
        `nommée ; la bibliothèque l’appelle « ${figure.label} ». Les passages qui ` +
        `suivent viennent des chapitres d’après, et les lignes « nom : » sont les ` +
        `personnes que ces chapitres nomment. L’un de ces noms est-il cette figure ? ` +
        `Si oui, citez l’identifiant du nom ET l’identifiant du passage dont la ` +
        `phrase l’établit, en recopiant cette phrase. Si aucun passage ne l’établit, ` +
        `répondez « insufficient_data » : une ressemblance n’est pas une identité.`,
      /*
       * Deux populations dans un seul contexte, et c'est ce qui permet de
       * réutiliser l'appel de l'assistant sans lui ajouter de méthode. Le champ
       * s'appelle `assertionId` parce que c'est ce que l'assistant y met ; ce
       * que la fonction en fait est plus général — un identifiant à recopier.
       * Le modèle cite donc les deux moitiés de la réponse par le même
       * mécanisme, et la règle les sépare en aval selon la table à laquelle
       * chaque identifiant appartient.
       */
      context: [
        ...options.map((option) => ({
          assertionId: option.entityId,
          chapter: option.revealedInChapter,
          statement: `nom : « ${option.label} », nommé au chapitre ${option.revealedInChapter}`,
          excerpt: null,
        })),
        ...passages.map((passage) => ({
          assertionId: passage.id,
          chapter: passage.chapter,
          statement: passage.text,
          excerpt: null,
        })),
      ],
      boundaryChapter: figure.firstSeenChapter + SWEEP_WINDOW,
    })

    /*
     * Un appel qui échoue ne coûte que sa figure.
     *
     * La première exécution est morte à la trente-septième d'un « Overloaded »
     * de l'API, en emportant les trente-six appels déjà payés — et, en mode
     * « appliquer », elle aurait aussi emporté les cartes qu'il restait à écrire.
     * Un balayage qui se paye figure par figure doit se perdre figure par figure.
     */
    if (result === null) {
      failed++
      console.log('      appel impossible après plusieurs tentatives : passée.')
      continue
    }

    costCents += result.usage.costCents

    const finding = result.refusal
      ? null
      : revealedIdentity(
          {
            insufficientData: result.value.insufficient_data,
            citations: result.value.citations.map((citation) => ({
              id: citation.assertion_id,
              excerpt: citation.excerpt,
            })),
          },
          figure,
          options,
          passages,
        )

    if (finding === null) {
      left++
      console.log('      laissée telle quelle.')
      continue
    }

    const named = options.find((option) => option.entityId === finding.namedEntityId)!
    console.log(
      `      est « ${named.label} » à partir du ch.${finding.chapter} — ` +
        `« ${finding.excerpt} »`,
    )

    if (!dryRun) {
      const queued = await queueCard(row, finding, named.label)
      console.log(
        queued
          ? '      carte de revue écrite : à accepter dans le centre de revue.'
          : '      une carte l’attend déjà.',
      )
    }
    proposed++
  }

  report()
}

/**
 * L'appel, avec le droit d'échouer deux fois.
 *
 * « Overloaded » et les coupures de flux sont des accidents de transport, pas
 * des réponses : les redemander est la bonne conduite, et trois tentatives
 * espacées suffisent à traverser une minute chargée. Ce qui reste en échec après
 * ça rend `null`, et l'appelant passe à la figure suivante — un balayage de cent
 * appels ne doit pas être un pari à cent contre un.
 *
 * Aucune distinction entre les sortes d'erreurs, volontairement. Le message
 * d'une API se reformule, et un balayage qui n'aurait retenté que sur le mot
 * « Overloaded » aurait recommencé à mourir le jour où il devient « overloaded »
 * ou « server_busy ». Une erreur non transitoire coûte deux attentes et finit
 * exactement là où elle aurait fini tout de suite.
 */
async function askWithRetry(
  provider: ReturnType<typeof modelProvider>,
  request: Parameters<ReturnType<typeof modelProvider>['answer']>[0],
): Promise<Awaited<ReturnType<ReturnType<typeof modelProvider>['answer']>> | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await provider.answer(request)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      if (attempt === 3) {
        console.log(`      ${reason}`)
        return null
      }
      console.log(`      tentative ${attempt} échouée, nouvelle dans ${attempt * 5} s`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
    }
  }
  return null
}

/**
 * Les passages des chapitres qui suivent, avec la référence que la publication
 * saura résoudre.
 *
 * `b<n>` est assigné sur les blocs d'un chapitre triés par ordre de lecture,
 * exactement comme `rebuildRefTable` le refera au moment de publier — c'est ce
 * qui fait qu'une citation écrite ici s'ancre là-bas. L'identifiant cité, lui,
 * porte le chapitre en préfixe : `b2` existe dans tous les chapitres, et sans
 * cela une phrase du 134 se daterait du 131.
 */
async function passagesAfter(row: FigureRow): Promise<SweptPassage[]> {
  const rows = await sql<
    Array<{ number: number; text: string; position: number }>
  >`
    SELECT c.number, t.text,
           row_number() OVER (PARTITION BY c.id ORDER BY t.reading_order) AS position
      FROM text_blocks t
      JOIN chapters c ON c.id = t.chapter_id
     WHERE c.work_id = ${row.work_id} AND c.user_id = ${row.user_id}
       AND c.status = 'published'
       AND c.number > ${row.first_seen_chapter}
       AND c.number <= ${row.first_seen_chapter + SWEEP_WINDOW}
     ORDER BY c.number, t.reading_order
  `

  return rows.map((block) => ({
    id: `${block.number}:b${block.position}`,
    ref: `b${block.position}`,
    chapter: Number(block.number),
    text: block.text,
  }))
}

/**
 * Les noms que la fenêtre donne.
 *
 * Bornés à la fenêtre par la date de révélation du nom, et non par l'entrée en
 * scène du nœud : ce qu'on cherche est le chapitre qui *nomme*, et un personnage
 * entré en scène bien avant peut être nommé ici — c'est même le cas de Wapol,
 * dont le nœud et le nom arrivent au même chapitre que la silhouette.
 */
async function namesWithin(row: FigureRow): Promise<NamedOption[]> {
  const rows = await sql<
    Array<{ entity_id: string; label: string; revealed_in_chapter: number }>
  >`
    SELECT DISTINCT ON (l.entity_id)
           l.entity_id, l.label, l.revealed_in_chapter
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE en.work_id = ${row.work_id} AND en.user_id = ${row.user_id}
       AND en.review_status = 'accepted'
       AND en.id <> ${row.entity_id}
       AND en.node_type = (SELECT node_type FROM entities WHERE id = ${row.entity_id})
       AND l.kind = 'true_name'
       AND l.revealed_in_chapter > ${row.first_seen_chapter - 1}
       AND l.revealed_in_chapter <= ${row.first_seen_chapter + SWEEP_WINDOW}
     ORDER BY l.entity_id, l.revealed_in_chapter
  `

  return rows.map((option) => ({
    entityId: option.entity_id,
    label: option.label,
    revealedInChapter: Number(option.revealed_in_chapter),
  }))
}

/**
 * La carte de revue, sur le chapitre qui révèle.
 *
 * Rattachée à un run de ce chapitre — celui qui existe, sinon un créé pour
 * l'occasion — parce que le centre de revue est organisé par run et qu'une carte
 * sans run n'a pas de page où s'afficher. Le chapitre reste publié : `review_items`
 * en attente n'a jamais refermé un chapitre, seul `openIfReviewed` l'ouvre.
 *
 * `requires_explicit_review` à vrai, ce qui est de toute façon ce que l'ontologie
 * dit de `same_as` : la revue automatique ne l'emportera pas dans un lot.
 */
async function queueCard(
  row: FigureRow,
  finding: IdentityFinding,
  namedLabel: string,
): Promise<boolean> {
  const [chapter] = await sql<Array<{ id: string }>>`
    SELECT id FROM chapters
     WHERE work_id = ${row.work_id} AND user_id = ${row.user_id}
       AND number = ${finding.chapter}
     LIMIT 1
  `
  if (!chapter) return false

  const [existing] = await sql<Array<{ id: string }>>`
    SELECT id FROM review_items
     WHERE user_id = ${row.user_id} AND status = 'proposed'
       AND category = 'assertion'
       AND payload->>'subject' = ${row.entity_id}
       AND payload->>'object' = ${finding.namedEntityId}
     LIMIT 1
  `
  if (existing) return false

  const [run] = await sql<Array<{ id: string }>>`
    SELECT id FROM ingestion_runs
     WHERE chapter_id = ${chapter.id} AND user_id = ${row.user_id}
     ORDER BY created_at DESC
     LIMIT 1
  `

  let runId = run?.id
  if (!runId) {
    runId = randomUUID()
    await sql`
      INSERT INTO ingestion_runs (id, chapter_id, user_id, status, pipeline_version, provider)
      VALUES (${runId}, ${chapter.id}, ${row.user_id}, 'succeeded',
              'sweep-identities', 'anthropic')
    `
  }

  await sql`
    INSERT INTO review_items (
      id, run_id, chapter_id, user_id, category, priority, payload,
      proposal_fingerprint, requires_explicit_review, confidence, status
    ) VALUES (
      ${randomUUID()}, ${runId}, ${chapter.id}, ${row.user_id}, 'assertion', 90,
      ${sql.json({
        ...identityCard(
          {
            entityId: row.entity_id,
            label: row.label,
            firstSeenChapter: row.first_seen_chapter,
          },
          finding,
          namedLabel,
        ),
      })},
      ${randomUUID()}, true, 0.9, 'proposed'
    )
  `
  return true
}
