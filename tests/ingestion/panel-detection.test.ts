import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assignToPanel,
  detectPanels,
  iou,
  readingOrder,
} from '@/domains/documents/panels.ts'
import {
  DUPLICATE_DISTANCE,
  greyscaleMatrix,
  hammingDistance,
  normalisePage,
  perceptualHash,
} from '@/domains/documents/images.ts'
import { ingestionLimits } from '@/domains/ingestion/limits.ts'
import { CORPUS } from '@/domains/fixtures/corpus.ts'
import { rtlOrder } from '@/domains/fixtures/scene.ts'

/**
 * Panel detection, scored against the rectangles the fixtures were drawn in.
 *
 * A wrong panel is not a cosmetic problem: every quote inside it is attributed
 * to the wrong picture, so the evidence link — the thing that makes a fact
 * checkable — points somewhere misleading. And a reversed reading order
 * produces a graph that is confidently backwards rather than obviously broken.
 */

const limits = ingestionLimits()
const FIXTURES = path.join(process.cwd(), 'fixtures', 'generated')

async function pagePng(chapter: number, page: number): Promise<Uint8Array> {
  const file = path.join(
    FIXTURES,
    `chapitre-${String(chapter).padStart(2, '0')}`,
    `page-${String(page).padStart(2, '0')}.png`,
  )
  try {
    return new Uint8Array(await readFile(file))
  } catch {
    throw new Error(
      `Fixture manquante : ${file}\nLancez « pnpm fixtures:generate » d'abord.`,
    )
  }
}

describe('panel detection against known geometry', () => {
  it('finds every panel of a four-panel page', async () => {
    const grey = await greyscaleMatrix(await pagePng(1, 1), limits)
    const detected = detectPanels(grey, { direction: 'rtl' })

    const expected = CORPUS[0]!.pages[0]!.panels
    expect(detected).toHaveLength(expected.length)

    // Each drawn panel should have a detection overlapping it well.
    for (const panel of expected) {
      const best = Math.max(...detected.map((d) => iou(d.bbox, panel.rect)))
      expect(
        best,
        `Aucune case détectée ne recouvre ${JSON.stringify(panel.rect)}`,
      ).toBeGreaterThan(0.7)
    }
  })

  it('reads right to left within a row, top to bottom overall', async () => {
    const grey = await greyscaleMatrix(await pagePng(1, 1), limits)
    const detected = detectPanels(grey, { direction: 'rtl' })

    const expected = CORPUS[0]!.pages[0]!.panels
    const expectedOrder = rtlOrder(expected.map((p) => p.rect))

    // Walk the detections in the order the detector proposes and check each
    // one lands where the scene says that position should be.
    const byOrder = [...detected].sort((a, b) => a.readingOrder - b.readingOrder)

    byOrder.forEach((panel, position) => {
      const expectedPanel = expected[expectedOrder[position]!]!
      expect(
        iou(panel.bbox, expectedPanel.rect),
        `Position de lecture ${position} : case détectée ${JSON.stringify(panel.bbox)} ` +
          `attendue ${JSON.stringify(expectedPanel.rect)}`,
      ).toBeGreaterThan(0.7)
    })
  })

  it('reverses the order for a left-to-right layout', () => {
    const boxes = [
      { x: 0.05, y: 0.05, w: 0.4, h: 0.4 },
      { x: 0.55, y: 0.05, w: 0.4, h: 0.4 },
    ]
    expect(readingOrder(boxes, 'rtl')).toEqual([1, 0])
    expect(readingOrder(boxes, 'ltr')).toEqual([0, 1])
  })

  it('handles a two-panel page', async () => {
    const grey = await greyscaleMatrix(await pagePng(1, 2), limits)
    const detected = detectPanels(grey, { direction: 'rtl' })
    expect(detected).toHaveLength(2)
    expect(detected.every((p) => p.confidence > 0.5)).toBe(true)
  })

  it('finds the same panels whatever resolution it works at', async () => {
    /*
     * Detection used to pass at 800 px and fail at 900 — non-monotonically,
     * which is the signature of a threshold sitting on top of the data rather
     * than beside it. The cause was the fixture, not the detector: a 2 %
     * gutter is a couple of pixels wide once downscaled and antialiased, so
     * whether it survived depended on where the rounding fell. Real manga
     * gutters are 3-5 %.
     *
     * The analysis width is a free parameter — chosen for speed, not
     * correctness — so a result that depends on it is a result that will move
     * the next time somebody tunes it. This sweep is what makes that
     * dependency visible instead of latent.
     */
    const source = await pagePng(1, 1)
    const expected = CORPUS[0]!.pages[0]!.panels

    for (const width of [500, 700, 900, 1100, 1300]) {
      const grey = await greyscaleMatrix(source, limits, width)
      const detected = detectPanels(grey, { direction: 'rtl' })

      expect(detected, `Largeur ${width} px`).toHaveLength(expected.length)

      for (const panel of expected) {
        const best = Math.max(...detected.map((d) => iou(d.bbox, panel.rect)))
        expect(
          best,
          `Largeur ${width} px : aucune case ne recouvre ${JSON.stringify(panel.rect)}`,
        ).toBeGreaterThan(0.85)
      }
    }
  })

  it('returns one low-confidence panel rather than nothing for a blank page', () => {
    const blank = {
      data: new Uint8Array(200 * 300).fill(255),
      width: 200,
      height: 300,
    }
    const detected = detectPanels(blank, { direction: 'rtl' })
    expect(detected).toHaveLength(1)
    // Low confidence is the signal that routes this page to human review
    // instead of straight into the graph.
    expect(detected[0]!.confidence).toBeLessThan(0.6)
  })
})

