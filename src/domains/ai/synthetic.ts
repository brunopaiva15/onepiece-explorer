import 'server-only'
import { normalizeText } from '../knowledge/normalize.ts'
import {
  emptyUsage,
  type AnswerRequest,
  type DescribeRequest,
  type EmbedRequest,
  type ExtractRequest,
  type ModelProvider,
  type ModelTier,
  type ProviderResult,
  type ResolveRequest,
  type SummarizeRequest,
  type TranscribeRequest,
} from './provider.ts'
import type {
  Answer,
  CandidateAssertion,
  CandidateEntity,
  Extraction,
  PanelDescription,
  Resolution,
  Summary,
  Transcription,
} from './schemas.ts'

/**
 * The no-key fallback.
 *
 * The temptation here is to invent a plausible chapter's worth of extraction so
 * the demo looks complete. That would be the one lie this product cannot
 * afford: a graph of fabricated facts about a real work, presented in an
 * interface whose entire claim is that everything in it is sourced.
 *
 * So this provider only ever *rearranges what it was given*. It reads the text
 * blocks that came from the PDF's own text layer and proposes:
 *
 *   entities  — capitalised sequences that look like proper nouns, each cited to
 *               the block it was found in
 *   relations — co-occurrence within one block, as `related_to`, which is the
 *               weakest predicate in the ontology and is exactly the strength of
 *               the claim being made
 *
 * Every proposal it emits anchors correctly, because every excerpt is copied
 * verbatim from a real block. Nothing is named that the page does not name.
 * Confidence is low and epistemic status is `hypothetical`, so everything lands
 * in explicit review rather than sliding into the graph.
 *
 * What it cannot do is read pictures. `transcribe` and image description return
 * nothing rather than guessing, and the interface says so — the alternative is a
 * description of a panel nobody looked at.
 */
export class SyntheticProvider implements ModelProvider {
  readonly name = 'synthetic' as const

  async estimate(
    tier: ModelTier,
    request: unknown,
  ): Promise<{ inputTokens: number; costCents: number }> {
    void tier
    return { inputTokens: Math.ceil(JSON.stringify(request).length / 4), costCents: 0 }
  }

  async transcribe(request: TranscribeRequest): Promise<ProviderResult<Transcription>> {
    /*
     * Reading text off an image needs a model or an OCR engine. Returning an
     * empty transcription is the honest answer; returning invented dialogue
     * would be indistinguishable, to every downstream step, from a real one.
     */
    void request
    return {
      value: { blocks: [] },
      usage: emptyUsage('synthetic'),
      refusal:
        "Le fournisseur synthétique ne lit pas les images. Utilisez un PDF avec couche " +
        "texte, ou configurez ANTHROPIC_API_KEY pour la transcription.",
    }
  }

  async describePanels(
    request: DescribeRequest,
  ): Promise<ProviderResult<PanelDescription[]>> {
    /*
     * A description is built from the panel's own text, quoted. It is a thin
     * thing — "this panel contains the following text" — but it is true, and it
     * gives visual evidence something real to anchor against instead of making
     * `kind: 'visual'` a free pass.
     */
    const panels: PanelDescription[] = request.allowedRefs.map((ref) => {
      const text = request.text[ref]?.trim() ?? ''
      return {
        panel_ref: ref,
        description:
          text.length > 0
            ? `Case ${ref}. Texte présent : « ${text} »`
            : `Case ${ref}. Aucun texte extrait ; le contenu dessiné n'a pas été analysé.`,
        characters_visible: [],
        setting: null,
        actions: [],
        // Deliberately low: this is not a description of what is drawn, and no
        // downstream step should treat it as one.
        confidence: text.length > 0 ? 0.3 : 0.05,
      }
    })

    return { value: panels, usage: emptyUsage('synthetic') }
  }

  async extract(request: ExtractRequest): Promise<ProviderResult<Extraction>> {
    const entities: CandidateEntity[] = []
    const assertions: CandidateAssertion[] = []
    const seen = new Map<string, string>()

    for (const block of request.textBlocks) {
      const names = properNouns(block.text)

      for (const name of names) {
        const key = normalizeText(name)
        if (seen.has(key)) continue

        const localId = `syn-${seen.size + 1}`
        seen.set(key, localId)

        entities.push({
          local_id: localId,
          node_type: 'character',
          label: name,
          // 'alias' rather than 'true_name': all this knows is that the page
          // uses this word. Whether it is a real name, a nickname or a place is
          // exactly what a model would be for.
          label_kind: 'alias',
          evidence: [{ ref: block.ref, kind: 'text', excerpt: excerptAround(block.text, name) }],
          confidence: 0.25,
        })
      }

      // Two names in one block co-occur. `related_to` is the weakest predicate
      // in the ontology, which is precisely the strength of this claim.
      const localIds = names.map((n) => seen.get(normalizeText(n))!).filter(Boolean)
      for (let i = 0; i < localIds.length; i++) {
        for (let j = i + 1; j < localIds.length; j++) {
          assertions.push({
            subject: localIds[i]!,
            predicate: 'related_to',
            object: localIds[j]!,
            object_value: null,
            epistemic_status: 'hypothetical',
            evidence: [
              { ref: block.ref, kind: 'text', excerpt: block.text.slice(0, 300) },
            ],
            confidence: 0.2,
          })
        }
      }
    }

    return {
      value: { entities, assertions, events: [], mysteries: [] },
      usage: emptyUsage('synthetic'),
    }
  }

