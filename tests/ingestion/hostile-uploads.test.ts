import { describe, expect, it } from 'vitest'
import { readArchivePages } from '@/domains/ingestion/archive.ts'
import { ingestionLimits, IngestionRejection } from '@/domains/ingestion/limits.ts'
import {
  isSafeEntryName,
  naturalCompare,
  validateUpload,
} from '@/domains/ingestion/validate.ts'
import { buildZip, tinyPng } from '../helpers/zip.ts'

/**
 * Uploads are the only place this application accepts bytes from outside.
 * Everything here is an attack the ingestion path must refuse, plus the
 * legitimate inputs it must still accept.
 *
 * Each rejection is asserted to carry an actionable hint. "Fichier invalide"
 * is not a usable error message; the user needs to know what to fix.
 */

const limits = ingestionLimits()

function expectRejection(
  promise: Promise<unknown>,
  code: string,
): Promise<IngestionRejection> {
  return promise.then(
    () => {
      throw new Error(`Attendu : rejet « ${code} ». Obtenu : acceptation.`)
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(IngestionRejection)
      const rejection = error as IngestionRejection
      expect(rejection.code).toBe(code)
      expect(rejection.hint.length).toBeGreaterThan(20)
      return rejection
    },
  )
}

describe('entry name safety', () => {
  it.each([
    ['parent traversal', '../../.ssh/authorized_keys'],
    ['nested traversal', 'pages/../../etc/passwd'],
    ['absolute unix', '/etc/passwd'],
    ['absolute windows', 'C:\\Windows\\System32\\config'],
    ['backslash separator', 'pages\\..\\..\\secret'],
    ['null byte', 'page\u0000.png'],
    ['control character', 'page\u0001.png'],
    ['empty', ''],
  ])('refuses %s', (_label, name) => {
    expect(isSafeEntryName(name)).toBe(false)
  })

  it.each([
    'page-01.png',
    'pages/page-01.png',
    'chapitre 1/page..01.png',
    'Ünïcodé pagé.png',
  ])('accepts the legitimate name %s', (name) => {
    expect(isSafeEntryName(name)).toBe(true)
  })
})

describe('content sniffing', () => {
  it('rejects a ZIP wearing a .pdf extension', async () => {
    const zip = buildZip([{ name: 'page-01.png', data: tinyPng() }])
    await expectRejection(
      validateUpload(zip, 'chapitre-1.pdf', limits),
      'extension_mismatch',
    )
  })

  it('rejects an unrecognised format', async () => {
    const bytes = Buffer.from('ceci n’est pas un fichier reconnu, du tout')
    await expectRejection(
      validateUpload(bytes, 'chapitre.bin', limits),
      'unknown_format',
    )
  })

  it('rejects an empty file', async () => {
    await expectRejection(
      validateUpload(new Uint8Array(0), 'vide.pdf', limits),
      'empty_file',
    )
  })

  it('rejects an oversized upload', async () => {
    const tiny = { ...limits, maxUploadBytes: 10 }
    await expectRejection(
      validateUpload(tinyPng(), 'page.png', tiny),
      'too_large',
    )
  })

  it('labels a ZIP named .cbz as a CBZ', async () => {
    const zip = buildZip([{ name: 'page-01.png', data: tinyPng() }])
    const result = await validateUpload(zip, 'chapitre-1.cbz', limits)
    expect(result.kind).toBe('cbz')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts a bare image', async () => {
    const result = await validateUpload(tinyPng(), 'page-01.png', limits)
    expect(result.kind).toBe('images')
    expect(result.mime).toBe('image/png')
  })
})

