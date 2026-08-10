import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { IngestionRejection, type IngestionLimits } from './limits.ts'
import {
  isArchiveEntry,
  isImageEntry,
  isSafeEntryName,
  naturalCompare,
} from './validate.ts'

/**
 * Reads a ZIP/CBZ of page images.
 *
 * Archives are the most hostile input this application accepts, so the reader
 * refuses rather than repairs. Five distinct attacks are covered:
 *
 *   ZIP Slip      — an entry named `../../.ssh/authorized_keys`. Entry names
 *                   are validated *before* being used for anything, and the
 *                   name is never used as a filesystem path anyway: pages are
 *                   re-keyed by index.
 *   Zip bomb      — a few kilobytes expanding to gigabytes. Capped three ways:
 *                   per entry, in total, and by compression ratio.
 *   Entry flood   — hundreds of thousands of tiny entries, to exhaust memory
 *                   in the central directory. Capped by count.
 *   Nested archive— a ZIP inside a ZIP, to slip past a one-level scan.
 *                   Refused outright; never recursed into.
 *   Lying header  — a declared uncompressed size that does not match reality.
 *                   Bytes are counted as they are read, not trusted.
 */

export interface ArchivePage {
  /** Original entry name, kept for display and for reading order. */
  name: string
  bytes: Uint8Array
}

/**
 * Turn a yauzl error into a rejection the user can act on.
 *
 * yauzl performs its own validation and refuses traversal paths, absolute
 * paths and stored-entry size mismatches before our checks ever see the
 * entry — good, that is defence in depth working. But it throws generic
 * English `Error`s, and "invalid relative path: ../../x" is not something to
 * put in front of someone trying to import a chapter. The protection is
 * yauzl's; the explanation is ours.
 */
function translateZipError(error: unknown): IngestionRejection {
  if (error instanceof IngestionRejection) return error

  const message = error instanceof Error ? error.message : String(error)

  if (/invalid relative path|absolute path|invalid characters in fileName/i.test(message)) {
    return new IngestionRejection(
      'unsafe_path',
      `Chemin refusé dans l'archive : ${message}`,
      "L'archive contient un chemin absolu ou une traversée de répertoire. Elle n'a pas été importée.",
    )
  }

  // yauzl enforces the declared uncompressed size on both stored entries
  // ("size mismatch") and inflate streams ("too many bytes in the stream"),
  // so a header that lies about how far an entry expands is caught before our
  // own byte counter ever runs. The counter remains the guard for the case
  // where the header is honest and the entry is simply enormous.
  if (/size mismatch|too many bytes in the stream/i.test(message)) {
    return new IngestionRejection(
      'size_mismatch',
      `L'archive déclare une taille qui ne correspond pas à son contenu : ${message}`,
      "Les en-têtes de l'archive sont incohérents avec les données. Réexportez-la depuis votre outil habituel.",
    )
  }

  if (/encrypted/i.test(message)) {
    return new IngestionRejection(
      'encrypted_archive',
      "L'archive est protégée par mot de passe.",
      'Décompressez-la vous-même, puis importez les images directement.',
    )
  }

  return new IngestionRejection(
    'corrupt_archive',
    `L'archive est illisible : ${message}`,
    'Le fichier est probablement corrompu ou incomplet. Réexportez-le et réessayez.',
  )
}

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, autoClose: false },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(
            new IngestionRejection(
              'corrupt_archive',
              "L'archive est illisible.",
              'Le fichier est probablement corrompu ou incomplet. Réexportez-le et réessayez.',
            ),
          )
          return
        }
        resolve(zipfile)
      },
    )
  })
}

function readEntry(
  zipfile: ZipFile,
  entry: Entry,
  maxBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new IngestionRejection(
            'unreadable_entry',
            `Impossible de lire « ${entry.fileName} » dans l'archive.`,
            'Réexportez l’archive depuis votre outil habituel.',
          ),
        )
        return
      }

      const chunks: Buffer[] = []
      let total = 0

      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        // Count as we read. A declared uncompressed size is attacker-controlled
        // metadata; the byte counter is not.
        if (total > maxBytes) {
          stream.destroy()
          reject(
            new IngestionRejection(
              'entry_too_large',
              `« ${entry.fileName} » dépasse la taille maximale par fichier.`,
              'Une page isolée ne devrait pas peser autant. Vérifiez le contenu de l’archive.',
            ),
          )
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    })
  })
}

