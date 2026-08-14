'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { importChapter } from '@/domains/ingestion/import.ts'
import { IngestionRejection } from '@/domains/ingestion/limits.ts'
import { MAX_SUMMARY_CHARS, type SummaryLanguage } from '@/domains/ingestion/passages.ts'
import { reorderPages } from '@/domains/ingestion/persist.ts'
import {
  chapterNumberFrom,
  citableAndParallel,
  fetchChapterRange,
  fetchChapterSummaries,
  MAX_RANGE_LENGTH,
  type FandomLanguage,
} from '@/domains/ingestion/fandom.ts'
import { importSummary } from '@/domains/ingestion/summary.ts'
import { advanceQueue, clearQueue, queueForRun } from '@/domains/pipeline/queue.ts'
import { startChapterRun } from '@/domains/pipeline/start.ts'

/**
 * Import a chapter from the browser.
 *
 * A server action rather than a route handler because the whole operation is
 * a form submission with a file in it, and the action gets CSRF protection,
 * the verified session and typed results without a hand-written endpoint.
 *
 * The file never touches the client's idea of who the user is: the uid comes
 * from getUser() server-side, and every row written is stamped with it.
 */

export interface ImportActionResult {
  ok: boolean
  chapterId?: string
  pageCount?: number
  hasTextLayer?: boolean
  replaced?: boolean
  unchanged?: boolean
  error?: { message: string; hint?: string }
}

const MAX_FIELD_LENGTH = 200