describe('archive attacks', () => {
  it('refuses ZIP Slip', async () => {
    const zip = buildZip([
      { name: 'page-01.png', data: tinyPng() },
      { name: '../../../.ssh/authorized_keys', data: Buffer.from('pwned') },
    ])
    const rejection = await expectRejection(
      readArchivePages(zip, limits),
      'unsafe_path',
    )
    expect(rejection.hint).toContain('traversée de répertoire')
  })

  it('refuses an absolute path entry', async () => {
    const zip = buildZip([{ name: '/etc/passwd', data: Buffer.from('root:x') }])
    await expectRejection(readArchivePages(zip, limits), 'unsafe_path')
  })

  it('refuses a nested archive rather than recursing into it', async () => {
    const inner = buildZip([{ name: 'page-01.png', data: tinyPng() }])
    const outer = buildZip([
      { name: 'page-01.png', data: tinyPng() },
      { name: 'bonus.zip', data: inner },
    ])
    await expectRejection(readArchivePages(outer, limits), 'nested_archive')
  })

  it('refuses a decompression bomb by ratio', async () => {
    // 8 MB of zeroes compresses to a few kilobytes — a classic bomb shape.
    const zip = buildZip([
      { name: 'page-01.png', data: Buffer.alloc(8 * 1024 * 1024), compress: true },
    ])
    await expectRejection(readArchivePages(zip, limits), 'decompression_bomb')
  })

  it('refuses an archive whose contents exceed the total cap, even if each entry is small', async () => {
    const oneMb = Buffer.alloc(1024 * 1024, 0x41)
    const zip = buildZip(
      Array.from({ length: 12 }, (_, i) => ({
        name: `page-${String(i).padStart(2, '0')}.png`,
        data: oneMb,
      })),
    )
    const strict = { ...limits, maxUncompressedBytes: 4 * 1024 * 1024 }
    await expectRejection(
      readArchivePages(zip, strict),
      'archive_expands_too_far',
    )
  })

  it('catches a stored entry whose declared size is a lie', async () => {
    // The header claims one byte; the entry really carries 2 MB. yauzl detects
    // the mismatch on stored entries before we read a byte — defence in depth
    // working — and we translate it into something the user can act on.
    const zip = buildZip([
      {
        name: 'page-01.png',
        data: Buffer.alloc(2 * 1024 * 1024, 0x42),
        fakeUncompressedSize: 1,
      },
    ])
    const rejection = await expectRejection(
      readArchivePages(zip, limits),
      'size_mismatch',
    )
    expect(rejection.hint).toContain('en-têtes')
  })

  it('catches a deflated entry that lies about its size', async () => {
    // yauzl enforces the declared size on the inflate stream too, so the lie
    // is caught mid-decompression rather than after the payload has landed.
    const zip = buildZip([
      {
        name: 'page-01.png',
        data: Buffer.alloc(2 * 1024 * 1024, 0x42),
        compress: true,
        fakeUncompressedSize: 512,
      },
    ])
    const permissive = { ...limits, maxDecompressionRatio: Number.MAX_SAFE_INTEGER }
    await expectRejection(readArchivePages(zip, permissive), 'size_mismatch')
  })

  it('counts bytes as it reads, for an honestly-declared but enormous entry', async () => {
    // Header and payload agree; the entry is simply far too big for one page.
    // Nothing upstream objects, so our own counter is the guard here.
    const zip = buildZip([
      { name: 'page-01.png', data: Buffer.alloc(2 * 1024 * 1024, 0x42), compress: true },
    ])
    const permissive = {
      ...limits,
      maxEntryBytes: 1024,
      maxDecompressionRatio: Number.MAX_SAFE_INTEGER,
    }
    await expectRejection(readArchivePages(zip, permissive), 'entry_too_large')
  })

  it('refuses an entry flood', async () => {
    const zip = buildZip(
      Array.from({ length: 40 }, (_, i) => ({
        name: `page-${i}.png`,
        data: tinyPng(),
      })),
    )
    const strict = { ...limits, maxArchiveEntries: 10 }
    await expectRejection(readArchivePages(zip, strict), 'too_many_entries')
  })

  it('refuses more pages than a chapter can plausibly have', async () => {
    const zip = buildZip(
      Array.from({ length: 30 }, (_, i) => ({
        name: `page-${String(i).padStart(3, '0')}.png`,
        data: tinyPng(),
      })),
    )
    const strict = { ...limits, maxPages: 5 }
    await expectRejection(readArchivePages(zip, strict), 'too_many_pages')
  })

  it('refuses a non-image entry', async () => {
    const zip = buildZip([
      { name: 'page-01.png', data: tinyPng() },
      { name: 'lisez-moi.txt', data: Buffer.from('notes') },
    ])
    await expectRejection(readArchivePages(zip, limits), 'unexpected_entry')
  })

  it('refuses an archive with no images at all', async () => {
    const zip = buildZip([{ name: '__MACOSX/._page.png', data: Buffer.from('x') }])
    await expectRejection(readArchivePages(zip, limits), 'no_pages')
  })

  it('reports a corrupt archive as corrupt', async () => {
    await expectRejection(
      readArchivePages(Buffer.from('PK\u0003\u0004 puis n’importe quoi'), limits),
      'corrupt_archive',
    )
  })
})

describe('legitimate archives', () => {
  it('reads pages and ignores macOS and editor noise', async () => {
    const zip = buildZip([
      { name: '__MACOSX/._page-01.png', data: Buffer.from('junk') },
      { name: 'page-02.png', data: tinyPng() },
      { name: 'chapitre/.DS_Store', data: Buffer.from('junk') },
      { name: 'page-01.png', data: tinyPng() },
      { name: 'Thumbs.db', data: Buffer.from('junk') },
    ])
    const pages = await readArchivePages(zip, limits)
    expect(pages.map((p) => p.name)).toEqual(['page-01.png', 'page-02.png'])
  })

  it('orders pages the way a human reads them, not lexicographically', async () => {
    const zip = buildZip(
      ['page10.png', 'page2.png', 'page1.png', 'page20.png'].map((name) => ({
        name,
        data: tinyPng(),
      })),
    )
    const pages = await readArchivePages(zip, limits)
    expect(pages.map((p) => p.name)).toEqual([
      'page1.png',
      'page2.png',
      'page10.png',
      'page20.png',
    ])
  })

  it('sorts numerically in the comparator itself', () => {
    const names = ['p10', 'p9', 'p1', 'p100'].sort(naturalCompare)
    expect(names).toEqual(['p1', 'p9', 'p10', 'p100'])
  })
})
