/**
 * Renders the synthetic test corpus to the three input formats the importer
 * accepts: loose PNGs, a CBZ, and a PDF carrying a real text layer.
 *
 * All three come from one scene description, so the scene doubles as ground
 * truth: OCR output can be scored against the exact strings that were drawn,
 * and detected panels against the rectangles they were drawn in. No hand
 * labelling, and no copyrighted page anywhere in the repository.
 *
 *   pnpm fixtures:generate
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { CORPUS } from '../src/domains/fixtures/corpus.ts'
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type Rect,
  type SceneChapter,
  type ScenePage,
} from '../src/domains/fixtures/scene.ts'
import { buildZip } from '../tests/helpers/zip.ts'

const OUT = path.join(process.cwd(), 'fixtures', 'generated')

// Ink-on-paper palette. Deliberately plain: these pages exist to be parsed,
// not admired, and high contrast keeps the OCR comparison meaningful.
const PAPER = '#f4f1e8'
const INK = '#1b1b1b'
const BUBBLE_FILL = '#ffffff'
const TONE = '#d8d2c4'

function px(rect: Rect): { x: number; y: number; w: number; h: number } {
  return {
    x: rect.x * PAGE_WIDTH,
    y: rect.y * PAGE_HEIGHT,
    w: rect.w * PAGE_WIDTH,
    h: rect.h * PAGE_HEIGHT,
  }
}

/** Greedy wrap. Returns the lines that fit `maxWidth` at the current font. */
function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

function roundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function renderPng(page: ScenePage): Buffer {
  const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT)

  for (const panel of page.panels) {
    const r = px(panel.rect)

    // Panel: toned fill inside a heavy border. The gutters between them are
    // what the projection-profile detector keys on.
    ctx.fillStyle = TONE
    ctx.fillRect(r.x, r.y, r.w, r.h)
    ctx.strokeStyle = INK
    ctx.lineWidth = 6
    ctx.strokeRect(r.x, r.y, r.w, r.h)

    // A couple of strokes so a panel is not a flat rectangle — enough texture
    // that binarisation has something to do.
    ctx.strokeStyle = '#b9b1a0'
    ctx.lineWidth = 2
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo(r.x + 12, r.y + (r.h * i) / 4)
      ctx.lineTo(r.x + r.w - 12, r.y + (r.h * i) / 4 - 18)
      ctx.stroke()
    }

    for (const item of panel.texts) {
      const t = px(item.rect)
      const isSign = item.kind === 'sign'
      const isCaption = item.kind === 'caption'

      ctx.fillStyle = isSign ? '#e8dfc8' : BUBBLE_FILL
      if (isCaption || isSign) {
        ctx.fillRect(t.x, t.y, t.w, t.h)
        ctx.strokeStyle = INK
        ctx.lineWidth = 3
        ctx.strokeRect(t.x, t.y, t.w, t.h)
      } else {
        roundedRect(ctx, t.x, t.y, t.w, t.h, Math.min(t.w, t.h) * 0.28)
        ctx.fill()
        ctx.strokeStyle = INK
        ctx.lineWidth = 3
        ctx.stroke()
      }

      const fontSize = isSign ? 26 : 30
      ctx.fillStyle = INK
      ctx.font = `${fontSize}px sans-serif`
      ctx.textBaseline = 'top'
      const lines = wrap(ctx, item.text, t.w - 28)
      lines.forEach((line, i) => {
        ctx.fillText(line, t.x + 14, t.y + 14 + i * (fontSize + 6))
      })
    }
  }

  return canvas.toBuffer('image/png')
}

/**
 * PDF with a genuine text layer.
 *
 * Drawn as vectors and real text rather than an embedded raster, so
 * pdfjs-dist extracts the exact strings with coordinates. That path is free
 * and exact, which makes it both the preferred OCR source and the reference
 * the raster path is scored against.
 */
async function renderPdf(chapter: SceneChapter): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Corpus de test — chapitre ${chapter.number}`)
  pdf.setSubject(
    'Planches synthétiques générées pour la suite de tests. Aucun contenu protégé.',
  )
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  for (const page of chapter.pages) {
    const p = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    p.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: rgb(0.957, 0.945, 0.91),
    })

    for (const panel of page.panels) {
      const r = px(panel.rect)
      // PDF's origin is bottom-left; the scene's is top-left.
      const y = PAGE_HEIGHT - r.y - r.h

      p.drawRectangle({
        x: r.x,
        y,
        width: r.w,
        height: r.h,
        color: rgb(0.847, 0.824, 0.769),
        borderColor: rgb(0.106, 0.106, 0.106),
        borderWidth: 4,
      })

      for (const item of panel.texts) {
        const t = px(item.rect)
        const ty = PAGE_HEIGHT - t.y - t.h
        p.drawRectangle({
          x: t.x,
          y: ty,
          width: t.w,
          height: t.h,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.106, 0.106, 0.106),
          borderWidth: 2,
        })

        const size = item.kind === 'sign' ? 15 : 17
        // pdf-lib's standard fonts are WinAnsi: characters outside it (curly
        // apostrophes, en dashes) throw on encode. Fold them rather than
        // dropping the text — the OCR ground truth needs the same string the
        // raster page shows, and normalizeText() folds these anyway.
        const encodable = toWinAnsi(item.text)
        const lines = wrapForPdf(encodable, font, size, t.w - 20)
        lines.forEach((line, i) => {
          p.drawText(line, {
            x: t.x + 10,
            y: ty + t.h - 22 - i * (size + 5),
            size,
            font,
            color: rgb(0.106, 0.106, 0.106),
          })
        })
      }
    }
  }

  return pdf.save()
}

function toWinAnsi(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
}

function wrapForPdf(
  text: string,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const manifest: unknown[] = []

  for (const chapter of CORPUS) {
    const slug = `chapitre-${String(chapter.number).padStart(2, '0')}`
    const dir = path.join(OUT, slug)
    await mkdir(dir, { recursive: true })

    const pngs = chapter.pages.map((page) => ({
      name: `page-${String(page.index + 1).padStart(2, '0')}.png`,
      data: renderPng(page),
    }))

    for (const png of pngs) {
      await writeFile(path.join(dir, png.name), png.data)
    }

    await writeFile(path.join(OUT, `${slug}.cbz`), buildZip(pngs))
    await writeFile(path.join(OUT, `${slug}.pdf`), await renderPdf(chapter))

    manifest.push({
      number: chapter.number,
      title: chapter.title,
      pages: chapter.pages.length,
      images: `${slug}/`,
      cbz: `${slug}.cbz`,
      pdf: `${slug}.pdf`,
      expected: chapter.expected,
    })

    console.log(
      `  chapitre ${chapter.number} — ${chapter.pages.length} page(s) : PNG, CBZ, PDF`,
    )
  }

  // The ground truth, next to the artefacts it describes.
  await writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ generated: 'pnpm fixtures:generate', chapters: manifest }, null, 2),
  )

  console.log(`\nFixtures écrites dans ${path.relative(process.cwd(), OUT)}/`)
  console.log(
    'Planches synthétiques, personnages et dialogues inventés. Aucun contenu protégé.',
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
