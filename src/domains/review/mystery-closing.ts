import 'server-only'
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { assertions, auditLog, events, mysteries } from '@/db/schema/knowledge.ts'
import { modelProvider } from '@/domains/ai/index.ts'
import { scanForResolution, scenePasses, type Scene } from './mystery-sweep.ts'

/**
 * Le balayage des mystères, une question à la fois.
 *
 * `scripts/close-mysteries.ts` fait déjà cela en boucle, et il continuera : une
 * bibliothèque de soixante-dix questions ouvertes est une heure de travail, ce
 * qui est un travail d'atelier et non de page web. Ce qui manquait, c'est le
 * geste depuis /mystères — « cette question, l'histoire y a-t-elle répondu ? » —
 * et ce module en est la moitié serveur.
 *
 * Une question par appel, délibérément. Un balayage complet dans une seule
 * action serveur, c'est un appel de modèle par question dans une invocation qui
 * en a trois cents secondes : la vingtième question l'interrompt, et ce qui a
 * été écrit avant l'est à moitié, sans rapport. Découpé ainsi, chaque appel est
 * borné par un seul appel de modèle, la page montre l'avancée, et une
 * interruption — un onglet fermé, un réseau qui tombe — laisse derrière elle des
 * questions refermées et des questions intactes, jamais un état intermédiaire.
 *
 * Ce qu'il écrit est ce que le script écrit, aux mêmes conditions : la relation
 * « résout le mystère » de la scène vers la question, et l'état de la question.
 * La règle qui tranche est celle de `mystery-sweep.ts`, partagée avec lui, parce
 * qu'un jugement de machine sur la date d'une réponse est exactement ce qu'il ne
 * faut pas écrire deux fois.
 */

/** Une question encore sans réponse, telle que le bouton la propose. */
export interface OpenQuestion {
  entityId: string
  question: string
  openedInChapter: number
}

/**
 * Ce qu'un appel a décidé d'une question.
 *
 * `already` et `gone` ne sont pas du bruit : la page envoie une liste établie
 * avant le premier appel, et un balayage qui dure dix minutes est dix minutes
 * pendant lesquelles une publication a pu refermer une question ou un chapitre
 * supprimé l'emporter. Les dire plutôt que les compter en « laissée ouverte »
 * évite un rapport qui ment sur ce qu'il a fait.
 */
export type ClosingVerdict =
  | {
      kind: 'closed'
      /** Le chapitre qui répond — celui de la scène, jamais celui du modèle. */
      chapter: number
      sceneId: string
      summary: string
      scenesRead: number
      scenesDropped: number
      costCents: number
    }
  | {
      kind: 'open'
      because: 'no-scenes' | 'unanswered' | 'refused'
      scenesRead: number
      scenesDropped: number
      costCents: number
    }
  | { kind: 'already'; chapter: number }
  | { kind: 'gone' }

/**
 * Un fournisseur qui ne lit pas ne referme rien.
 *
 * Le même refus que dans le script, et pour la même raison : les modes
 * synthétique et replay répondent en comparant des mots, et leurs citations ont
 * la forme des vraies. « Où se trouve le trésor que Gold Roger a laissé derrière
 * lui ? » se refermerait sur la première scène contenant « trésor », dans le
 * graphe, avec l'aplomb d'un verdict.
 *
 * Vérifié avant d'afficher le bouton plutôt qu'après l'avoir pressé : un bouton
 * qui explique pourquoi il est inerte vaut mieux qu'un bouton qui échoue.
 */
export function providerReads(): { reads: boolean; name: string; explain: string } {
  const name = modelProvider().name

  if (name === 'claude-max' || name === 'anthropic' || name === 'local') {
    return { reads: true, name, explain: '' }
  }

  return {
    reads: false,
    name,
    explain:
      `Le fournisseur configuré (« ${name} ») ne lit pas les scènes, il compare des mots. ` +
      'Refermer une question demande de la comprendre : renseignez ' +
      'CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`), ou ANTHROPIC_API_KEY, ou ' +
      'LOCAL_AI_BASE_URL et LOCAL_AI_MODEL pour un modèle auto-hébergé.',
  }
}

