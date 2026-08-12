import 'server-only'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { chapters, textBlocks, works } from '@/db/schema/documents.ts'
import { normalizeText } from '../knowledge/normalize.ts'
import { IngestionRejection } from './limits.ts'
import {
  MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  detectLanguage,
  splitPassages,
  type SummaryLanguage,
} from './passages.ts'

/**
 * Import a chapter as a text you wrote.
 *
 * The file path asked a model to look at a hundred and twenty drawings and
 * describe them, so that a second model could read those descriptions and
 * propose facts. This path removes the first half: you supply the prose
 * directly, and the passages of that prose are what every proposal must quote.
 *
 * Nothing about the guarantees changes, and one of them tightens. Evidence
 * anchoring compares a model's excerpt against the source text it cites; on
 * the file path that source was OCR, an approximation with its own errors, so
 * the comparison had to tolerate noise that a fabrication could hide in. Here
 * the source is exactly the characters you typed. An excerpt either occurs in
 * your text or it does not.
 *
 * What you lose is worth naming: there is no panel image behind a fact any
 * more, so "show me the case that proves it" becomes "show me the sentence
 * that says it". For a knowledge graph that is the same job — the proof was
 * always the words — but it is a real change to what a citation looks like.
 */

export interface SummaryImportRequest {
  userId: string
  workId: string
  chapterNumber: number
  title?: string
  volume?: number
  /**
   * The language the summary is written in.
   *
   * The best chapter summaries on the internet are often English, and the graph
   * is read in French. Recording which language the *source* is in matters
   * because it is the language every excerpt will be quoted in — a citation is
   * a copy, not a translation — while everything the model authors from it is
   * French. Omitted means "work it out from the text", which the form does too
   * and shows you before you submit.
   */
  language?: SummaryLanguage
  /** The chapter, written out. Paragraphs become passages. */
  text: string
  /**
   * The same chapter in the other language, when you have it.
   *
   * A naming aid and nothing else. The glossary (0016) stops the model
   * re-inventing a French form every chapter, but it starts empty and the first
   * chapters are answered with only one side of the evidence: a model reading
   * « Straw Hat Pirates » cannot find in an English text whether French readers
   * translate it. Both versions side by side contain that answer already —
   * whoever wrote the French one made the decision — so the model reads it off
   * instead of guessing.
   *
   * It is never citable. Its refs are not in the allowed list, so a proposal
   * quoting it is quarantined exactly like one quoting a reference that does
   * not exist.
   */
  parallelText?: string
}

export interface SummaryImportResult {
  chapterId: string
  passageCount: number
  characterCount: number
  language: SummaryLanguage
  /** Set when a second-language text was stored beside the passages. */
  parallelLanguage: SummaryLanguage | null
  /** True when this chapter already existed and its passages were replaced. */
  replaced: boolean
  /** Set when the same text was already imported for this chapter. */
  unchanged: boolean
}