export async function importChapterAction(
  _previous: ImportActionResult | null,
  formData: FormData,
): Promise<ImportActionResult> {
  try {
    const session = await requireOwner()

    const numberRaw = formData.get('chapterNumber')
    const chapterNumber = Number(numberRaw)
    if (!Number.isInteger(chapterNumber) || chapterNumber < 0) {
      return {
        ok: false,
        error: {
          message: 'Numéro de chapitre invalide.',
          hint: 'Indiquez un entier positif, par exemple 1.',
        },
      }
    }

    const title = text(formData.get('title'))
    const volume = formData.get('volume') ? Number(formData.get('volume')) : undefined
    const direction = formData.get('readingDirection') === 'ltr' ? 'ltr' : 'rtl'

    const files = formData.getAll('file').filter(isFile)
    if (files.length === 0) {
      return {
        ok: false,
        error: {
          message: 'Aucun fichier sélectionné.',
          hint: 'Choisissez un PDF, une archive CBZ, ou les images du chapitre.',
        },
      }
    }

    const result =
      files.length === 1 && !isImageFile(files[0]!)
        ? await importChapter({
            userId: session.userId,
            workId: session.workId,
            chapterNumber,
            title,
            volume: Number.isFinite(volume) ? volume : undefined,
            readingDirection: direction,
            file: {
              filename: files[0]!.name,
              bytes: new Uint8Array(await files[0]!.arrayBuffer()),
            },
          })
        : await importChapter({
            userId: session.userId,
            workId: session.workId,
            chapterNumber,
            title,
            volume: Number.isFinite(volume) ? volume : undefined,
            readingDirection: direction,
            images: await Promise.all(
              files.map(async (file) => ({
                filename: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            ),
          })

    revalidatePath('/admin/chapitres')
    revalidatePath(`/admin/chapitres/${result.chapterId}`)

    return {
      ok: true,
      chapterId: result.chapterId,
      pageCount: result.pages.length,
      hasTextLayer: result.hasTextLayer,
      replaced: result.replaced,
      unchanged: result.unchanged,
    }
  } catch (error) {
    // An IngestionRejection already carries a message and a remedy written for
    // the person holding the file. Anything else is a bug, and saying so is
    // more useful than dressing it up as a user error.
    if (error instanceof IngestionRejection) {
      return { ok: false, error: { message: error.message, hint: error.hint } }
    }
    return {
      ok: false,
      error: {
        message:
          error instanceof Error ? error.message : "L'import a échoué pour une raison inconnue.",
        hint: "Ceci n'est pas une erreur attendue. Consultez les journaux du serveur.",
      },
    }
  }
}

export interface SummaryActionResult {
  ok: boolean
  chapterId?: string
  /** Set when the chapter went straight into the pipeline. */
  runId?: string
  /**
   * The import worked and the run did not.
   *
   * Kept apart from `error`, which means the chapter was not stored at all.
   * Collapsing the two would have a rate-limited run report a failed import and
   * send someone back to re-paste a chapter that is already saved.
   */
  runError?: string
  passageCount?: number
  characterCount?: number
  language?: SummaryLanguage
  replaced?: boolean
  unchanged?: boolean
  error?: { message: string; hint?: string }
}

/**
 * Import a chapter written out as text.
 *
 * The path that replaced file upload. Everything the pipeline needs from a
 * chapter is prose, and this is prose — so no bytes are validated, no archive
 * is walked, nothing is stored in a bucket, and the model is never shown an
 * image. What arrives is a form field, and what leaves is a set of passages any
 * later claim will have to quote.
 */
export async function importSummaryAction(
  _previous: SummaryActionResult | null,
  formData: FormData,
): Promise<SummaryActionResult> {
  try {
    const session = await requireOwner()

    const chapterNumber = Number(formData.get('chapterNumber'))
    if (!Number.isInteger(chapterNumber) || chapterNumber < 0) {
      return {
        ok: false,
        error: {
          message: 'Numéro de chapitre invalide.',
          hint: 'Indiquez un entier positif, par exemple 1.',
        },
      }
    }

    const summary = formData.get('summary')
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      return {
        ok: false,
        error: {
          message: 'Aucun texte fourni.',
          hint: 'Collez le résumé détaillé du chapitre dans la zone de texte.',
        },
      }
    }

    /*
     * The other-language version, optional and never a second source.
     *
     * Read as a plain field rather than validated here: length and language
     * belong to the importer, which is where the same rules apply to the
     * primary text and where a rejection can explain itself in the same terms.
     */
    const parallelRaw = formData.get('parallelSummary')
    const parallelSummary =
      typeof parallelRaw === 'string' && parallelRaw.trim().length > 0
        ? parallelRaw.slice(0, MAX_SUMMARY_CHARS + 1)
        : undefined

    const volumeRaw = formData.get('volume')
    const volume = volumeRaw ? Number(volumeRaw) : undefined
    // Absent means unchecked: a checkbox posts nothing when it is off, so the
    // default has to be read as "on" rather than inferred from presence.
    const autoRun = formData.get('autoRun') !== 'off'

    const languageRaw = formData.get('language')
    const language: SummaryLanguage | undefined =
      languageRaw === 'fr' || languageRaw === 'en' ? languageRaw : undefined

    const result = await importSummary({
      userId: session.userId,
      workId: session.workId,
      chapterNumber,
      // Sliced server-side too. A client that skips the maxLength attribute is
      // not a hypothetical when the client is a script someone wrote at 2am.
      text: summary.slice(0, MAX_SUMMARY_CHARS + 1),
      ...(text(formData.get('title')) ? { title: text(formData.get('title')) } : {}),
      ...(Number.isFinite(volume) && volume !== undefined ? { volume } : {}),
      ...(language ? { language } : {}),
      ...(parallelSummary ? { parallelText: parallelSummary } : {}),
    })

    /*
     * Import and processing, in one submission.
     *
     * They were two steps because importing a file put pages on screen while
     * you were still watching, and it was worth checking the page order before
     * paying to analyse it. A pasted text has no page order to get wrong: you
     * are looking at the source as you submit it. Keeping the split would mean
     * eleven hundred extra round trips through a chapter page to press a second
     * button.
     *
     * Skipped when nothing changed — re-pasting an identical summary must not
     * re-run a pipeline whose inputs are byte-for-byte the ones it already ran.
     */
    let runId: string | undefined
    let runError: string | undefined

    if (autoRun && !result.unchanged) {
      const started = await startChapterRun({
        userId: session.userId,
        chapterId: result.chapterId,
        provider: 'auto',
      })
      if (started.ok) runId = started.runId
      else runError = started.error
    }

    revalidatePath('/admin/chapitres')
    revalidatePath(`/admin/chapitres/${result.chapterId}`)

    return {
      ok: true,
      chapterId: result.chapterId,
      passageCount: result.passageCount,
      characterCount: result.characterCount,
      language: result.language,
      replaced: result.replaced,
      unchanged: result.unchanged,
      ...(runId ? { runId } : {}),
      ...(runError ? { runError } : {}),
    }
  } catch (error) {
    if (error instanceof IngestionRejection) {
      return { ok: false, error: { message: error.message, hint: error.hint } }
    }
    return {
      ok: false,
      error: {
        message:
          error instanceof Error ? error.message : "L'import a échoué pour une raison inconnue.",
        hint: "Ceci n'est pas une erreur attendue. Consultez les journaux du serveur.",
      },
    }
  }
}

export interface ReorderActionResult {
  ok: boolean
  error?: string
}

export async function reorderPagesAction(
  chapterId: string,
  order: Array<{ pageId: string; index: number; excluded?: boolean }>,
): Promise<ReorderActionResult> {
  try {
    const session = await requireOwner()
    await reorderPages(session.userId, chapterId, order)
    revalidatePath(`/admin/chapitres/${chapterId}`)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Réorganisation impossible.',
    }
  }
}

function text(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, MAX_FIELD_LENGTH)
  return trimmed.length > 0 ? trimmed : undefined
}

