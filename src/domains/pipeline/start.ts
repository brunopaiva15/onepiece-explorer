import 'server-only'
import { after } from 'next/server'
import { syntheticByFallback } from '@/lib/env.ts'
import { consume } from '@/domains/observability/rate-limit.ts'
import type { ProviderChoice } from '@/domains/ai/index.ts'
import { openChainWindow } from './chain.ts'
import { executeRun } from './execute.ts'
import { createRun, discardRun } from './runs.ts'

/**
 * Start a chapter's run, and let the response leave without it.
 *
 * There used to be a queue and a worker here, and the reason was arithmetic: a
 * chapter of drawn pages meant about a hundred and twenty model calls carrying
 * images, eight to ten minutes of wall clock, far past what any serverless
 * function tolerates. Something long-lived had to own that work.
 *
 * A chapter written as text is one or two extraction calls, a handful of
 * identity comparisons, and two steps that touch no model at all — under a
 * minute in the ordinary case. That fits inside a request, so the queue stopped
 * paying for itself: it was a second moving part that had to be running, and
 * when it was not, the symptom was a chapter sitting at "en attente d'un
 * worker" with nothing to explain it.
 *
 * `after()` is the whole mechanism. The response returns as soon as the run row
 * exists, the pipeline continues on the same invocation, and the progress page
 * follows it through the SSE stream that already existed. Nothing polls, nothing
 * is enqueued, and there is no second process to remember to start.
 *
 * What this gives up, stated rather than discovered: an invocation killed at the
 * platform's duration ceiling takes the run with it, and nothing retries it
 * automatically. That is survivable only because `run_checkpoints` exists — a
 * relaunch replays the slices already paid for instead of re-buying them, so the
 * cost of the missing retry is a click rather than a second invoice. Without
 * checkpointing this trade would be a bad one.
 */

export interface StartRunOutcome {
  ok: boolean
  runId?: string
  error?: string
}

export async function startChapterRun(input: {
  userId: string
  chapterId: string
  provider: ProviderChoice
}): Promise<StartRunOutcome> {
  /*
   * Refuse before spending a run on a provider nobody chose.
   *
   * With no credential configured, `remoteModelProvider()` answers `synthetic`
   * — right for a deployment that was never set up, and catastrophic for one
   * whose token has expired mid-import. The synthetic provider costs nothing,
   * returns in milliseconds and rearranges the text it was given, so the run
   * succeeds, the queue is empty, and nothing anywhere says the model was never
   * asked. A whole lot marches through, chapter after chapter, publishing
   * nothing under a green tick.
   *
   * Here rather than deeper down because this is the door every run comes
   * through — the import, the queue, the button on a chapter — and because a
   * refusal at the door is a sentence someone can act on, while the same
   * discovery three steps later is a note under a tick nobody reads.
   *
   * `MODEL_PROVIDER=synthetic` is untouched: asked for, it is a legitimate
   * choice and says so in the interface.
   */
  if (input.provider === 'auto' && syntheticByFallback()) {
    return {
      ok: false,
      error:
        'Aucun modèle configuré : ni CLAUDE_CODE_OAUTH_TOKEN (abonnement Claude Max) ' +
        "ni ANTHROPIC_API_KEY. Le traitement aurait été fait par le fournisseur " +
        'synthétique — il ne lit rien, ne coûte rien, et produit un chapitre vide ' +
        'qui a l’air réussi. Renseignez un jeton chez votre hébergeur, puis relancez.',
    }
  }

  // A chapter run is the heaviest spend in the system; a script relaunching the
  // same one in a loop is the failure mode worth bounding.
  const allowance = await consume(input.userId, 'start_run')
  if (!allowance.allowed) {
    return {
      ok: false,
      error:
        `Limite atteinte : ${allowance.used} traitements dans l'heure. ` +
        `Réessayez dans ${allowance.retryInMinutes} minute(s). ${allowance.explain}`,
    }
  }

  /*
   * The clock a self-chaining lot runs against.
   *
   * Opened here rather than at each call site because here is the one place a
   * run is started, from a request or from the chapter before it. A request
   * opens its own window; a chapter chained from inside a live one joins it.
   * See `chain.ts` for why the budget exists at all.
   */
  openChainWindow()

  const runId = await createRun(input.userId, input.chapterId, input.provider)

  try {
    /*
     * Scheduled, not awaited.
     *
     * Awaiting would hold the browser for the length of the pipeline and time
     * the request out on a chapter that is merely long. The run row is already
     * written, so the caller has something to redirect to and the progress page
     * has something to watch — the work catching up afterwards is invisible
     * except as steps turning green.
     *
     * executeRun catches its own failures and records them on the run, so
     * nothing thrown here is lost: a failure shows up on the progress page with
     * its reason, which is where someone would look for it anyway.
     */
    after(async () => {
      await executeRun(input.userId, input.chapterId, runId)
    })
  } catch (error) {
    // Scheduling itself failed, so the run would sit pending forever with no
    // worker coming. Discarding it is better than leaving a row that looks like
    // work in progress.
    await discardRun(runId)
    return {
      ok: false,
      error:
        "Le traitement n'a pas pu être lancé : " +
        (error instanceof Error ? error.message : String(error)),
    }
  }

  return { ok: true, runId }
}