export async function readArchivePages(
  bytes: Uint8Array,
  limits: IngestionLimits,
): Promise<ArchivePage[]> {
  const zipfile = await openZip(bytes)

  try {
    if (zipfile.entryCount > limits.maxArchiveEntries) {
      throw new IngestionRejection(
        'too_many_entries',
        `L'archive contient ${zipfile.entryCount} entrées (maximum ${limits.maxArchiveEntries}).`,
        "Cette archive ne ressemble pas à un chapitre. Vérifiez qu'il s'agit du bon fichier.",
      )
    }

    const pages: ArchivePage[] = []
    let uncompressedTotal = 0

    await new Promise<void>((resolve, reject) => {
      zipfile.readEntry()

      zipfile.on('entry', (entry: Entry) => {
        void (async () => {
          try {
            const name = entry.fileName

            // Directories: nothing to read, but still name-checked so a
            // malicious directory entry cannot slip through unnoticed.
            if (name.endsWith('/')) {
              if (!isSafeEntryName(name.slice(0, -1))) {
                throw new IngestionRejection(
                  'unsafe_path',
                  `Chemin refusé dans l'archive : « ${name} ».`,
                  "L'archive contient un chemin qui sort du dossier (traversée de répertoire). Elle n'a pas été importée.",
                )
              }
              zipfile.readEntry()
              return
            }

            if (!isSafeEntryName(name)) {
              throw new IngestionRejection(
                'unsafe_path',
                `Chemin refusé dans l'archive : « ${name} ».`,
                "L'archive contient un chemin absolu ou une traversée de répertoire. Elle n'a pas été importée.",
              )
            }

            if (isArchiveEntry(name)) {
              throw new IngestionRejection(
                'nested_archive',
                `L'archive contient une autre archive : « ${name} ».`,
                'Décompressez le contenu vous-même et importez les images ou le PDF directement.',
              )
            }

            // Skip macOS resource forks and editor droppings rather than
            // failing on them — they are noise, not an attack.
            if (
              name.startsWith('__MACOSX/') ||
              name.split('/').pop()?.startsWith('.') === true ||
              name.endsWith('Thumbs.db')
            ) {
              zipfile.readEntry()
              return
            }

            if (!isImageEntry(name)) {
              throw new IngestionRejection(
                'unexpected_entry',
                `« ${name} » n'est pas une image.`,
                'Une archive de chapitre ne doit contenir que des images JPEG, PNG, WebP ou AVIF.',
              )
            }

            // Ratio check on declared sizes, before decompressing anything.
            if (
              entry.compressedSize > 0 &&
              entry.uncompressedSize / entry.compressedSize >
                limits.maxDecompressionRatio
            ) {
              throw new IngestionRejection(
                'decompression_bomb',
                `« ${name} » présente un taux de compression anormal ` +
                  `(${Math.round(entry.uncompressedSize / entry.compressedSize)}:1).`,
                "Ce fichier se comporte comme une bombe de décompression. L'archive n'a pas été importée.",
              )
            }

            const content = await readEntry(zipfile, entry, limits.maxEntryBytes)

            uncompressedTotal += content.byteLength
            if (uncompressedTotal > limits.maxUncompressedBytes) {
              throw new IngestionRejection(
                'archive_expands_too_far',
                "L'archive décompressée dépasse la taille maximale autorisée.",
                "Le contenu décompressé est disproportionné par rapport au fichier. L'import a été interrompu.",
              )
            }

            pages.push({ name, bytes: content })

            if (pages.length > limits.maxPages) {
              throw new IngestionRejection(
                'too_many_pages',
                `L'archive contient plus de ${limits.maxPages} pages.`,
                'Importez le chapitre en plusieurs fois, ou augmentez MAX_PAGES_PER_CHAPTER.',
              )
            }

            zipfile.readEntry()
          } catch (error) {
            reject(error)
          }
        })()
      })

      zipfile.on('end', resolve)
      zipfile.on('error', (error: unknown) => reject(translateZipError(error)))
    })

    if (pages.length === 0) {
      throw new IngestionRejection(
        'no_pages',
        "L'archive ne contient aucune image.",
        'Vérifiez que les pages sont bien au format JPEG, PNG, WebP ou AVIF.',
      )
    }

    // Natural order: page2 before page10, which a lexicographic sort would
    // get backwards and silently scramble the chapter.
    pages.sort((a, b) => naturalCompare(a.name, b.name))
    return pages
  } catch (error) {
    throw translateZipError(error)
  } finally {
    zipfile.close()
  }
}
