import type { BBox } from '@/db/schema/documents.ts'

/**
 * Panel detection by recursive projection cutting.
 *
 * Deterministic, dependency-free, and explainable — three properties that
 * matter more here than raw accuracy. Deterministic because the same page must
 * yield the same panels on every reprocessing run, or human corrections stop
 * matching. Dependency-free because OpenCV is not available in the target
 * environment. Explainable because when it gets a page wrong the user has to
 * be able to see why and redraw the boxes.
 *
 * The method: a manga page is mostly light gutters separating darker panels.
 * Project ink density onto each axis, find the wide light bands, cut there,
 * and recurse into each piece. Every panel carries a confidence, and a page
 * that comes out badly is flagged for manual correction rather than silently
 * accepted — a wrong panel means every quote inside it is attributed to the
 * wrong picture.
 */

export interface DetectedPanel {
  bbox: BBox
  readingOrder: number
  confidence: number
}

export interface PanelDetectionOptions {
  /** 'rtl' for manga, 'ltr' for western layouts. */
  direction: 'rtl' | 'ltr'
  /** Pixel value at or above which a pixel counts as page white. */
  whiteThreshold?: number
  /** Fraction of a line that must be white for the line to be a gutter. */
  gutterPurity?: number
  /** Minimum gutter width, as a fraction of the page's shorter side. */
  minGutter?: number
  /** Panels smaller than this fraction of the page are noise. */
  minPanelArea?: number
  maxDepth?: number
}

interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function detectPanels(
  grey: { data: Uint8Array; width: number; height: number },
  options: PanelDetectionOptions,
): DetectedPanel[] {
  /*
   * The criterion is "is this line pure page white", not "how much ink does it
   * contain".
   *
   * Measuring ink was the first attempt and it does not work: on a real page
   * the screentone inside a panel sits around 210 and the paper around 240, so
   * a threshold low enough to ignore tone also ignores everything except the
   * panel borders — at which point a row crossing a panel interior looks
   * exactly like a row crossing a gutter, and the recursion happily cuts
   * panels into slices.
   *
   * A gutter, by contrast, has a property nothing inside a panel has: it is
   * uniformly page-white all the way across. Even a mostly-empty panel crosses
   * its own borders. Borderless panels — used for flashbacks — are the known
   * weakness here, and they come out with low confidence rather than silently
   * over-split.
   */
  const {
    whiteThreshold = 240,
    gutterPurity = 0.99,
    minGutter = 0.012,
    minPanelArea = 0.01,
    maxDepth = 6,
  } = options

  const { width, height } = grey
  if (width === 0 || height === 0) return []

  const gutterPx = Math.max(3, Math.round(Math.min(width, height) * minGutter))

  const regions: Region[] = []
  cut({ x0: 0, y0: 0, x1: width, y1: height }, 0, 'horizontal')

  function cut(region: Region, depth: number, axis: 'horizontal' | 'vertical'): void {
    const w = region.x1 - region.x0
    const h = region.y1 - region.y0
    if (w <= 0 || h <= 0) return

    if (depth >= maxDepth) {
      regions.push(region)
      return
    }

    const pieces =
      axis === 'horizontal'
        ? splitHorizontally(region)
        : splitVertically(region)

    if (pieces.length <= 1) {
      // This axis found nothing. Try the other one once before giving up, so
      // a page that only splits vertically is not missed.
      const other = axis === 'horizontal' ? 'vertical' : 'horizontal'
      const alternative =
        other === 'horizontal' ? splitHorizontally(region) : splitVertically(region)

      if (alternative.length > 1) {
        for (const piece of alternative) cut(piece, depth + 1, axis)
      } else {
        regions.push(region)
      }
      return
    }

    const next = axis === 'horizontal' ? 'vertical' : 'horizontal'
    for (const piece of pieces) cut(piece, depth + 1, next)
  }

  /** Cut into horizontal bands: rows of panels stacked vertically. */
  function splitHorizontally(region: Region): Region[] {
    const rows: boolean[] = []
    for (let y = region.y0; y < region.y1; y++) {
      let white = 0
      for (let x = region.x0; x < region.x1; x++) {
        if ((grey.data[y * width + x] ?? 255) >= whiteThreshold) white++
      }
      // Content = anything that is not a clean gutter line.
      rows.push(white / (region.x1 - region.x0) < gutterPurity)
    }
    return bandsToRegions(rows, region, 'horizontal')
  }

  /** Cut into vertical bands: panels side by side within a row. */
  function splitVertically(region: Region): Region[] {
    const cols: boolean[] = []
    for (let x = region.x0; x < region.x1; x++) {
      let white = 0
      for (let y = region.y0; y < region.y1; y++) {
        if ((grey.data[y * width + x] ?? 255) >= whiteThreshold) white++
      }
      cols.push(white / (region.y1 - region.y0) < gutterPurity)
    }
    return bandsToRegions(cols, region, 'vertical')
  }

  function bandsToRegions(
    hasContent: boolean[],
    region: Region,
    axis: 'horizontal' | 'vertical',
  ): Region[] {
    const runs: Array<{ start: number; end: number }> = []
    let start: number | null = null

    for (let i = 0; i < hasContent.length; i++) {
      if (hasContent[i]) {
        start ??= i
      } else if (start !== null) {
        // Only close the run if the blank stretch is wide enough to be a
        // gutter; a single blank line inside a panel is not a boundary.
        let blank = 0
        let j = i
        while (j < hasContent.length && !hasContent[j]) {
          blank++
          j++
        }
        if (blank >= gutterPx) {
          runs.push({ start, end: i })
          start = null
          i = j - 1
        } else {
          i = j - 1
        }
      }
    }
    if (start !== null) runs.push({ start, end: hasContent.length })

    if (runs.length <= 1) return [region]

    return runs.map((run) =>
      axis === 'horizontal'
        ? { ...region, y0: region.y0 + run.start, y1: region.y0 + run.end }
        : { ...region, x0: region.x0 + run.start, x1: region.x0 + run.end },
    )
  }

  const pageArea = width * height
  const kept = regions.filter(
    (r) => ((r.x1 - r.x0) * (r.y1 - r.y0)) / pageArea >= minPanelArea,
  )

  // A page that resisted every cut is one panel; say so with low confidence
  // rather than returning nothing.
  if (kept.length === 0) {
    return [
      {
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        readingOrder: 0,
        confidence: 0.2,
      },
    ]
  }

  const boxes = kept.map((r) => ({
    x: r.x0 / width,
    y: r.y0 / height,
    w: (r.x1 - r.x0) / width,
    h: (r.y1 - r.y0) / height,
  }))

  const order = readingOrder(boxes, options.direction)

  return boxes.map((bbox, index) => ({
    bbox,
    readingOrder: order.indexOf(index),
    confidence: confidenceFor(bbox, kept.length),
  }))
}

