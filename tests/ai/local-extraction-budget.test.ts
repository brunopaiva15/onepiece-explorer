import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  localExtractionLimitsForUnits,
  OpenAICompatibleProvider,
  type LocalModelConfig,
} from '@/domains/ai/openai-compatible.ts'

const config: LocalModelConfig = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'qwen-hermes',
  embedModel: null,
  apiKey: null,
  cloudflareAccessClientId: null,
  cloudflareAccessClientSecret: null,
  reasoningEffort: 'none',
  timeoutMs: 600_000,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('local extraction ceilings', () => {
  it('keeps a five-passage Qwen slice close to Claude-like density', () => {
    expect(localExtractionLimitsForUnits(5)).toEqual({
      units: 5,
      entities: 8,
      assertions: 14,
      events: 7,
      mysteries: 2,
      maxTokens: 6_500,
    })
  })

  it('grows for a full summary slice without advertising the generic emergency ceiling', () => {
    expect(localExtractionLimitsForUnits(15)).toEqual({
      units: 15,
      entities: 16,
      assertions: 30,
      events: 15,
      mysteries: 4,
      maxTokens: 10_500,
    })
  })

  it('sends Claude-equivalent slice context plus the local selectivity discipline', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  entities: [],
                  assertions: [],
                  events: [],
                  mysteries: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const provider = new OpenAICompatibleProvider(config)
    await provider.extract({
      chapterNumber: 212,
      source: 'summary',
      ontology: 'ontology de test',
      knownEntities: [
        { id: 'known-smoker', label: 'Smoker', nodeType: 'character', group: 'other' },
      ],
      knownEntitiesTotal: 1,
      proposedSoFar: [
        { id: 'previous-hina', label: 'Hina', nodeType: 'character' },
      ],
      glossary: [],
      descriptions: [],
      textBlocks: Array.from({ length: 5 }, (_, index) => ({
        ref: `b${index + 1}`,
        text: `Passage ${index + 1}`,
        panelRef: null,
      })),
      allowedRefs: ['b1', 'b2', 'b3', 'b4', 'b5'],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1]
    const payload = JSON.parse(String(init?.body)) as {
      max_tokens: number
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
      response_format: {
        json_schema: {
          schema: {
            properties: Record<string, { maxItems?: number }>
          }
        }
      }
    }

    expect(payload.max_tokens).toBe(6_500)
    const properties = payload.response_format.json_schema.schema.properties
    expect(properties.entities?.maxItems).toBe(8)
    expect(properties.assertions?.maxItems).toBe(14)
    expect(properties.events?.maxItems).toBe(7)
    expect(properties.mysteries?.maxItems).toBe(2)

    const userText = payload.messages[1]?.content
      .map((part) => part.text ?? '')
      .join('\n')
    expect(userText).toContain('JAMAIS des objectifs à remplir')
    expect(userText).toContain('UNE SCÈNE = UN ÉVÉNEMENT')
    expect(userText).toContain('LE TEXTE PARALLÈLE EST LE MÊME CHAPITRE')
    expect(userText).toContain('UN MYSTÈRE EST UNE QUESTION NARRATIVE RÉELLEMENT LAISSÉE OUVERTE')
    expect(userText).toContain('previous-hina · character · « Hina »')
    expect(userText).toContain('[b1] Passage 1')
  })
})