  async resolve(request: ResolveRequest): Promise<ProviderResult<Resolution>> {
    /*
     * Every verdict is 'uncertain', and that is not a cop-out — it is the
     * correct answer from a component that cannot compare two faces. Saying
     * 'same' on a name match would merge two deliberately-similar characters
     * and destroy the revelation history this system exists to preserve.
     */
    return {
      value: {
        candidates: request.existing.slice(0, 5).map((existing) => ({
          existing_entity_id: existing.id,
          verdict: 'uncertain' as const,
          reasoning:
            'Rapprochement non évalué : le mode synthétique ne compare pas les apparitions. ' +
            'Décidez à partir des cases sources.',
          confidence: 0,
        })),
      },
      usage: emptyUsage('synthetic'),
    }
  }

  async summarize(request: SummarizeRequest): Promise<ProviderResult<Summary>> {
    // One sentence per assertion, each citing the assertion it restates. Not a
    // summary in any useful sense, but every sentence has a source — which is
    // the property the review centre and the tests check.
    return {
      value: {
        sentences: request.assertions.slice(0, 20).map((assertion) => ({
          text: assertion.statement,
          supported_by: [assertion.id],
        })),
      },
      usage: emptyUsage('synthetic'),
    }
  }

  async answer(request: AnswerRequest): Promise<ProviderResult<Answer>> {
    /*
     * Matches question words against the supplied context and returns what it
     * finds, verbatim, or admits it found nothing. Never composes prose: a
     * fluent answer from a component that cannot reason is the most dangerous
     * output this file could produce.
     */
    const words = new Set(
      normalizeText(request.question)
        .split(' ')
        .filter((w) => w.length > 3),
    )

    const hits = request.context
      .map((entry) => ({
        entry,
        score: [...words].filter((w) => normalizeText(entry.statement).includes(w)).length,
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    if (hits.length === 0) {
      return {
        value: {
          insufficient_data: true,
          answer:
            "Les chapitres que vous avez lus ne contiennent rien qui réponde à cette question " +
            "— du moins rien que ce mode sans modèle sache reconnaître.",
          citations: [],
        },
        usage: emptyUsage('synthetic'),
      }
    }

    return {
      value: {
        insufficient_data: false,
        answer: [
          'Assertions correspondantes dans les chapitres lus :',
          ...hits.map((h) => `• ${h.entry.statement}`),
        ].join('\n'),
        citations: hits.map((h) => ({
          assertion_id: h.entry.assertionId,
          chapter: h.entry.chapter,
          excerpt: h.entry.excerpt ?? h.entry.statement,
        })),
      },
      usage: emptyUsage('synthetic'),
    }
  }

  async embed(request: EmbedRequest): Promise<ProviderResult<number[][]>> {
    /*
     * A hashed bag-of-words projection. Not semantic — "navire" and "bateau"
     * land nowhere near each other — but deterministic, free, and genuinely
     * useful for exact-ish recall, which is more than a vector of zeros would
     * be. The dimension matches what pgvector is configured for so switching
     * providers does not require a migration.
     */
    const DIMENSIONS = 384
    const vectors = request.texts.map((text) => {
      const vector = new Array<number>(DIMENSIONS).fill(0)
      for (const word of normalizeText(text).split(' ')) {
        if (word.length === 0) continue
        let hash = 2_166_136_261
        for (let i = 0; i < word.length; i++) {
          hash ^= word.charCodeAt(i)
          hash = Math.imul(hash, 16_777_619)
        }
        const slot = Math.abs(hash) % DIMENSIONS
        vector[slot] = (vector[slot] ?? 0) + 1
      }
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
      return norm === 0 ? vector : vector.map((v) => v / norm)
    })

    return { value: vectors, usage: emptyUsage('synthetic') }
  }
}

/**
 * Capitalised sequences that look like proper nouns.
 *
 * Crude, and it has to be: the alternative is a list of French words to exclude,
 * which is a model in disguise and a worse one. A sentence-initial common noun
 * will slip through — hence confidence 0.25 and mandatory review. It skips
 * fully-uppercase runs, which in a manga are sound effects and shouted text
 * rather than names.
 */
export function properNouns(text: string): string[] {
  const found: string[] = []
  // A capitalised word, optionally followed by more capitalised words.
  const pattern = /\p{Lu}\p{Ll}{2,}(?:[ -]\p{Lu}\p{Ll}+)*/gu

  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    // Drop a match that starts the string: "Personne ne connaît…" is not a name.
    if (match.index === 0 && !value.includes(' ')) continue
    if (!found.includes(value)) found.push(value)
  }

  return found.slice(0, 8)
}

/**
 * A window of real text around a name, for the evidence excerpt.
 *
 * Sliced from the block rather than reconstructed, so it anchors by
 * construction. Whole-block excerpts would anchor too but would make the review
 * centre unreadable when a block is a paragraph.
 */
function excerptAround(text: string, name: string, radius = 40): string {
  const at = text.indexOf(name)
  if (at === -1) return text.slice(0, 120)
  return text.slice(Math.max(0, at - radius), Math.min(text.length, at + name.length + radius))
}
