/**
 * Turning a written chapter into citable passages.
 *
 * Deliberately free of `server-only` and of every database import: the form
 * that accepts the text runs these same functions in the browser to show how
 * many passages the paste will become and which language it looks like. Two
 * implementations of "how is this cut up" — one for the preview, one for the
 * insert — is how a preview comes to lie.
 */

/**
 * The longest passage the splitter will produce, in characters.
 *
 * A passage is the unit of citation: a fact points at one, and you read it to
 * decide. Too long and the citation stops meaning anything — "it is somewhere
 * in these two thousand characters" is not evidence anyone checks at a glance.
 * Too short and a claim that legitimately spans two sentences has nowhere to
 * anchor, because an excerpt must fall inside a single passage.
 *
 * Around six hundred characters is three or four sentences of a detailed
 * summary: one beat of the chapter, readable without scrolling.
 */
export const MAX_PASSAGE_CHARS = 600

/** Below this, a stray line is merged into the passage it introduces. */
const MIN_PASSAGE_CHARS = 40

/**
 * The smallest summary worth processing.
 *
 * Not a quality bar — a mistake detector. A chapter submitted with a title and
 * one line is almost always a paste that went wrong, and finding that out after
 * a model call is a worse way to learn it.
 */
export const MIN_SUMMARY_CHARS = 120

/** Guards a runaway paste against a per-chapter cost nobody intended. */
export const MAX_SUMMARY_CHARS = 120_000

/**
 * Cut a summary into passages, never mid-sentence.
 *
 * Three levels, each used only when the one before it left something too long:
 * blank-line paragraphs, then single lines, then sentences. The order follows
 * how people actually write — a pasted summary may be paragraphs, may be one
 * bullet per line, may be a single unbroken block — and the same function has
 * to handle all three without being told which it got.
 *
 * A sentence longer than the cap is kept whole. Cutting inside one would put a
 * passage boundary in the middle of a clause, and an excerpt spanning that
 * boundary — the natural quote for the fact it states — would then match no
 * single passage and be quarantined as unanchored. A passage slightly over
 * budget costs a few tokens; a legitimate quote that cannot be cited is a
 * defect in the one guarantee this project sells.
 */
export function splitPassages(text: string): string[] {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

  if (cleaned.length === 0) return []

  const passages: string[] = []

  for (const paragraph of cleaned.split(/\n[ \t]*\n+/)) {
    const trimmed = paragraph.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length <= MAX_PASSAGE_CHARS) {
      passages.push(collapseNewlines(trimmed))
      continue
    }

    for (const line of splitByLines(trimmed)) {
      if (line.length <= MAX_PASSAGE_CHARS) {
        passages.push(collapseNewlines(line))
        continue
      }
      for (const chunk of splitBySentences(line)) {
        passages.push(collapseNewlines(chunk))
      }
    }
  }

  return mergeStragglers(passages)
}

/** Group the lines of an over-long paragraph into chunks within budget. */
function splitByLines(paragraph: string): string[] {
  return group(
    paragraph.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
    '\n',
  )
}

/**
 * Split on sentence ends, keeping the punctuation with the sentence it closes.
 *
 * The lookbehind requires a lowercase letter, a digit or a closing quote before
 * the stop, which keeps `M. Dupont` and `ch. 12` from reading as two sentences.
 * It is not a parser and does not need to be: a missed split leaves a passage a
 * little long, and a wrong split cannot lose text, because chunks are only ever
 * joined back together, never cut.
 */
function splitBySentences(line: string): string[] {
  const sentences = line
    .split(/(?<=[\p{Ll}\p{N}»"'\)\]][.!?…]["»']?)\s+/gu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

  return group(sentences.length > 0 ? sentences : [line], ' ')
}

/** Accumulate parts into chunks no longer than the cap, joining with `glue`. */
function group(parts: string[], glue: string): string[] {
  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    if (current.length === 0) {
      current = part
      continue
    }
    if (current.length + glue.length + part.length <= MAX_PASSAGE_CHARS) {
      current = `${current}${glue}${part}`
      continue
    }
    chunks.push(current)
    current = part
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * A heading on its own line is not a passage.
 *
 * `## Page 4` or `Scène 2 :` states no fact and can prove nothing, but it does
 * carry the context of what follows. Merged forward it reads as the opening of
 * the passage it introduces; left alone it is a citable source containing no
 * information, which is the worst of the two.
 */
function mergeStragglers(passages: string[]): string[] {
  const merged: string[] = []

  for (const passage of passages) {
    const previous = merged[merged.length - 1]
    if (
      previous !== undefined &&
      previous.length < MIN_PASSAGE_CHARS &&
      previous.length + 1 + passage.length <= MAX_PASSAGE_CHARS
    ) {
      merged[merged.length - 1] = `${previous}\n${passage}`
      continue
    }
    merged.push(passage)
  }

  return merged
}

/** Single newlines inside a passage are layout, not content. */
function collapseNewlines(value: string): string {
  return value.replace(/\n+/g, '\n').trim()
}

export type SummaryLanguage = 'fr' | 'en'

const FRENCH_MARKERS =
  /\b(le|la|les|des|une|dans|qui|que|est|sont|avec|pour|sur|puis|alors|lui|elle|ils|elles|son|sa|ses|leur|mais|plus|tout|quand|après|avant|chez|vers)\b/giu
const ENGLISH_MARKERS =
  /\b(the|and|of|to|in|that|is|are|with|for|on|then|his|her|their|they|but|more|all|when|after|before|from|into|about)\b/giu

/**
 * Which language was pasted.
 *
 * Counted on function words rather than guessed from accents, because a
 * well-written English summary of a Japanese work is full of proper nouns with
 * diacritics and an English text quoting French dialogue is not French. Function
 * words are the part of a text that its language cannot borrow.
 *
 * It informs a default the form shows and you can change — never a silent
 * decision. Getting it wrong costs a wrong `lang` on the passages; getting it
 * wrong *invisibly* would be a different matter, which is why the form says
 * what it detected instead of acting on it.
 */
export function detectLanguage(text: string): SummaryLanguage {
  const sample = text.slice(0, 8_000)
  const french = (sample.match(FRENCH_MARKERS) ?? []).length
  const english = (sample.match(ENGLISH_MARKERS) ?? []).length
  // Ties go to French: it is the language of the interface, and a French text
  // is the case where being wrong is most visible to the person who wrote it.
  return english > french ? 'en' : 'fr'
}