/**
 * Les questions que ce lecteur a laissées ouvertes, sans égard à son curseur.
 *
 * `resolved_in_chapter IS NULL` dans la table, et non la liste que la page
 * affiche : la projection annule une résolution postérieure au chapitre où le
 * lecteur se trouve, donc « Sans réponse » à l'écran contient des questions que
 * le graphe sait déjà refermées. Les redemander au modèle coûterait de l'argent
 * pour rien et rapporterait « déjà refermée » sur une question dont la page ne
 * peut pas dire pourquoi. Le décompte annoncé par le bouton est celui-ci.
 */
export async function openQuestions(userId: string): Promise<OpenQuestion[]> {
  return withIngest(async (db) =>
    db
      .select({
        entityId: mysteries.entityId,
        question: mysteries.question,
        openedInChapter: mysteries.openedInChapter,
      })
      .from(mysteries)
      .where(
        and(
          eq(mysteries.userId, userId),
          isNull(mysteries.resolvedInChapter),
          UNSEEN_BY_THE_LIBRARY,
        ),
      )
      .orderBy(asc(mysteries.openedInChapter), asc(mysteries.question)),
  )
}

/**
 * Les questions que la bibliothèque actuelle n'a pas encore vues.
 *
 * Le filtre qui transforme une relance en reprise. `swept_to_chapter` retient le
 * dernier chapitre publié au moment où la question a été posée et laissée
 * ouverte ; tant que ce nombre n'a pas bougé, reposer la question ferait relire
 * les mêmes neuf cents scènes pour obtenir le même verdict — et le lot n'avance
 * jamais, parce qu'il meurt avant la fin et recommence par le début.
 *
 * Écrit en SQL corrélé plutôt qu'en deux requêtes, parce que la frontière est par
 * œuvre et qu'une liste de questions peut en traverser plusieurs. `coalesce` à
 * zéro pour l'œuvre dont rien n'est publié : rien à lire, donc rien à reposer
 * tant que rien ne l'est.
 *
 * Le null passe, et c'est le cas ordinaire aujourd'hui : jamais examinée.
 */
const UNSEEN_BY_THE_LIBRARY = sql`(
  ${mysteries.sweptToChapter} IS NULL
  OR ${mysteries.sweptToChapter} < coalesce((
    SELECT max(${chapters.number}) FROM ${chapters}
     WHERE ${chapters.workId} = ${mysteries.workId}
       AND ${chapters.userId} = ${mysteries.userId}
       AND ${chapters.status} = 'published'
  ), 0)
)`

/** Le chapitre de la scène : montré s'il l'a été, raconté sinon. */
const sceneChapter = sql<number>`coalesce(${events.shownInChapter}, ${events.toldInChapter})`

interface Question extends OpenQuestion {
  workId: string
}

/**
 * Ce que la première transaction rapporte : de quoi interroger le modèle, ou
 * la raison de ne pas l'interroger du tout.
 */
type Prepared =
  | { ready: true; question: Question; boundary: number; scenes: Scene[] }
  | { ready: false; verdict: ClosingVerdict }

/**
 * Demander à l'histoire si elle a répondu, et l'écrire si oui.
 *
 * Trois temps, et la coupure entre eux est ce qui rend la chose tenable : on lit
 * la question et ses scènes dans une transaction, on ferme, **puis** on appelle
 * le modèle, et on rouvre une transaction pour écrire. Un appel de modèle tenu
 * à l'intérieur d'une transaction, c'est une connexion du pool immobilisée
 * pendant une minute — et le pool en compte une seule par instance sur un
 * hébergement sans serveur, donc c'est toute la page qui attend derrière.
 */
