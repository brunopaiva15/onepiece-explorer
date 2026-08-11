import 'server-only'
import { modelProvider } from '../ai/index.ts'
import { normalizeText } from '../knowledge/normalize.ts'
import { isAssistantEnabled } from '@/lib/env.ts'
import { consume } from '../observability/rate-limit.ts'
import { buildContext, type AssistantContext, type ContextEntry } from './context.ts'

/**
 * Answer a question, and check the answer against what was actually available.
 *
 * The prompt already tells the model to cite its sources and to say
 * "insufficient data" rather than guess. That is a request. This is the
 * enforcement, and it is the same shape as evidence anchoring on the extraction
 * side: extraction verifies that a proposal cites a real panel, and this
 * verifies that an answer cites an assertion the model was actually given.
 *
 * The failure it exists to catch is specific. A model handed twelve assertions
 * about a ferryman will, asked a thirteenth thing, sometimes produce a fluent
 * sentence with a citation shaped exactly like the real ones — right format,
 * plausible chapter, id that looks like the others. That answer is
 * indistinguishable from a true one by eye, and it is the single worst output
 * this product can produce, because the whole claim is that everything in it is
 * checkable.
 *
 * So: every citation is matched against the context by id. Unmatched citations
 * are dropped. An answer left with no citations at all becomes "insufficient
 * data" — never a bare claim.
 */

export interface Citation {
  assertionId: string
  chapter: number
  excerpt: string
  /** The statement as the context had it, not as the model retold it. */
  statement: string
}

export interface AssistantAnswer {
  question: string
  boundaryChapter: number
  insufficientData: boolean
  answer: string
  citations: Citation[]
  /** Citations the model produced that were not in the context. */
  droppedCitations: Array<{ assertionId: string; why: string }>
  /** Entities the search looked at, so the reader can check the ground covered. */
  entityIds: string[]
  /** Search modes that could not run. */
  notes: string[]
  costCents: number
  modelId: string | null
}

export async function ask(
  userId: string,
  boundaryChapter: number,
  question: string,
): Promise<AssistantAnswer> {
  const trimmed = question.trim()

  if (trimmed.length === 0) {
    return empty(trimmed, boundaryChapter, 'Posez une question.')
  }

  /*
   * The switch, checked before anything else.
   *
   * Not in the page — here, in the only function that can reach a model. A
   * guard in the interface would leave the expensive path one forgotten import
   * away, and the thing being guarded is somebody's card.
   */
  if (!isAssistantEnabled()) {
    return empty(
      trimmed,
      boundaryChapter,
      "L'assistant conversationnel est désactivé. Chaque question appelle un " +
        'modèle et se facture à la question, indéfiniment — ce n’est pas ce que cet ' +
        'outil est. Pour l’activer malgré tout : ASSISTANT_ENABLED=1. La recherche ' +
        'plein texte, approchante et par graphe, elle, ne coûte rien et cherche dans ' +
        'les mêmes données.',
    )
  }

  /*
   * Rate limit before retrieving, not after.
   *
   * The threat here is a loop rather than an attacker — a retry firing on every
   * render, a page that re-asks on focus. Checking after the search would still
   * do the database work; checking after the model call would still pay for it.
   */
  const allowance = await consume(userId, 'ask')
  if (!allowance.allowed) {
    return empty(
      trimmed,
      boundaryChapter,
      `Limite atteinte : ${allowance.used} questions dans l'heure. ` +
        `Réessayez dans ${allowance.retryInMinutes} minute(s). ${allowance.explain}`,
    )
  }

  const context = await buildContext(userId, boundaryChapter, trimmed)

  /*
   * No context means no call.
   *
   * Asking a model to answer from nothing is asking it to answer from training
   * data, and it will — fluently, about the right work, and about chapters the
   * reader has not opened. The call is skipped rather than made and filtered,
   * because the cheapest way to not leak is not to ask.
   */
  if (context.entries.length === 0) {
    return {
      ...empty(
        trimmed,
        boundaryChapter,
        boundaryChapter === 0
          ? "Aucun chapitre n'est encore publié : il n'y a rien à interroger."
          : `Rien dans les chapitres 1 à ${boundaryChapter} ne se rapporte à cette question. ` +
            `Élargissez la question, remontez le curseur, ou importez le chapitre concerné.`,
      ),
      entityIds: context.entityIds,
      notes: context.notes,
    }
  }

  const provider = modelProvider()
  const result = await provider.answer({
    question: trimmed,
    context: context.entries.map((entry) => ({
      assertionId: entry.assertionId,
      chapter: entry.chapter,
      statement: entry.statement,
      excerpt: entry.excerpt,
    })),
    boundaryChapter,
  })

  if (result.refusal) {
    return {
      ...empty(trimmed, boundaryChapter, result.refusal),
      entityIds: context.entityIds,
      notes: context.notes,
      costCents: result.usage.costCents,
      modelId: result.usage.modelId,
    }
  }

  const verified = verifyCitations(result.value.citations, context)

  /*
   * An answer whose citations all failed is not a partly-good answer.
   *
   * It is a paragraph with nothing behind it, and presenting it with a warning
   * would still put the sentence in front of the reader — which is the part
   * that does the damage. It becomes insufficient data.
   */
  const unsupported =
    !result.value.insufficient_data &&
    verified.citations.length === 0 &&
    result.value.citations.length > 0

  if (unsupported) {
    return {
      question: trimmed,
      boundaryChapter,
      insufficientData: true,
      answer:
        "Aucune des sources citées ne correspond à ce que vos chapitres contiennent. " +
        "La réponse a été écartée plutôt que présentée : une affirmation sans source " +
        'vérifiable ressemble exactement à une affirmation vraie.',
      citations: [],
      droppedCitations: verified.dropped,
      entityIds: context.entityIds,
      notes: context.notes,
      costCents: result.usage.costCents,
      modelId: result.usage.modelId,
    }
  }

  return {
    question: trimmed,
    boundaryChapter,
    insufficientData: result.value.insufficient_data,
    answer: result.value.answer,
    citations: verified.citations,
    droppedCitations: verified.dropped,
    entityIds: context.entityIds,
    notes: context.notes,
    costCents: result.usage.costCents,
    modelId: result.usage.modelId,
  }
}

