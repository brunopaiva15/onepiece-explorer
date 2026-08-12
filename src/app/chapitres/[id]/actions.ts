'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { isProviderChoice, type ProviderChoice } from '@/domains/ai/index.ts'
import { startChapterRun } from '@/domains/pipeline/start.ts'
import { getLocale } from '@/lib/i18n/server.ts'
import { getDictFor } from '@/lib/i18n/dictionaries.ts'

export interface StartRunResult {
  ok: boolean
  runId?: string
  error?: string
}

/**
 * Process a chapter.
 *
 * The run is created here and the pipeline continues after the response leaves,
 * on the same invocation. There is no queue and no worker to have running:
 * see `startChapterRun` for why that stopped being necessary, and what it costs.
 */
export async function startRunAction(
  chapterId: string,
  provider: ProviderChoice = 'auto',
): Promise<StartRunResult> {
  // Resolved before the try so the catch below can word its fallback in the
  // caller's language even when `requireOwner` itself is what threw.
  const t = getDictFor(await getLocale()).chapters
  try {
    const session = await requireOwner()

    // A server action's arguments come from the browser. An unknown value here
    // would be written to the run and read back as a model choice.
    if (!isProviderChoice(provider)) {
      return { ok: false, error: t.unknownProvider(String(provider)) }
    }

    const outcome = await startChapterRun({
      userId: session.userId,
      chapterId,
      provider,
    })

    if (outcome.ok) revalidatePath(`/chapitres/${chapterId}`)
    return outcome
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : t.startFailed,
    }
  }
}