export async function closeIfAnswered(
  userId: string,
  entityId: string,
): Promise<ClosingVerdict> {
  const prepared = await withIngest(async (db): Promise<Prepared> => {
    const [question] = await db
      .select({
        entityId: mysteries.entityId,
        workId: mysteries.workId,
        question: mysteries.question,
        openedInChapter: mysteries.openedInChapter,
        resolvedInChapter: mysteries.resolvedInChapter,
      })
      .from(mysteries)
      .where(and(eq(mysteries.entityId, entityId), eq(mysteries.userId, userId)))
      .limit(1)

    if (!question) return { ready: false, verdict: { kind: 'gone' } }
    if (question.resolvedInChapter !== null) {
      return {
        ready: false,
        verdict: { kind: 'already', chapter: question.resolvedInChapter },
      }
    }

    /*
     * Jusqu'au dernier chapitre publié, et pas plus loin.
     *
     * Un chapitre importé mais non relu n'est pas de l'histoire lue : ses scènes
     * ne sont pas validées, et une question refermée sur l'une d'elles daterait
     * la réponse d'un chapitre que personne ne voit encore.
     */
    const [boundaryRow] = await db
      .select({ boundary: max(chapters.number) })
      .from(chapters)
      .where(
        and(
          eq(chapters.workId, question.workId),
          eq(chapters.userId, userId),
          eq(chapters.status, 'published'),
        ),
      )
    const boundary = boundaryRow?.boundary ?? 0

    const rows = await db
      .select({
        entityId: events.entityId,
        summary: events.summary,
        chapter: sceneChapter,
      })
      .from(events)
      .where(
        and(
          eq(events.workId, question.workId),
          eq(events.userId, userId),
          sql`${sceneChapter} > ${question.openedInChapter}`,
          sql`${sceneChapter} <= ${boundary}`,
        ),
      )
      .orderBy(asc(sceneChapter))

    const scenes: Scene[] = rows
      .filter((row): row is typeof row & { summary: string } =>
        (row.summary ?? '').trim().length > 0,
      )
      .map((row) => ({
        entityId: row.entityId,
        chapter: Number(row.chapter),
        summary: row.summary,
      }))

    return { ready: true, question, boundary, scenes }
  })

  if (!prepared.ready) return prepared.verdict

  const { question, boundary, scenes } = prepared
  const { passes, dropped } = scenePasses(scenes)

  if (passes.length === 0) {
    // Rien à lire jusqu'à ce que quelque chose soit publié : c'est un verdict,
    // et il se retient pour que la passe suivante n'y revienne pas.
    await rememberSwept(userId, question.entityId, boundary)
    return {
      kind: 'open',
      because: 'no-scenes',
      scenesRead: 0,
      scenesDropped: dropped,
      costCents: 0,
    }
  }

  const scan = await scanForResolution(passes, question.openedInChapter, async (window) => {
    const result = await modelProvider().answer({
      question: question.question,
      /*
       * Des scènes, là où l'assistant passe des assertions. Le champ porte le nom
       * de ce que l'assistant y met ; ce que la fonction en attend est plus
       * général — un identifiant, un chapitre, une phrase datée, et l'obligation
       * de citer l'identifiant. C'est aussi ce qui répond à une question
       * d'histoire : « Zoro achève Cabaji » est un événement, pas une relation.
       */
      context: window.map((scene) => ({
        assertionId: scene.entityId,
        chapter: scene.chapter,
        statement: scene.summary,
        excerpt: null,
      })),
      boundaryChapter: boundary,
    })

    return {
      refusal: Boolean(result.refusal),
      answer: result.refusal
        ? { insufficientData: true, citations: [] }
        : {
            insufficientData: result.value.insufficient_data,
            citations: result.value.citations.map((citation) => ({
              assertionId: citation.assertion_id,
              chapter: citation.chapter,
            })),
          },
      costCents: result.usage.costCents,
    }
  })

  if (scan.resolution === null) {
    /*
     * Un verdict se retient, un refus ne se retient pas.
     *
     * « Aucune de ces neuf cents scènes n'y répond » est une lecture complète,
     * et la refaire tant que rien n'est publié rendrait la même chose. Un modèle
     * qui décline n'a rien lu : le marquer enterrerait la question sur un
     * incident, et elle ne reviendrait qu'au prochain chapitre publié — c'est-à-
     * dire, pour une bibliothèque qu'on a fini d'importer, jamais.
     */
    if (!scan.refused) await rememberSwept(userId, question.entityId, boundary)
    return {
      kind: 'open',
      because: scan.refused ? 'refused' : 'unanswered',
      scenesRead: scan.scenesRead,
      scenesDropped: dropped,
      costCents: scan.costCents,
    }
  }

  const written = await record(userId, question, scan.resolution)
  if (!written) return { kind: 'already', chapter: scan.resolution.chapter }

  return {
    kind: 'closed',
    chapter: scan.resolution.chapter,
    sceneId: scan.resolution.sceneId,
    summary: scan.scene!.summary,
    scenesRead: scan.scenesRead,
    scenesDropped: dropped,
    costCents: scan.costCents,
  }
}

