import { describe, expect, it } from 'vitest'
import {
  fetchChapterRange,
  MAX_RANGE_LENGTH,
  type Fetcher,
} from '@/domains/ingestion/fandom.ts'

/**
 * Fetching a run of chapters instead of one.
 *
 * Three properties, and none of them is about speed. The first is that a hole
 * in the middle is an outcome: the French wiki lags the English one by hundreds
 * of chapters and either can be missing a page, so a range of ten that loses one
 * must still bring back nine. Aborting the batch would make the feature fail
 * exactly where catching up matters most.
 *
 * The second is order. The result order is the order the queue will process the
 * chapters in, and processing 14 before 13 puts back the blindness the queue
 * exists to remove — so it cannot be left to whichever request finished first.
 *
 * The third is the same security property the single fetch has, and repeating a
 * loop over it is precisely how it would be lost: the endpoints are constants,
 * and a number is the only thing taken from input.
 */

/** Answers for the chapters listed, and "no such page" for everything else. */
function stub(available: number[]): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (url: string) => {
    calls.push(url)
    const match = url.match(/Chapter(?:_|%20|\+|\s)(\d+)/i) ?? url.match(/Chapitre(?:_|%20|\+|\s)(\d+)/i)
    const chapter = match?.[1] ? Number(match[1]) : null

    if (chapter === null || !available.includes(chapter)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ error: { info: 'Page inexistante.' } }),
      }
    }

    if (url.includes('prop=sections')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ parse: { sections: [{ index: '2', line: 'Long Summary' }] } }),
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        parse: { text: { '*': `<p>Chapter ${chapter} happens in full.</p>` } },
      }),
    }
  }) as Fetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

describe('a range of chapters', () => {
  it('brings back every chapter it could, in chapter order', async () => {
    const entries = await fetchChapterRange(10, 14, stub([10, 11, 12, 13, 14]))

    expect(entries.map((entry) => entry.chapterNumber)).toEqual([10, 11, 12, 13, 14])
    for (const entry of entries) {
      expect(entry.error).toBeNull()
      expect(entry.fetched?.summaries.length).toBeGreaterThan(0)
    }
  })

  it('keeps the chapters around a hole rather than failing the batch', async () => {
    const entries = await fetchChapterRange(10, 12, stub([10, 12]))

    expect(entries).toHaveLength(3)
    expect(entries[0]!.fetched).not.toBeNull()
    expect(entries[2]!.fetched).not.toBeNull()

    // The missing one is reported, not omitted: a chapter silently absent from
    // the list is a chapter you import later without noticing you skipped it.
    expect(entries[1]!.chapterNumber).toBe(11)
    expect(entries[1]!.fetched).toBeNull()
    expect(entries[1]!.error).toMatch(/./)
  })

  it('holds chapter order whatever order the answers arrive in', async () => {
    /*
     * The requests are concurrent, so completion order is not request order.
     * Delaying the earliest chapter the longest is the arrangement that would
     * expose a result list built as answers land.
     */
    const inner = stub([20, 21, 22, 23])
    const delayed: Fetcher = async (url) => {
      const match = url.match(/Chapter(?:_|%20)(\d+)/i)
      const chapter = match?.[1] ? Number(match[1]) : 0
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 30 - chapter)))
      return inner(url)
    }

    const entries = await fetchChapterRange(20, 23, delayed)
    expect(entries.map((entry) => entry.chapterNumber)).toEqual([20, 21, 22, 23])
  })

  it('never requests anything but the two wikis', async () => {
    const fetcher = stub([1, 2])
    await fetchChapterRange(1, 2, fetcher)

    expect(fetcher.calls.length).toBeGreaterThan(0)
    for (const call of fetcher.calls) {
      expect(call.startsWith('https://onepiece.fandom.com/')).toBe(true)
    }
  })
})

describe('what a range refuses', () => {
  it('refuses a range longer than a reader will proof-read', async () => {
    await expect(fetchChapterRange(1, 1 + MAX_RANGE_LENGTH, stub([]))).rejects.toThrow(
      new RegExp(String(MAX_RANGE_LENGTH)),
    )
  })

  it('refuses a range that runs backwards instead of reversing it', async () => {
    // Silently swapping the bounds would import ten chapters from a typo.
    await expect(fetchChapterRange(20, 10, stub([]))).rejects.toThrow(/à l’envers/)
  })

  it('makes no request at all when the range is refused', async () => {
    const fetcher = stub([])
    await fetchChapterRange(20, 10, fetcher).catch(() => null)
    expect(fetcher.calls).toEqual([])
  })
})
