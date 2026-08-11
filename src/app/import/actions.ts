'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { importChapter } from '@/domains/ingestion/import.ts'
import { IngestionRejection } from '@/domains/ingestion/limits.ts'
import { reorderPages } from '@/domains/ingestion/persist.ts'

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

    revalidatePath('/chapitres')
    revalidatePath(`/chapitres/${result.chapterId}`)

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
    revalidatePath(`/chapitres/${chapterId}`)
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