export async function importSummary(
  request: SummaryImportRequest,
): Promise<SummaryImportResult> {
  if (!Number.isInteger(request.chapterNumber) || request.chapterNumber < 0) {
    throw new IngestionRejection(
      'invalid_chapter_number',
      `Numéro de chapitre invalide : ${String(request.chapterNumber)}`,
      'Le numéro doit être un entier positif.',
    )
  }

  const text = request.text.trim()

  if (text.length < MIN_SUMMARY_CHARS) {
    throw new IngestionRejection(
      'summary_too_short',
      `Ce résumé fait ${text.length} caractères ; il en faut au moins ${MIN_SUMMARY_CHARS}.`,
      'Chaque fait extrait devra citer une phrase de ce texte : plus il est détaillé, ' +
        'plus le graphe le sera.',
    )
  }

  if (text.length > MAX_SUMMARY_CHARS) {
    throw new IngestionRejection(
      'summary_too_long',
      `Ce résumé fait ${text.length} caractères (maximum ${MAX_SUMMARY_CHARS}).`,
      'Découpez-le, ou importez-le comme deux chapitres.',
    )
  }

  /*
   * The second text, and the single thing that can be wrong about it.
   *
   * Its language is the other one, by construction — there are two, and a pair
   * is what makes it useful. So it is not asked for and not detected, with one
   * exception: when detection is *confident* that it matches the primary, the
   * import refuses. That is not a language question, it is a paste that went
   * wrong — the same text in both boxes, which would hand the model every
   * sentence twice and teach it nothing about names. An unconfident guess is
   * ignored here rather than escalated: unlike the primary language it decides
   * nothing downstream, since no excerpt is ever quoted from this text.
   */
  const parallelText = request.parallelText?.trim() ?? ''
  let parallelLanguage: SummaryLanguage | null = null

  if (parallelText.length > 0) {
    if (parallelText.length < MIN_SUMMARY_CHARS) {
      throw new IngestionRejection(
        'parallel_too_short',
        `Le texte dans l'autre langue fait ${parallelText.length} caractères ; ` +
          `il en faut au moins ${MIN_SUMMARY_CHARS}.`,
        'Il sert à lire les noms des deux côtés : trop court, il ne contient ' +
          'aucune correspondance exploitable. Laissez-le vide plutôt qu’à moitié.',
      )
    }

    if (parallelText.length > MAX_SUMMARY_CHARS) {
      throw new IngestionRejection(
        'parallel_too_long',
        `Le texte dans l'autre langue fait ${parallelText.length} caractères ` +
          `(maximum ${MAX_SUMMARY_CHARS}).`,
        'Il est fourni au modèle à chaque tranche : sa longueur se paie autant ' +
          'que celle du texte principal.',
      )
    }
  }

  const passages = splitPassages(text)
  if (passages.length === 0) {
    throw new IngestionRejection(
      'summary_empty',
      'Ce résumé ne contient aucun passage exploitable.',
      'Vérifiez que le texte a bien été collé.',
    )
  }

  /*
   * The fingerprint covers the passages, not the raw paste.
   *
   * Re-pasting the same summary with a blank line added is the same source and
   * must not re-run the pipeline; changing a sentence is a different source and
   * must. Hashing what actually gets stored — and therefore what the model will
   * actually read — is the only version of that test that cannot be wrong.
   *
   * Which is why the second text counts too, though nothing cites it: the
   * pipeline reads it, so changing it changes the names that come out. Appended
   * rather than mixed in, so a chapter that has none hashes to exactly what it
   * hashed to before this existed — re-importing a chapter you have not touched
   * must stay a no-op rather than become a rewrite that orphans its evidence.
   */
  const fingerprint = createHash('sha256')
    .update(passages.join('\n\n'))
    .update(parallelText.length > 0 ? `\n\n<<parallèle>>\n\n${parallelText}` : '')
    .digest('hex')

  /*
   * The language is asked for when it cannot be told.
   *
   * Detection runs only as a fallback, and only when it is sure of itself. The
   * alternative — pick the more likely one and move on — would store an English
   * chapter marked French, and nothing downstream would ever contradict it: the
   * excerpts would still anchor, the graph would still build, and the only
   * symptom would be a `lang` column nobody reads. A refusal here is loud and
   * costs one click.
   */
  let language = request.language
  if (language === undefined) {
    const guess = detectLanguage(text)
    if (!guess.confident) {
      throw new IngestionRejection(
        'ambiguous_language',
        "Impossible de dire si ce texte est en français ou en anglais.",
        `Marqueurs relevés : ${guess.french} français, ${guess.english} anglais. ` +
          'Choisissez la langue vous-même — elle décide de la langue dans laquelle ' +
          'les extraits de ce chapitre seront cités.',
      )
    }
    language = guess.language
  }

  if (parallelText.length > 0) {
    const guess = detectLanguage(parallelText)
    if (guess.confident && guess.language === language) {
      throw new IngestionRejection(
        'parallel_same_language',
        `Les deux textes semblent être en ${language === 'fr' ? 'français' : 'anglais'}.`,
        'Le second texte doit être la version du chapitre dans l’autre langue : ' +
          'c’est la mise en regard qui donne la forme française des noms. ' +
          'Vérifiez que vous n’avez pas collé deux fois le même résumé.',
      )
    }
    parallelLanguage = language === 'fr' ? 'en' : 'fr'
  }

  return withIngest(async (db) => {
    const [work] = await db
      .select({ id: works.id })
      .from(works)
      .where(and(eq(works.id, request.workId), eq(works.userId, request.userId)))
      .limit(1)

    if (!work) {
      throw new IngestionRejection(
        'unknown_work',
        'Œuvre introuvable.',
        'Rechargez la page ; si le problème persiste, recréez la bibliothèque.',
      )
    }

    const [existing] = await db
      .select({
        id: chapters.id,
        fingerprint: chapters.sourceFingerprint,
        sourceKind: chapters.sourceKind,
      })
      .from(chapters)
      .where(
        and(eq(chapters.workId, request.workId), eq(chapters.number, request.chapterNumber)),
      )
      .limit(1)

    const values = {
      title: request.title ?? null,
      volume: request.volume ?? null,
      language,
      /*
       * Written on every import, null included.
       *
       * Same rule as the passages: an import states the whole source, it does
       * not add to it. Re-importing without the second text is how you remove
       * one, and leaving the old one in place would keep feeding the model a
       * translation of a summary you have since rewritten.
       */
      parallelText: parallelText.length > 0 ? parallelText : null,
      parallelLanguage,
      sourceKind: 'summary' as const,
      sourceFingerprint: fingerprint,
      status: 'uploaded' as const,
      pageCount: 0,
      updatedAt: new Date(),
    }

    let chapterId: string
    let replaced = false

    if (existing) {
      if (existing.fingerprint === fingerprint && existing.sourceKind === 'summary') {
        // Identical text already stored. Rewriting it would delete the passages
        // that existing evidence points at and orphan every fact citing them,
        // to arrive at exactly the same rows.
        return {
          chapterId: existing.id,
          passageCount: passages.length,
          characterCount: text.length,
          language,
          parallelLanguage,
          replaced: true,
          unchanged: true,
        }
      }
      await db.update(chapters).set(values).where(eq(chapters.id, existing.id))
      chapterId = existing.id
      replaced = true
    } else {
      const [created] = await db
        .insert(chapters)
        .values({
          workId: request.workId,
          userId: request.userId,
          number: request.chapterNumber,
          ...values,
        })
        .returning({ id: chapters.id })
      if (!created) throw new Error('Création du chapitre échouée.')
      chapterId = created.id
    }

    /*
     * Replace, never append.
     *
     * A corrected summary is the same chapter, and keeping the old passages
     * beside the new ones would offer the model both versions of every sentence
     * you fixed. Evidence pointing at a deleted passage is set to null by the
     * foreign key rather than cascading — the fact survives, uncited, and the
     * extraction step's re-anchoring pass gives it a citation in the new text.
     */
    await db.delete(textBlocks).where(eq(textBlocks.chapterId, chapterId))

    await db.insert(textBlocks).values(
      passages.map((passage, index) => ({
        chapterId,
        userId: request.userId,
        chapterNumber: request.chapterNumber,
        pageId: null,
        panelId: null,
        bbox: null,
        text: passage,
        normalizedText: normalizeText(passage),
        lang: language,
        confidence: 1,
        kind: 'other' as const,
        // You typed it. There is no more accurate source than that.
        source: 'manual' as const,
        readingOrder: index,
      })),
    )

    return {
      chapterId,
      passageCount: passages.length,
      characterCount: text.length,
      language,
      parallelLanguage,
      replaced,
      unchanged: false,
    }
  })
}

/** The passages of a chapter, in order — the source, as stored. */
export async function chapterPassages(
  userId: string,
  chapterId: string,
): Promise<Array<{ id: string; order: number; text: string }>> {
  return withIngest(async (db) => {
    const rows = await db
      .select({
        id: textBlocks.id,
        order: textBlocks.readingOrder,
        text: textBlocks.text,
      })
      .from(textBlocks)
      .where(and(eq(textBlocks.chapterId, chapterId), eq(textBlocks.userId, userId)))
      .orderBy(textBlocks.readingOrder)
    return rows
  })
}
