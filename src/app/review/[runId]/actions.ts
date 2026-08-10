'use server'

import { revalidatePath } from 'next/cache'
import { getReaderSession } from '@/domains/auth/session.ts'
import { publishDecisions, type Decision, type PublishResult } from '@/domains/review/publish.ts'

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
    const session = await getReaderSession()

    if (decisions.length === 0) {
      return { ok: false, error: 'Aucune décision à publier.' }
    }

    const published = await publishDecisions(session.userId, runId, decisions)

    revalidatePath(`/review/${runId}`)
    revalidatePath('/chapitres')

    return { ok: true, published }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Publication impossible.',
    }
  }
}