/**
 * Retenir qu'on a posé la question à toute la bibliothèque publiée.
 *
 * Une écriture d'une ligne, sans journal : ce n'est pas une décision sur
 * l'histoire, c'est une note de ce qui a déjà été payé. Rien du graphe n'en
 * dépend, et l'effacer ne perdrait qu'un appel de modèle.
 *
 * `isNull(resolvedInChapter)` dans le WHERE pour la même raison qu'en dessous :
 * entre la lecture et ici il y a eu un appel de modèle, et une publication a pu
 * refermer la question entre-temps. Marquer alors une question refermée serait
 * inoffensif — `resolved_in_chapter` la sort du balayage de toute façon — mais
 * écrire sur une ligne qu'un autre chemin vient de trancher est le genre de
 * chose qu'on préfère ne pas faire du tout.
 *
 * `greatest` plutôt qu'une affectation sèche : deux passes concurrentes, ou une
 * passe lancée pendant qu'un chapitre se publie, ne doivent pas pouvoir faire
 * *reculer* la marque. Une marque qui recule ne casse rien — elle ne fait
 * repayer une lecture — mais autant que la seule direction possible soit celle
 * du progrès.
 */
async function rememberSwept(
  userId: string,
  entityId: string,
  boundary: number,
): Promise<void> {
  await withIngest(async (db) => {
    await db
      .update(mysteries)
      .set({ sweptToChapter: sql`greatest(coalesce(${mysteries.sweptToChapter}, 0), ${boundary})` })
      .where(
        and(
          eq(mysteries.entityId, entityId),
          eq(mysteries.userId, userId),
          isNull(mysteries.resolvedInChapter),
        ),
      )
  })
}

/**
 * Les deux moitiés du même fait, et rien d'autre.
 *
 * La relation porte ce qu'elle est : « inferred_strong », « proposed_by = 'ai' ».
 * La fiche de la question montre la scène qui la referme, donc une erreur est
 * visible là et se défait en écartant la relation. Aucune entité n'est créée,
 * aucun chapitre touché, et rien n'est jamais rouvert.
 *
 * `resolved_in_chapter IS NULL` dans le WHERE de la mise à jour est la course
 * que la lecture plus haut ne couvre pas : entre elle et ici il y a eu un appel
 * de modèle, et une publication a pu refermer la question entre-temps. Zéro
 * ligne modifiée signifie qu'une autre écriture a gagné, et la relation qui
 * vient d'être écrite reste — elle est vraie, elle est datée, et c'est la plus
 * ancienne des deux qui fait la date de la question.
 */
async function record(
  userId: string,
  question: Question,
  verdict: { sceneId: string; chapter: number },
): Promise<boolean> {
  return withIngest(async (db) => {
    await db.insert(assertions).values({
      workId: question.workId,
      userId,
      subjectEntityId: verdict.sceneId,
      predicate: 'resolves_mystery',
      objectEntityId: question.entityId,
      knowledgeFromChapter: verdict.chapter,
      observedInChapter: verdict.chapter,
      confidence: 0.8,
      epistemicStatus: 'inferred_strong',
      reviewStatus: 'accepted',
      proposedBy: 'ai',
      pipelineVersion: 'sweep',
    })

    const updated = await db
      .update(mysteries)
      .set({ state: 'resolved', resolvedInChapter: verdict.chapter })
      .where(
        and(
          eq(mysteries.entityId, question.entityId),
          eq(mysteries.userId, userId),
          isNull(mysteries.resolvedInChapter),
        ),
      )
      .returning({ entityId: mysteries.entityId })

    await db.insert(auditLog).values({
      userId,
      action: 'mystery_closed_by_sweep',
      subjectKind: 'mystery',
      subjectId: question.entityId,
      detail: {
        question: question.question,
        openedInChapter: question.openedInChapter,
        resolvedInChapter: verdict.chapter,
        sceneId: verdict.sceneId,
      },
    })

    return updated.length > 0
  })
}
