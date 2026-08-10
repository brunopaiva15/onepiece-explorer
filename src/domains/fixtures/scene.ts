/**
 * A page described as geometry and text, independent of how it is rendered.
 *
 * One description, three outputs: a PNG (raster, no text layer — the OCR path),
 * a CBZ of those PNGs, and a PDF whose text is real PDF text (the free, exact
 * extraction path). Because all three come from the same source, the scene
 * *is* the ground truth: OCR precision and recall, panel reading order and
 * citation accuracy can all be scored against it without anyone labelling
 * anything by hand.
 *
 * Used only by the fixture generator and the synthetic model provider. Nothing
 * here is product content.
 */

/** Normalised to [0,1] against page dimensions, like panels.bbox in the schema. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type TextKind = 'bubble' | 'caption' | 'sfx' | 'sign'

export interface SceneText {
  rect: Rect
  text: string
  kind: TextKind
  /** Who is speaking, when that is unambiguous from the art. */
  speaker?: string
}

export interface ScenePanel {
  rect: Rect
  /** Reading-order index within the page, right-to-left for manga. */
  order: number
  /** Factual description of what is drawn — the ground truth for the vision step. */
  description: string
  /** Characters visible in this panel, by fixture id. */
  visible: string[]
  texts: SceneText[]
}

export interface ScenePage {
  index: number
  kind: 'narrative' | 'cover' | 'bonus'
  panels: ScenePanel[]
}

export interface SceneChapter {
  number: number
  title: string
  pages: ScenePage[]
  /** What a perfect extraction would produce. Drives the evaluation suite. */
  expected: ChapterExpectation
}

export interface ChapterExpectation {
  /** Entities the chapter introduces or mentions, by fixture id. */
  entities: Array<{
    id: string
    type: string
    /** Label as it should be displayed at this chapter, and why. */
    label: string
    labelKind: 'placeholder' | 'alias' | 'true_name' | 'epithet'
  }>
  /** Relations a correct extraction should propose. */
  assertions: Array<{
    subject: string
    predicate: string
    object?: string
    /** The exact excerpt that proves it — must occur verbatim in a SceneText. */
    excerpt?: string
    knowledgeFrom: number
  }>
  /** Claims a model might make from outside knowledge. None must be accepted. */
  mustNotAppear?: string[]
}

export const PAGE_WIDTH = 1200
export const PAGE_HEIGHT = 1800

/** Grid helper: a panel spanning columns/rows of an implicit layout. */
export function cell(
  col: number,
  row: number,
  cols: number,
  rows: number,
  span: { cols?: number; rows?: number } = {},
): Rect {
  const gutter = 0.02
  const cw = (1 - gutter * (cols + 1)) / cols
  const ch = (1 - gutter * (rows + 1)) / rows
  const spanCols = span.cols ?? 1
  const spanRows = span.rows ?? 1
  return {
    x: gutter + col * (cw + gutter),
    y: gutter + row * (ch + gutter),
    w: cw * spanCols + gutter * (spanCols - 1),
    h: ch * spanRows + gutter * (spanRows - 1),
  }
}

/**
 * Reading order for a right-to-left layout: top to bottom, right to left
 * within a row. The panel detector must reproduce this from geometry alone.
 */
export function rtlOrder(rects: Rect[]): number[] {
  return rects
    .map((rect, index) => ({ rect, index }))
    .sort((a, b) => {
      const rowDelta = a.rect.y - b.rect.y
      if (Math.abs(rowDelta) > 0.08) return rowDelta
      // Same row: rightmost first.
      return b.rect.x - a.rect.x
    })
    .map((entry) => entry.index)
}
