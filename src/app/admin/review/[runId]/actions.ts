'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters } from '@/db/schema/documents.ts'
import { ingestionRuns } from '@/db/schema/ingestion.ts'
import {
  isProviderChoice,
  modelProvider,
  type ProviderChoice,
} from '@/domains/ai/index.ts'
import { requireOwner } from '@/domains/auth/session.ts'
import { illustrateQuietly } from '@/domains/images/enrich.ts'
import { postersQuietly } from '@/domains/images/posters.ts'
import { advanceQueue } from '@/domains/pipeline/queue.ts'
import { reopenItems } from '@/domains/review/reopen.ts'
import { arbitrateNote, arbitrateRun } from '@/domains/review/arbitrate.ts'
import { autoReview, autoReviewNote, autoReviewsRun } from '@/domains/review/auto.ts'
import {
  markChapterReviewed,
  mergePublishResults,
  publishDecisions,
  type Decision,
  type PublishResult,
} from '@/domains/review/publish.ts'

export interface ReviewActionResult {
  ok: boolean
  published?: PublishResult
  error?: string
}

/**
 * Apply a batch of decisions.
 *
 * Batched rather than one call per click, for a reason that is about correctness
 * rather than latency: entities and the assertions that reference them have to be
 * published in the same transaction, so accepting an entity and its relation
 * separately would leave a window where the relation cannot resolve its subject.
 * The interface keeps decisions local until the reviewer publishes, which also
 * means they can change their mind for free.
 */
export async function publishDecisionsAction(
  runId: string,
  decisions: Decision[],
): Promise<ReviewActionResult> {
  try {
    const session = await requireOwner()

    if (decisions.length === 0) {
      return { ok: false, error: 'Aucune décision à publier.' }
    }

    const published = await publishDecisions(session.userId, runId, decisions)

    /*
     * Release what was waiting on the answers you just gave.
     *
     * The run's automatic pass holds back a naming question and every relation
     * whose subject it names — publishing those without their entity would fail
     * on a subject that does not exist. Answering the name here is what makes
     * them publishable, so the same pass runs again on the way out rather than
     * leaving them in a queue nothing will come back to.
     */
    const swept = (await autoReviewsRun(session.userId, runId))
      ? await autoReview(session.userId, runId)
      : null

    const result = swept?.published
      ? mergePublishResults(published, swept.published)
      : published

    /*
     * The sweep can open the chapter without publishing anything.
     *
     * It happens when the last cards left were ones publication cannot apply
     * and the pass parked them: nothing was published, and yet nothing is
     * proposed either, which is the definition of a chapter read to the end.
     * Read here so that everything below — the pictures, and the next chapter
     * of a lot — happens on that opening too, rather than only on the ones a
     * publication caused.
     */
    const opened = result.chapterPublished ?? swept?.chapterOpened ?? null

    /*
     * A chapter that has just become readable, illustrated on the way out.
     *
     * `after()` for the same reason the pipeline uses it: this downloads and
     * re-encodes pictures, and the reviewer who clicked « publier » should not
     * wait for it. Only when the chapter actually opened — publishing a batch
     * mid-review would run it several times over the same entities for nothing.
     */
    if (opened !== null) {
      // No revalidation on the way out: /graph is force-dynamic, so the next
      // visit reads the pictures this just stored.
      after(() => illustrateQuietly(session.userId))
      /*
       * And the wanted posters, on the same event and for the same reason.
       *
       * The chapter that opens is what can make one reachable: a poster is
       * stored against the chapter that prints it, and a reader only ever sees
       * the ones behind their own position. Publishing chapter 96 is the moment
       * Luffy's thirty million becomes a thing this library can show.
       *
       * Cheap enough to sit here because `postersQuietly` asks the library
       * before it asks Fandom — on the ordinary publication, where every poster
       * is already in place, it is one query and no request.
       */
      after(() => postersQuietly(session.userId))
      /*
       * And the next chapter of a batch import, if one is waiting.
       *
       * This moment is the condition the queue exists for: the entities you
       * just accepted are in the graph, so the next chapter's resolution can
       * match against them instead of proposing them again. A minute earlier it
       * would have been blind to every one of them.
       *
       * Here rather than in `publishDecisions` on purpose. That function is the
       * one door into the graph and holds a transaction; it writes what a human
       * said yes to and does nothing else. Starting a pipeline from inside it
       * would put a model call in the same breath as a commit — and this is the
       * same place, and the same `after()`, that illustration already uses.
       */
      after(() => advanceQueue(session.userId))
    }

    revalidatePath(`/admin/review/${runId}`)
    revalidatePath('/admin/chapitres')
    revalidatePath('/graph')

    return { ok: true, published: result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Publication impossible.',
    }
  }
}

/**
 * Faire relire la file par un second modèle, page du wiki en main.
 *
 * Le même arbitrage que le pipeline exécute, déclenché à la main — pour un
 * traitement lancé avant que la passe existe, ou dont le fournisseur ne lisait
 * pas ce jour-là. Aucune logique ici : elle est dans `arbitrateRun`, et deux
 * copies d'une règle qui décide à votre place seraient une de trop.
 *
 * Le fournisseur est celui que ce traitement a choisi, pas celui configuré
 * aujourd'hui : arbitrer un chapitre traité sur Claude Max avec le modèle
 * auto-hébergé de cette semaine donnerait des verdicts que rien sur la page
 * n'expliquerait.
 *
 * Comme après une publication : ce que l'arbitrage libère est repris par la
 * passe automatique du chapitre — un nom tranché rend publiables les relations
 * qui l'attendaient — et un chapitre qui s'ouvre enchaîne le suivant du lot.
 */