function isFile(value: FormDataEntryValue): value is File {
  return value instanceof File && value.size > 0
}

function isImageFile(file: File): boolean {
  return /\.(jpe?g|png|webp|avif)$/i.test(file.name)
}

export interface FandomActionResult {
  ok: boolean
  chapterNumber?: number
  /** The citable text: French when the wiki has it, English otherwise. */
  primary?: { language: FandomLanguage; text: string; url: string }
  /** The other language, for naming. Absent when the wiki has only one. */
  parallel?: { language: FandomLanguage; text: string; url: string }
  /** What was not found, in the words the reviewer needs. */
  problems?: string[]
  error?: string
}

/**
 * Fetch a chapter's summaries from the wiki, in both languages.
 *
 * The field accepts a URL and nothing in that URL is requested: `chapterNumberFrom`
 * reads its digits and discards the rest, and the endpoints are constants in the
 * domain module. That is what keeps "no request built from an address found in
 * input" true while adding a feature that looks exactly like breaking it.
 *
 * Which text becomes the source and which becomes the naming aid is decided by
 * `citableAndParallel`, in the domain, with the reasoning attached to it.
 */
export interface FandomRangeEntryResult {
  chapterNumber: number
  primary?: { language: FandomLanguage; text: string; url: string }
  parallel?: { language: FandomLanguage; text: string; url: string }
  problems?: string[]
  /** Set when this chapter came back with nothing. The others still did. */
  error?: string
}

export interface FandomRangeActionResult {
  ok: boolean
  entries?: FandomRangeEntryResult[]
  error?: string
}

/**
 * Fetch a run of chapters at once.
 *
 * The same operation as `fetchFandomAction`, repeated — and repeated is all it
 * is: same constant endpoints, same "the input is read for digits and thrown
 * away", now over two numbers instead of one. Nothing about what gets requested
 * changes, which is the property worth stating rather than assuming.
 *
 * What comes back is a form to read, not a library to store. A chapter the wiki
 * does not have arrives carrying its reason and the rest arrive anyway: a hole
 * at 763 must not cost you 752 to 762.
 */
export async function fetchFandomRangeAction(
  fromInput: string,
  toInput: string,
): Promise<FandomRangeActionResult> {
  try {
    await requireOwner()

    const from = chapterNumberFrom(fromInput)
    const to = chapterNumberFrom(toInput)
    const fetched = await fetchChapterRange(from, to)

    return {
      ok: true,
      entries: fetched.map((entry) => {
        if (!entry.fetched) {
          return {
            chapterNumber: entry.chapterNumber,
            error: entry.error ?? 'Rien à récupérer.',
          }
        }

        const { citable, naming } = citableAndParallel(entry.fetched)
        return {
          chapterNumber: entry.chapterNumber,
          primary: { language: citable.language, text: citable.text, url: citable.url },
          ...(naming
            ? { parallel: { language: naming.language, text: naming.text, url: naming.url } }
            : {}),
          problems: entry.fetched.problems.map(
            (problem) =>
              `${problem.language === 'fr' ? 'Français' : 'Anglais'} : ${problem.reason}`,
          ),
        }
      }),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Récupération impossible.',
    }
  }
}

export interface BatchChapterInput {
  chapterNumber: number
  text: string
  parallelText?: string
  language?: SummaryLanguage
  title?: string
  volume?: number
}

export interface BatchChapterOutcome {
  chapterNumber: number
  ok: boolean
  chapterId?: string
  passageCount?: number
  /** Stored, and waiting for the chapter before it to be published. */
  queued?: boolean
  /** Set on the one chapter whose run started straight away. */
  runId?: string
  unchanged?: boolean
  error?: { message: string; hint?: string }
}

