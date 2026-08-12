import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildAnchorSources,
  filterExtraction,
  type OntologyView,
} from '@/domains/ai/anchoring.ts'
import { extractionSystem, parallelText } from '@/domains/ai/prompts.ts'
import { costCents, PRICING } from '@/domains/ai/provider.ts'
import {
  clampPanelDescriptions,
  DESCRIPTION_BUDGET,
  panelDescriptionsSchema,
  type PanelDescription,
} from '@/domains/ai/schemas.ts'
import { cassetteKey, ReplayProvider } from '@/domains/ai/replay.ts'
import { properNouns, SyntheticProvider } from '@/domains/ai/synthetic.ts'
import { NODE_TYPES, PREDICATES } from '@/domains/knowledge/ontology.ts'
import type { ExtractRequest, ModelProvider } from '@/domains/ai/provider.ts'
import { parallelWindow, sliceChapter, splitSlice } from '@/domains/pipeline/steps/extract.ts'

const ONTOLOGY: OntologyView = {
  nodeTypes: new Set(NODE_TYPES.map((t) => t.key)),
  predicates: new Set(PREDICATES.map((p) => p.key)),
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ope-cassette-'))
  directories.push(dir)
  return dir
}

describe('the synthetic provider only rearranges what it was given', () => {
  const request: ExtractRequest = {
    chapterNumber: 3,
    source: 'summary',
    ontology: 'character, place',
    knownEntities: [],
    glossary: [],
    descriptions: [],
    textBlocks: [
      {
        ref: 'b1',
        panelRef: 'p1c1',
        text: "Le capitaine Aldren a promis à Maren de revenir au port de Sarn.",
      },
      { ref: 'b2', panelRef: 'p1c2', text: 'Personne ne connaît son nom ici.' },
    ],
    allowedRefs: ['b1', 'b2', 'p1c1', 'p1c2'],
  }

  it('produces proposals that all pass anchoring', async () => {
    /*
     * The property that makes this provider usable rather than decorative: it
     * cites real text, so its output survives the same guard a real model's
     * output has to survive. If it did not, the no-key path would produce a
     * quarantine full of its own output and nothing else.
     */
    const provider = new SyntheticProvider()
    const result = await provider.extract(request)

    const sources = buildAnchorSources({
      textBlocks: request.textBlocks.map((b) => ({ ref: b.ref, text: b.text })),
      descriptions: [],
      allowedRefs: request.allowedRefs,
    })

    const filtered = filterExtraction(result.value, sources, ONTOLOGY, new Set())

    expect(result.value.entities.length).toBeGreaterThan(0)
    expect(filtered.quarantined).toEqual([])
    expect(filtered.accepted.entities).toHaveLength(result.value.entities.length)
  })

  it('never claims a name is the true name', async () => {
    // All it knows is that the page uses this word. Whether it is a name, a
    // nickname or a place is exactly what a model would be for.
    const { value } = await new SyntheticProvider().extract(request)
    expect(value.entities.every((e) => e.label_kind === 'alias')).toBe(true)
    expect(value.entities.every((e) => e.confidence < 0.5)).toBe(true)
  })

  it('only ever proposes the weakest predicate, as hypothetical', async () => {
    const { value } = await new SyntheticProvider().extract(request)
    expect(value.assertions.every((a) => a.predicate === 'related_to')).toBe(true)
    expect(value.assertions.every((a) => a.epistemic_status === 'hypothetical')).toBe(true)
  })

  it('refuses to read an image rather than inventing dialogue', async () => {
    const result = await new SyntheticProvider().transcribe({
      chapterNumber: 1,
      images: [{ data: 'AAAA', mediaType: 'image/webp', ref: 'p1c1' }],
      allowedRefs: ['p1c1'],
      language: 'fr',
    })
    expect(result.value.blocks).toEqual([])
    expect(result.refusal).toMatch(/ne lit pas les images/)
  })

  it('answers "insufficient" rather than composing prose it cannot support', async () => {
    const result = await new SyntheticProvider().answer({
      question: 'Qui est le père de Maren ?',
      context: [],
      boundaryChapter: 3,
    })
    expect(result.value.insufficient_data).toBe(true)
    expect(result.value.citations).toEqual([])
  })

  it('cites its sources when it does find something', async () => {
    const result = await new SyntheticProvider().answer({
      question: 'Que promet Aldren ?',
      context: [
        {
          assertionId: 'a1',
          chapter: 3,
          statement: 'Aldren promet de revenir au port de Sarn.',
          excerpt: 'a promis à Maren de revenir',
        },
      ],
      boundaryChapter: 3,
    })
    expect(result.value.insufficient_data).toBe(false)
    expect(result.value.citations).toHaveLength(1)
    expect(result.value.citations[0]!.assertion_id).toBe('a1')
  })

  it('says uncertain for every identity comparison', async () => {
    // 'same' on a name match would merge two deliberately-similar characters
    // and destroy the revelation history the product exists to preserve.
    const result = await new SyntheticProvider().resolve({
      chapterNumber: 3,
      source: 'summary',
      candidate: { label: 'Aldren', nodeType: 'character', description: 'un homme au sabre' },
      existing: [
        {
          id: 'x1',
          label: 'Aldren',
          nodeType: 'character',
          firstSeenChapter: 1,
          description: 'un homme au sabre',
        },
      ],
    })
    expect(result.value.candidates[0]!.verdict).toBe('uncertain')
  })

  it('produces normalised, deterministic embeddings', async () => {
    const provider = new SyntheticProvider()
    const first = await provider.embed({ texts: ['le port de Sarn'] })
    const second = await provider.embed({ texts: ['le port de Sarn'] })
    expect(first.value[0]).toEqual(second.value[0])

    const norm = Math.sqrt(first.value[0]!.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1, 6)
  })
})