/**
 * Reading order.
 *
 * Rows top to bottom; within a row, right to left for manga. Getting this
 * wrong reverses every conversation on the page, which produces a knowledge
 * graph that is confidently backwards rather than obviously broken — so the
 * direction is an explicit chapter setting, never inferred.
 */
export function readingOrder(
  boxes: BBox[],
  direction: 'rtl' | 'ltr',
): number[] {
  const rowTolerance = 0.06

  return boxes
    .map((bbox, index) => ({ bbox, index }))
    .sort((a, b) => {
      const sameRow = Math.abs(a.bbox.y - b.bbox.y) <= rowTolerance
      if (!sameRow) return a.bbox.y - b.bbox.y
      return direction === 'rtl'
        ? b.bbox.x + b.bbox.w - (a.bbox.x + a.bbox.w)
        : a.bbox.x - b.bbox.x
    })
    .map((entry) => entry.index)
}

/**
 * How much to trust a detected panel.
 *
 * Low confidence does not mean "probably wrong" — it means "worth a human
 * glance", and it is what routes a page to manual correction or to a model
 * pass instead of straight into the graph.
 */
function confidenceFor(bbox: BBox, panelCount: number): number {
  let score = 0.9

  // A sliver is usually a detection artefact rather than a panel.
  const area = bbox.w * bbox.h
  if (area < 0.03) score -= 0.35
  const aspect = bbox.w / Math.max(bbox.h, 1e-6)
  if (aspect > 12 || aspect < 1 / 12) score -= 0.3

  // One panel filling the page means the cuts found nothing to work with.
  if (panelCount === 1 && area > 0.85) score -= 0.4

  // A page cut into very many pieces is usually over-segmented.
  if (panelCount > 12) score -= 0.15

  return Math.max(0.05, Math.min(1, score))
}

/**
 * Assign a text block to the panel that contains it.
 *
 * This supersedes the geometric guesswork the PDF text grouper has to do
 * before panels are known: once the boxes exist, a block belongs to whichever
 * panel covers most of it. A block matching no panel keeps a null panel and is
 * still stored — page furniture is text too, and dropping it would lose
 * evidence.
 */
export function assignToPanel(
  block: BBox,
  panels: DetectedPanel[],
): number | null {
  let best: number | null = null
  let bestOverlap = 0

  panels.forEach((panel, index) => {
    const overlap = intersectionArea(block, panel.bbox)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = index
    }
  })

  const blockArea = block.w * block.h
  if (blockArea <= 0 || bestOverlap / blockArea < 0.5) return null
  return best
}

export function intersectionArea(a: BBox, b: BBox): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y
}

/** Intersection over union — how well a detected panel matches a known one. */
export function iou(a: BBox, b: BBox): number {
  const intersection = intersectionArea(a, b)
  const union = a.w * a.h + b.w * b.h - intersection
  return union <= 0 ? 0 : intersection / union
}