export interface BatchActionResult {
  ok: boolean
  outcomes?: BatchChapterOutcome[]
  queuedCount?: number
  /** The run that started now, when one did. */
  runId?: string
  /** The run refused to start; the chapters are stored regardless. */
  runError?: string
  error?: { message: string; hint?: string }
}

/**
 * How much text one submission may carry.
 *
 * Twenty chapters at the per-chapter maximum would be 4.8 MB, past the 4.5 MB a
 * serverless host accepts for a whole request — and the symptom of crossing it
 * is not an error message, it is a submission that never arrives. Real chapter
 * summaries run to eight or ten thousand characters, so this ceiling is about
 * seven times a full batch of them: reachable only by pasting novels, and said
 * out loud when it is.
 */
const MAX_BATCH_CHARS = 1_500_000

/**
 * Import several chapters, and process them one at a time.
 *
 * The two halves of this are deliberately different, and the difference is the
 * whole feature. Storing ten chapters together is free — they are ten texts.
 * *Running* them together silently drops the identity questions: entity
 * resolution compares a proposal only against what is already in the graph, and
 * only publication puts anything there, so simultaneous runs are blind to each
 * other. Identical names still join at publication; an alias named a chapter
 * later does not, and nothing asks. See `domains/pipeline/queue.ts`, which owns
 * that reasoning.
 *
 * So: everything is imported, the first chapter runs now, and each of the rest
 * starts when the chapter before it is published.
 *
 * One chapter failing to import does not abort the others. They are independent
 * texts, and a batch that rolls back nine good chapters because the tenth was
 * too short would be answering a question nobody asked.
 */
export async function importBatchAction(
  entries: BatchChapterInput[],
): Promise<BatchActionResult> {
  try {
    const session = await requireOwner()

    if (entries.length === 0) {
      return {
        ok: false,
        error: {
          message: 'Aucun chapitre à importer.',
          hint: 'Récupérez un intervalle de chapitres, puis relisez-les.',
        },
      }
    }

    if (entries.length > MAX_RANGE_LENGTH) {
      return {
        ok: false,
        error: {
          message: `${entries.length} chapitres d'un coup, au-delà des ${MAX_RANGE_LENGTH} autorisés.`,
          hint: 'Importez-les en deux fois.',
        },
      }
    }

    const totalChars = entries.reduce(
      (sum, entry) => sum + entry.text.length + (entry.parallelText?.length ?? 0),
      0,
    )
    if (totalChars > MAX_BATCH_CHARS) {
      return {
        ok: false,
        error: {
          message: `Ce lot fait ${totalChars} caractères, au-delà de ${MAX_BATCH_CHARS}.`,
          hint: "Un hébergeur sans serveur refuse la requête au-delà d'une certaine " +
            'taille, sans message. Importez ces chapitres en deux fois.',
        },
      }
    }

    const numbers = new Set(entries.map((entry) => entry.chapterNumber))
    if (numbers.size !== entries.length) {
      return {
        ok: false,
        error: {
          message: 'Deux entrées portent le même numéro de chapitre.',
          hint: 'Un numéro date tout ce que le chapitre révèle : deux textes ne ' +
            'peuvent pas partager le même.',
        },
      }
    }

    /*
     * Sorted here rather than trusted from the client.
     *
     * The order is not presentation: it is the order the queue will be
     * processed in, and processing 14 before 13 puts back exactly the blindness
     * the queue exists to remove.
     */
    const ordered = [...entries].sort((a, b) => a.chapterNumber - b.chapterNumber)

    const outcomes: BatchChapterOutcome[] = []
    const importedIds: string[] = []

    for (const entry of ordered) {
      if (!Number.isInteger(entry.chapterNumber) || entry.chapterNumber < 0) {
        outcomes.push({
          chapterNumber: entry.chapterNumber,
          ok: false,
          error: {
            message: 'Numéro de chapitre invalide.',
            hint: 'Indiquez un entier positif.',
          },
        })
        continue
      }

      try {
        const result = await importSummary({
          userId: session.userId,
          workId: session.workId,
          chapterNumber: entry.chapterNumber,
          text: entry.text.slice(0, MAX_SUMMARY_CHARS + 1),
          ...(entry.title ? { title: entry.title.slice(0, MAX_FIELD_LENGTH) } : {}),
          ...(Number.isInteger(entry.volume) ? { volume: entry.volume } : {}),
          ...(entry.language ? { language: entry.language } : {}),
          ...(entry.parallelText
            ? { parallelText: entry.parallelText.slice(0, MAX_SUMMARY_CHARS + 1) }
            : {}),
        })

        outcomes.push({
          chapterNumber: entry.chapterNumber,
          ok: true,
          chapterId: result.chapterId,
          passageCount: result.passageCount,
          unchanged: result.unchanged,
        })

        // An unchanged chapter is already stored with the same bytes; queueing
        // it would spend a run to arrive at the results it already has.
        if (!result.unchanged) importedIds.push(result.chapterId)
      } catch (error) {
        outcomes.push({
          chapterNumber: entry.chapterNumber,
          ok: false,
          error:
            error instanceof IngestionRejection
              ? { message: error.message, hint: error.hint }
              : {
                  message:
                    error instanceof Error ? error.message : "L'import a échoué.",
                  hint: "Ceci n'est pas une erreur attendue. Consultez les journaux du serveur.",
                },
        })
      }
    }

    /*
     * The queue first, the run second.
     *
     * Everything imported goes into the queue, and only then is the first one
     * claimed out of it by `advanceQueue`. Writing it the other way — start the
     * first, queue the rest — leaves a window where a publication landing
     * mid-import finds an empty queue and stops the chain before it began.
     */
    let runId: string | undefined
    let runError: string | undefined

    if (importedIds.length > 0) {
      await queueForRun(session.userId, importedIds)
      const advanced = await advanceQueue(session.userId)
      if (advanced.started) {
        runId = advanced.started.runId
        const outcome = outcomes.find(
          (candidate) => candidate.chapterId === advanced.started!.chapterId,
        )
        if (outcome) outcome.runId = advanced.started.runId
      } else if (advanced.error) {
        runError = advanced.error
      }
    }

    for (const outcome of outcomes) {
      if (outcome.ok && !outcome.runId && !outcome.unchanged) outcome.queued = true
    }

    revalidatePath('/admin/chapitres')
    revalidatePath('/admin/import')

    return {
      ok: outcomes.some((outcome) => outcome.ok),
      outcomes,
      queuedCount: outcomes.filter((outcome) => outcome.queued).length,
      ...(runId ? { runId } : {}),
      ...(runError ? { runError } : {}),
    }
  } catch (error) {
    if (error instanceof IngestionRejection) {
      return { ok: false, error: { message: error.message, hint: error.hint } }
    }
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : "L'import a échoué.",
        hint: "Ceci n'est pas une erreur attendue. Consultez les journaux du serveur.",
      },
    }
  }
}