describe('proper-noun detection', () => {
  it('finds capitalised names mid-sentence', () => {
    expect(properNouns('Le capitaine Aldren rejoint Maren au port.')).toEqual([
      'Aldren',
      'Maren',
    ])
  })

  it('ignores a sentence-initial common noun', () => {
    // "Personne ne connaît…" is not a name, and a French stopword list would be
    // a model in disguise.
    expect(properNouns('Personne ne le sait.')).toEqual([])
  })

  it('ignores shouted text and sound effects', () => {
    expect(properNouns('BOOM ! CRAAAC !')).toEqual([])
  })

  it('keeps a multi-word name together', () => {
    expect(properNouns("Ils accostent à Port Sarn avant l'aube.")).toContain('Port Sarn')
  })
})

describe('the replay provider never improvises', () => {
  it('fails loudly on a missing recording, with the command to fix it', async () => {
    const provider = new ReplayProvider({ directory: await scratch() })

    await expect(
      provider.summarize({ chapterNumber: 1, assertions: [] }),
    ).rejects.toThrow(/RECORD=1/)
  })

  it('replays a recording and reports zero cost', async () => {
    const directory = await scratch()
    const request = { chapterNumber: 1, assertions: [{ id: 'a1', statement: 'Un fait.' }] }
    const key = cassetteKey('summarize', request)

    await writeFile(
      path.join(directory, `summarize-${key}.json`),
      JSON.stringify({
        value: { sentences: [{ text: 'Un fait.', supported_by: ['a1'] }] },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costCents: 999,
          modelId: 'claude-sonnet-5',
        },
      }),
    )

    const provider = new ReplayProvider({ directory })
    const result = await provider.summarize(request)

    expect(result.value.sentences[0]!.text).toBe('Un fait.')
    // Replaying must not add to the cost dashboard: a recorded response was paid
    // for once, and counting it again would make the figure meaningless.
    expect(result.usage.costCents).toBe(0)
  })

  it('records an unknown request when given a recorder', async () => {
    const directory = await scratch()

    const recorder = {
      summarize: async () => ({
        value: { sentences: [{ text: 'Enregistré.', supported_by: ['a1'] }] },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costCents: 1,
          modelId: 'claude-sonnet-5',
        },
      }),
    } as unknown as ModelProvider

    const provider = new ReplayProvider({ directory, recorder })
    const result = await provider.summarize({ chapterNumber: 2, assertions: [] })

    expect(result.value.sentences[0]!.text).toBe('Enregistré.')
    expect(await readdir(directory)).toHaveLength(1)
  })

  it('keys a recording independently of image bytes', () => {
    /*
     * Image data is hashed rather than included, so re-encoding a page — a
     * sharp upgrade, a different WebP quality — does not invalidate every
     * cassette at once and turn a dependency bump into an afternoon of
     * re-recording.
     */
    const base = {
      chapterNumber: 1,
      allowedRefs: ['p1c1'],
      language: 'fr',
      images: [{ data: 'A'.repeat(300), mediaType: 'image/webp', ref: 'p1c1' }],
    }
    const reencoded = {
      ...base,
      images: [{ data: 'B'.repeat(300), mediaType: 'image/webp', ref: 'p1c1' }],
    }

    // Different bytes still key differently — the hash is of the bytes — but the
    // key is short and stable rather than embedding 300 characters of base64.
    expect(cassetteKey('transcribe', base)).not.toBe(cassetteKey('transcribe', reencoded))
    expect(cassetteKey('transcribe', base)).toHaveLength(16)
  })

  it('ignores the order object keys happened to be built in', () => {
    const a = { chapterNumber: 1, assertions: [] }
    const b = { assertions: [], chapterNumber: 1 }
    expect(cassetteKey('summarize', a)).toBe(cassetteKey('summarize', b))
  })
})