/**
 * Match each citation against the context by assertion id.
 *
 * Matching on the id and nothing else is deliberate. A looser rule — accept a
 * citation whose excerpt appears somewhere in the context — would let the model
 * attach a real quote from one assertion to a claim about another, which is a
 * more convincing error than an invented id and just as wrong.
 *
 * The returned excerpt and statement come from the *context*, not from the
 * model's reply. If the model paraphrased the quote while citing a real id, the
 * reader sees what the page actually says.
 */
export function verifyCitations(
  claimed: Array<{ assertion_id: string; chapter: number; excerpt: string }>,
  context: AssistantContext,
): { citations: Citation[]; dropped: Array<{ assertionId: string; why: string }> } {
  const byId = new Map(context.entries.map((entry) => [entry.assertionId, entry]))

  const citations: Citation[] = []
  const dropped: Array<{ assertionId: string; why: string }> = []
  const seen = new Set<string>()

  for (const citation of claimed) {
    const entry = byId.get(citation.assertion_id)

    if (!entry) {
      dropped.push({
        assertionId: citation.assertion_id,
        why:
          "Cet identifiant ne figure pas dans le contexte fourni au modèle. " +
          "C'est le signe d'une source inventée.",
      })
      continue
    }

    if (entry.chapter > context.boundaryChapter) {
      /*
       * Defence in depth. The context was built through withBoundary, so this
       * should be unreachable — which is exactly why it is checked. A leak that
       * gets this far has already defeated the database, and finding out from a
       * dropped citation beats finding out from a reader.
       */
      dropped.push({
        assertionId: citation.assertion_id,
        why: `Assertion du chapitre ${entry.chapter}, au-delà de la frontière ${context.boundaryChapter}.`,
      })
      continue
    }

    if (seen.has(entry.assertionId)) continue
    seen.add(entry.assertionId)

    citations.push({
      assertionId: entry.assertionId,
      chapter: entry.chapter,
      excerpt: entry.excerpt ?? entry.statement,
      statement: entry.statement,
    })
  }

  return { citations, dropped }
}

/**
 * Does the answer's prose stay within what the citations support?
 *
 * Used by the evaluation harness rather than in the request path. It is a
 * heuristic — content words in the answer that appear nowhere in the cited
 * context — and it is reported as a score rather than enforced, because a
 * legitimate answer contains connective language the sources do not. Enforcing
 * it would reject good answers; measuring it catches drift between prompt
 * versions.
 */
export function groundednessScore(
  answer: string,
  citations: Citation[],
): { score: number; unsupportedWords: string[] } {
  const supported = new Set(
    citations
      .flatMap((citation) => [citation.statement, citation.excerpt])
      .flatMap((text) => normalizeText(text).split(' '))
      .filter((word) => word.length > 3),
  )

  const words = normalizeText(answer)
    .split(' ')
    .filter((word) => word.length > 4 && !STOPWORDS.has(word))

  if (words.length === 0) return { score: 1, unsupportedWords: [] }

  const unsupported = words.filter((word) => !supported.has(word))
  return {
    score: 1 - unsupported.length / words.length,
    unsupportedWords: [...new Set(unsupported)].slice(0, 20),
  }
}

/** Connective French that any answer contains and no source needs to supply. */
const STOPWORDS = new Set([
  'chapitre', 'chapitres', 'selon', 'donc', 'ensuite', 'ainsi', 'cependant',
  'lorsque', 'pendant', 'depuis', 'aucune', 'aucun', 'plusieurs', 'certains',
  'notamment', 'toutefois', 'egalement', 'ensemble', 'contre', 'entre',
  'apres', 'avant', 'entre', 'parce', 'entre', 'lecteur', 'lecture',
])

function empty(
  question: string,
  boundaryChapter: number,
  message: string,
): AssistantAnswer {
  return {
    question,
    boundaryChapter,
    insufficientData: true,
    answer: message,
    citations: [],
    droppedCitations: [],
    entityIds: [],
    notes: [],
    costCents: 0,
    modelId: null,
  }
}

export type { AssistantContext, ContextEntry }