/**
 * Start the next queued chapter now, without waiting for a publication.
 *
 * The escape hatch for the case the chain cannot resolve on its own: the
 * chapter before the queue is never going to be published — you imported it
 * long ago, or decided not to review it — and the queue would otherwise wait
 * for an event that is not coming.
 */
export async function advanceQueueAction(): Promise<{
  ok: boolean
  runId?: string
  chapterNumber?: number
  error?: string
}> {
  try {
    const session = await requireOwner()
    const advanced = await advanceQueue(session.userId)

    revalidatePath('/admin/import')
    revalidatePath('/admin/chapitres')

    if (advanced.error) return { ok: false, error: advanced.error }
    if (!advanced.started) return { ok: false, error: 'La file est vide.' }

    return {
      ok: true,
      runId: advanced.started.runId,
      chapterNumber: advanced.started.number,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Démarrage impossible.',
    }
  }
}

/** Abandon the queue. The chapters stay imported; nothing is deleted. */
export async function clearQueueAction(): Promise<{ ok: boolean; cleared?: number; error?: string }> {
  try {
    const session = await requireOwner()
    const cleared = await clearQueue(session.userId)
    revalidatePath('/admin/import')
    revalidatePath('/admin/chapitres')
    return { ok: true, cleared }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Opération impossible.',
    }
  }
}

export async function fetchFandomAction(input: string): Promise<FandomActionResult> {
  try {
    await requireOwner()

    const chapterNumber = chapterNumberFrom(input)
    const fetched = await fetchChapterSummaries(chapterNumber)

    const { citable, naming } = citableAndParallel(fetched)

    return {
      ok: true,
      chapterNumber,
      primary: { language: citable.language, text: citable.text, url: citable.url },
      ...(naming
        ? { parallel: { language: naming.language, text: naming.text, url: naming.url } }
        : {}),
      problems: fetched.problems.map(
        (problem) => `${problem.language === 'fr' ? 'Français' : 'Anglais'} : ${problem.reason}`,
      ),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Récupération impossible.',
    }
  }
}