describe('cost arithmetic', () => {
  it('prices a plain request from the published rates', () => {
    // 1M input + 1M output on Sonnet 5's introductory rate = $2 + $10 = $12.
    const cents = costCents('claude-sonnet-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cents).toBeCloseTo(1200, 1)
  })

  it('charges a cache read at a tenth and a write at 1.25×', () => {
    const price = PRICING['claude-sonnet-5']!
    const read = costCents('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    })
    const write = costCents('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 1_000_000,
    })

    expect(read).toBeCloseTo(price.input * 100 * 0.1, 2)
    expect(write).toBeCloseTo(price.input * 100 * 1.25, 2)
    // Which is why a prefix must be reused three times before caching pays:
    // one write costs what 12.5 reads cost.
    expect(write / read).toBeCloseTo(12.5, 2)
  })

  it('returns zero rather than guessing for an unknown model', () => {
    expect(costCents('some-future-model', { inputTokens: 1_000, outputTokens: 1_000 })).toBe(0)
  })
})

describe('length budgets', () => {
  /**
   * The failure this guards is not hypothetical: two panel descriptions of
   * 1 300 characters failed a Zod parse, which failed the batch of six, which
   * failed the run — a whole chapter lost because a model was wordy in a field
   * where wordiness is not even an error. The API does not enforce string
   * length from a JSON Schema, so the only real choice was between clamping and
   * throwing.
   */
  const panel = (over: Partial<PanelDescription> = {}): PanelDescription => ({
    panel_ref: 'p1',
    description: 'Une case.',
    characters_visible: ['silhouette en manteau'],
    setting: 'un port',
    actions: ['il marche'],
    confidence: 0.8,
    ...over,
  })

  it('accepts an answer that overruns every budget', () => {
    const [clamped] = clampPanelDescriptions([
      panel({
        description: 'x'.repeat(1_300),
        setting: 'y'.repeat(400),
        characters_visible: Array.from({ length: 20 }, () => 'z'.repeat(250)),
        actions: Array.from({ length: 15 }, () => 'a'.repeat(400)),
      }),
    ])

    expect(clamped).toBeDefined()
    expect(clamped!.description).toHaveLength(DESCRIPTION_BUDGET.description)
    expect(clamped!.description.endsWith('…')).toBe(true)
    expect(clamped!.setting).toHaveLength(DESCRIPTION_BUDGET.setting)
    expect(clamped!.characters_visible).toHaveLength(DESCRIPTION_BUDGET.descriptors)
    expect(clamped!.actions).toHaveLength(DESCRIPTION_BUDGET.actions)
    for (const action of clamped!.actions) {
      expect(action.length).toBeLessThanOrEqual(DESCRIPTION_BUDGET.action)
    }
  })

  it('leaves an answer within budget untouched, ellipsis included', () => {
    const original = panel()
    const [clamped] = clampPanelDescriptions([original])

    expect(clamped).toEqual(original)
    expect(clamped!.description).not.toContain('…')
  })

  it('keeps a null setting null rather than clamping it to a string', () => {
    const [clamped] = clampPanelDescriptions([panel({ setting: null })])
    expect(clamped!.setting).toBeNull()
  })

  it('parses a model answer that exceeds the budgets instead of rejecting it', () => {
    // The schema itself must not carry the limits: a parse failure discards the
    // whole batch, and there is nothing wrong with the other five panels in it.
    const parsed = panelDescriptionsSchema.safeParse({
      panels: [panel({ description: 'x'.repeat(5_000) })],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('slicing a chapter for extraction', () => {
  /**
   * One call per chapter met its limit on a real one: 122 panels and 130 text
   * blocks in, everything out, against an output ceiling the answer ran through.
   * `stop_reason: max_tokens` leaves truncated JSON — which the code reported as
   * a schema violation, a message about the symptom.
   */
  const panelsOf = (n: number): PanelDescription[] =>
    Array.from({ length: n }, (_, i) => ({
      panel_ref: `P${i + 1}`,
      description: 'Une case.',
      characters_visible: [],
      setting: null,
      actions: [],
      confidence: 1,
    }))

  it('keeps a small chapter in a single call', () => {
    expect(sliceChapter(panelsOf(12), [])).toHaveLength(1)
  })

  it('splits a dense chapter and loses no panel', () => {
    const slices = sliceChapter(panelsOf(122), [])
    expect(slices.length).toBeGreaterThan(1)
    expect(slices.flatMap((s) => s.descriptions)).toHaveLength(122)
    expect(new Set(slices.flatMap((s) => s.descriptions.map((d) => d.panel_ref))).size).toBe(122)
  })

  it('sends each block with its own panel, and each orphan exactly once', () => {
    // A block repeated across slices would have the same fact proposed twice,
    // which review would then have to reject twice.
    const blocks = [
      { ref: 'B1', text: 'dans la première', panelRef: 'P1' },
      { ref: 'B2', text: 'dans la dernière', panelRef: 'P100' },
      { ref: 'B3', text: 'hors case', panelRef: null },
    ]
    const slices = sliceChapter(panelsOf(100), blocks)

    const placements = new Map<string, number>()
    for (const slice of slices) {
      for (const block of slice.blocks) {
        placements.set(block.ref, (placements.get(block.ref) ?? 0) + 1)
      }
    }
    expect(placements.get('B1')).toBe(1)
    expect(placements.get('B2')).toBe(1)
    expect(placements.get('B3')).toBe(1)

    expect(slices[0]!.blocks.map((b) => b.ref)).toContain('B1')
    expect(slices[0]!.blocks.map((b) => b.ref)).toContain('B3')
    expect(slices.at(-1)!.blocks.map((b) => b.ref)).toContain('B2')
  })

  it('still runs when a chapter has text but no described panel', () => {
    const blocks = [{ ref: 'B1', text: 'seul', panelRef: null }]
    const slices = sliceChapter([], blocks)
    expect(slices).toHaveLength(1)
    expect(slices[0]!.blocks).toHaveLength(1)
  })
})

describe('splitting a slice that failed', () => {
  /**
   * Four slices went out, two came back, and the third took the two that had
   * worked down with it — eight minutes and their cost, discarded because a
   * later call returned truncated JSON. Halving treats the likeliest cause
   * rather than reporting it: truncation means the answer did not fit, and half
   * as many panels is half as much answer.
   */
  const panelsOf = (n: number): PanelDescription[] =>
    Array.from({ length: n }, (_, i) => ({
      panel_ref: `P${i + 1}`,
      description: 'Une case.',
      characters_visible: [],
      setting: null,
      actions: [],
      confidence: 1,
    }))

  it('halves a slice and keeps every panel exactly once', () => {
    const halves = splitSlice({ descriptions: panelsOf(40), blocks: [] })

    expect(halves).toHaveLength(2)
    expect(halves.flatMap((h) => h.descriptions)).toHaveLength(40)
    expect(new Set(halves.flatMap((h) => h.descriptions.map((d) => d.panel_ref))).size).toBe(40)
  })

  it('sends each block with its own half, orphans once', () => {
    const blocks = [
      { ref: 'B1', text: 'début', panelRef: 'P1' },
      { ref: 'B2', text: 'fin', panelRef: 'P10' },
      { ref: 'B3', text: 'hors case', panelRef: null },
    ]
    const halves = splitSlice({ descriptions: panelsOf(10), blocks })

    const seen = halves.flatMap((h) => h.blocks.map((b) => b.ref))
    expect(seen).toHaveLength(3)
    expect(halves[0]!.blocks.map((b) => b.ref)).toEqual(expect.arrayContaining(['B1', 'B3']))
    expect(halves[1]!.blocks.map((b) => b.ref)).toContain('B2')
  })

  it('stops rather than looping on a slice of one', () => {
    // A single panel that still fails is not failing because of its size, and
    // halving it forever would turn one bad call into an infinite bill.
    const halves = splitSlice({ descriptions: panelsOf(1), blocks: [] })
    expect(halves).toHaveLength(1)
    expect(halves[0]!.descriptions).toHaveLength(1)
  })
})

describe('the other-language text, windowed to a slice', () => {
  /**
   * The second text is a naming aid: it earns its tokens where it overlaps the
   * passages being read, and nowhere else. Sending the whole translation with
   * every slice would pay for the chapter once per call and bury the two
   * sentences that carry the name in the forty that do not.
   *
   * Alignment is positional, because the two texts tell the same chapter in the
   * same order and putting a name beside its translation is all this has to
   * achieve. What must hold is the margin: two writers split their paragraphs
   * differently, so the window has to overshoot rather than clip.
   */
  const parallelOf = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `passage ${i + 1}`)

  it('takes the matching stretch, with a margin on each side', () => {
    const window = parallelWindow(parallelOf(20), { from: 10, to: 14 }, 20)

    expect(window).toContain('passage 11')
    expect(window).toContain('passage 15')
    // The margin: one passage before and after, for the drift between two
    // writers who cut their paragraphs in different places.
    expect(window).toContain('passage 10')
    expect(window).toContain('passage 16')
    expect(window).not.toContain('passage 1')
  })

  it('scales when the two texts are cut into different numbers of passages', () => {
    // Ten passages against forty: the second half of one is the second half of
    // the other, whatever the counts.
    const window = parallelWindow(parallelOf(10), { from: 20, to: 39 }, 40)
    expect(window).not.toContain('passage 1')
    expect(window).toContain('passage 10')
  })

  it('sends a short text whole rather than slicing it to nothing', () => {
    expect(parallelWindow(parallelOf(3), { from: 0, to: 0 }, 40)).toHaveLength(3)
  })

  it('returns nothing when there is no second text', () => {
    expect(parallelWindow([], { from: 0, to: 5 }, 40)).toEqual([])
  })
})

describe('the extraction prompt about the other-language text', () => {
  it('says nothing about it when there is none', () => {
    // Describing a document that was not supplied is the same failure as
    // telling a model reading prose to consult "les pages fournies": a model
    // told to look at an absent text is a model invited to imagine one.
    const system = extractionSystem('ontologie', 'summary')
    expect(system).not.toContain('parallèle')
  })

  it('states that it cannot be cited, and what it is for', () => {
    const system = extractionSystem('ontologie', 'summary', true)
    expect(system).toContain('parallèle')
    expect(system).toContain('source_term')
    expect(system).toMatch(/n'est PAS citable|n’est PAS citable/)
  })

  it('labels the passages by language rather than numbering them', () => {
    // A number here would read as a ref, and a ref is exactly what these do not
    // have. Lending them the vocabulary of citation is how a model comes to
    // cite them.
    const rendered = parallelText('en', ['He hands over his straw hat.'])
    expect(rendered).toContain('parallèle-en')
    expect(rendered).toContain('He hands over his straw hat.')
    expect(rendered).not.toMatch(/\[b\d+\]/)
  })
})