describe('assigning text to panels', () => {
  it('puts a block in the panel that contains it', () => {
    const panels = [
      { bbox: { x: 0, y: 0, w: 0.45, h: 0.5 }, readingOrder: 1, confidence: 0.9 },
      { bbox: { x: 0.55, y: 0, w: 0.45, h: 0.5 }, readingOrder: 0, confidence: 0.9 },
    ]
    expect(assignToPanel({ x: 0.6, y: 0.1, w: 0.2, h: 0.05 }, panels)).toBe(1)
    expect(assignToPanel({ x: 0.05, y: 0.1, w: 0.2, h: 0.05 }, panels)).toBe(0)
  })

  it('leaves page furniture unassigned rather than forcing it into a panel', () => {
    const panels = [
      { bbox: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, readingOrder: 0, confidence: 0.9 },
    ]
    // Sits in the margin, overlapping nothing. Still stored — dropping it
    // would lose evidence — but attached to no panel.
    expect(assignToPanel({ x: 0.8, y: 0.9, w: 0.15, h: 0.03 }, panels)).toBeNull()
  })
})

describe('image normalisation', () => {
  it('produces display and thumbnail derivatives and reports dimensions', async () => {
    const result = await normalisePage(await pagePng(1, 1), limits)

    expect(result.width).toBe(1200)
    expect(result.height).toBe(1800)
    expect(result.isDoubleSpread).toBe(false)
    // WebP magic: RIFF....WEBP
    expect(result.display.subarray(0, 4).toString()).toBe('RIFF')
    expect(result.display.subarray(8, 12).toString()).toBe('WEBP')
    expect(result.thumb.byteLength).toBeLessThan(result.display.byteLength)
    expect(result.phash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('recognises the same page re-encoded as a duplicate', async () => {
    const original = await pagePng(1, 1)
    const { display } = await normalisePage(original, limits)

    const a = await perceptualHash(original, limits)
    const b = await perceptualHash(display, limits)

    // Different bytes, different format, same picture: a content hash would
    // call these unrelated, which is why duplicate detection is perceptual.
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(DUPLICATE_DISTANCE)
  })

  it('tells two different pages apart', async () => {
    const a = await perceptualHash(await pagePng(1, 1), limits)
    const b = await perceptualHash(await pagePng(3, 2), limits)
    expect(hammingDistance(a, b)).toBeGreaterThan(DUPLICATE_DISTANCE)
  })

  it('keeps re-encodings and distinct pages on opposite sides of the threshold', async () => {
    /*
     * The threshold is only meaningful if the two distributions do not touch.
     * This pins the gap rather than a single comparison: every page's
     * re-encoding must land nearer than every pair of different pages, on the
     * whole fixture corpus. If a change to the hash narrows that gap, this
     * fails before duplicate detection starts guessing in production.
     */
    const pages = [
      [1, 1],
      [1, 2],
      [2, 1],
      [3, 1],
      [3, 2],
    ] as const

    const sources = await Promise.all(pages.map(([c, p]) => pagePng(c, p)))
    const originals = await Promise.all(sources.map((b) => perceptualHash(b, limits)))
    const reencoded = await Promise.all(
      sources.map(async (bytes) =>
        perceptualHash((await normalisePage(bytes, limits)).display, limits),
      ),
    )

    const sameDistances = originals.map((h, i) => hammingDistance(h, reencoded[i]!))

    const differentDistances: number[] = []
    for (let i = 0; i < originals.length; i++) {
      for (let j = i + 1; j < originals.length; j++) {
        differentDistances.push(hammingDistance(originals[i]!, originals[j]!))
      }
    }

    const worstSame = Math.max(...sameDistances)
    const closestDifferent = Math.min(...differentDistances)

    expect(worstSame, `Ré-encodages : ${sameDistances.join(', ')}`).toBeLessThanOrEqual(
      DUPLICATE_DISTANCE,
    )
    expect(
      closestDifferent,
      `Pages distinctes : ${differentDistances.join(', ')}`,
    ).toBeGreaterThan(DUPLICATE_DISTANCE)
  })

  it('refuses a page beyond the pixel limit', async () => {
    const strict = { ...limits, maxPixelsPerPage: 1000 }
    await expect(normalisePage(await pagePng(1, 1), strict)).rejects.toMatchObject(
      { code: expect.stringMatching(/page_too_large|unreadable_image/) },
    )
  })
})