export async function arbitrateRunAction(
  runId: string,
): Promise<{ ok: boolean; note?: string; error?: string }> {
  try {
    const session = await requireOwner()

    const run = await runProviderAndChapter(session.userId, runId)
    if (!run) return { ok: false, error: 'Traitement introuvable.' }

    const provider = modelProvider(run.provider)
    if (provider.name === 'synthetic' || provider.name === 'replay') {
      return {
        ok: false,
        error:
          `Fournisseur « ${provider.name} » : il compare des mots, il ne lit pas ` +
          'la page du wiki. Rien n’a été demandé.',
      }
    }

    const outcome = await arbitrateRun({
      userId: session.userId,
      runId,
      chapterNumber: run.chapterNumber,
      provider,
    })

    if (outcome.skipped !== null) {
      revalidatePath(`/admin/review/${runId}`)
      return { ok: true, note: outcome.skipped }
    }

    const swept = (await autoReviewsRun(session.userId, runId))
      ? await autoReview(session.userId, runId)
      : null

    const opened = outcome.published?.chapterPublished ?? swept?.chapterOpened ?? null
    if (opened !== null) {
      after(() => illustrateQuietly(session.userId))
      after(() => postersQuietly(session.userId))
      after(() => advanceQueue(session.userId))
    }

    revalidatePath(`/admin/review/${runId}`)
    revalidatePath('/admin/chapitres')
    revalidatePath('/graph')

    return {
      ok: true,
      note:
        arbitrateNote(outcome) +
        (swept ? ` · ${autoReviewNote(swept)}` : '') +
        (opened === null ? '' : ` · chapitre ${opened} ouvert`),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Arbitrage impossible.',
    }
  }
}

/** Le fournisseur choisi au lancement, et le numéro du chapitre relu. */
async function runProviderAndChapter(
  userId: string,
  runId: string,
): Promise<{ provider: ProviderChoice; chapterNumber: number } | null> {
  const row = await withIngest(async (db) => {
    const [found] = await db
      .select({ provider: ingestionRuns.provider, chapterNumber: chapters.number })
      .from(ingestionRuns)
      .innerJoin(chapters, eq(chapters.id, ingestionRuns.chapterId))
      .where(and(eq(ingestionRuns.id, runId), eq(ingestionRuns.userId, userId)))
      .limit(1)
    return found ?? null
  })

  if (!row) return null

  // Une ligne écrite avant que le choix soit enregistré porte un nom de
  // fournisseur résolu ('anthropic', 'local'…) plutôt qu'un choix : « auto »
  // est ce avec quoi ces traitements ont été lancés.
  return {
    provider: isProviderChoice(row.provider) ? row.provider : 'auto',
    chapterNumber: row.chapterNumber,
  }
}

/**
 * Close a review whose queue was emptied before publication knew how to.
 *
 * Every chapter reviewed from now on is opened by `publishDecisions` itself.
 * This exists for the ones decided earlier — accepted, published, and then
 * invisible, because the reader's boundary only counts published chapters and
 * nothing ever published one.
 */
export async function markChapterReviewedAction(
  runId: string,
): Promise<{ ok: boolean; chapterNumber?: number; error?: string }> {
  try {
    const session = await requireOwner()
    const chapterNumber = await markChapterReviewed(session.userId, runId)

    if (chapterNumber !== null) {
      // A chapter opening is a chapter opening, whichever path opened it: the
      // batch queue advances here for the same reason it advances on publication.
      after(() => advanceQueue(session.userId))
      // No revalidation on the way out: /graph is force-dynamic, so the next
      // visit reads the pictures this just stored.
      after(() => illustrateQuietly(session.userId))
      // A chapter opening is a chapter opening here too, posters included.
      after(() => postersQuietly(session.userId))
    }

    revalidatePath(`/admin/review/${runId}`)
    revalidatePath('/admin/chapitres')
    revalidatePath('/graph')

    if (chapterNumber === null) {
      /*
       * Said in full, because the page this lands on shows an empty queue.
       *
       * The rule counts every run of the chapter, so what blocks is almost
       * always a second processing whose queue is on another page — the panel
       * now names and links it before the button is offered, and this is the
       * message for the race where one arrives between the two.
       */
      return {
        ok: false,
        error:
          'Il reste des propositions à décider pour ce chapitre, dans un autre ' +
          'traitement que celui-ci. Rechargez la page : le traitement concerné y ' +
          'est nommé.',
      }
    }
    return { ok: true, chapterNumber }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Opération impossible.',
    }
  }
}

/**
 * Put a rejected or deferred proposal back in the queue.
 *
 * The escape hatch the review centre did not have. Rejecting a proposal also
 * recorded the verdict against its fingerprint so that a re-import would not
 * ask again — which is right, and which left a mistaken rejection with no way
 * back, taking the chapter's relations down with it. Reopening deletes the
 * recorded verdict too; see reopenItems().
 */
export async function reopenItemsAction(
  runId: string,
  itemIds: string[],
): Promise<{ ok: boolean; reopened?: number; error?: string }> {
  try {
    const session = await requireOwner()
    const { reopened } = await reopenItems(session.userId, runId, itemIds)

    revalidatePath(`/admin/review/${runId}`)

    return { ok: true, reopened }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Opération impossible.',
    }
  }
}
