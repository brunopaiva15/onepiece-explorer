'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { enqueueChapter } from '@/domains/pipeline/queue.ts'
import { createRun } from '@/domains/pipeline/runs.ts'
import { consume } from '@/domains/observability/rate-limit.ts'

export interface StartRunResult {
  ok: boolean
  runId?: string
  error?: string
}

/**
 * Queue a chapter for processing.
 *
 * The run row is written before the job is enqueued, so a worker that picks the
 * job up instantly still finds its run. The reverse order would race: the job
 * would arrive before the row it is supposed to update.
 */
export async function startRunAction(chapterId: string): Promise<StartRunResult> {
  try {
    const session = await requireOwner()

    // A chapter run is the heaviest spend in the system; a script re-launching
    // the same one in a loop is the failure mode worth bounding.
    const allowance = await consume(session.userId, 'start_run')
    if (!allowance.allowed) {
      return {
        ok: false,
        error:
          `Limite atteinte : ${allowance.used} traitements dans l'heure. ` +
          `Réessayez dans ${allowance.retryInMinutes} minute(s). ${allowance.explain}`,
      }
    }

    const runId = await createRun(session.userId, chapterId)

    try {
      await enqueueChapter({ runId, userId: session.userId, chapterId })
    } catch (error) {
      // The run exists and is pending; the queue is what failed. Say which,
      // because "start the worker" and "fix the pipeline" are different
      // actions and the difference is not guessable from a generic message.
      return {
        ok: false,
        runId,
        error:
          `Le run ${runId} est créé mais n'a pas pu être mis en file : ` +
          (error instanceof Error ? error.message : String(error)) +
          " · Vérifiez DIRECT_URL et que « pnpm worker » tourne.",
      }
    }

    revalidatePath(`/chapitres/${chapterId}`)
    return { ok: true, runId }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Lancement impossible.',
    }
  }
}
