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
  it('uses the measured five-passage budget instead of the global emergency ceiling', () => {
    expect(localExtractionLimitsForUnits(5)).toEqual({
      units: 5,
      entities: 12,
      assertions: 20,
      events: 8,
      mysteries: 3,
      maxTokens: 8_000,
    })
  })

  it('grows with a full summary slice without returning to 40/80/20/10', () => {
    expect(localExtractionLimitsForUnits(15)).toEqual({
      units: 15,
      entities: 20,
      assertions: 40,
      events: 16,
      mysteries: 5,
      maxTokens: 12_000,
    })
  })

  it('emits those ceilings in the actual LM Studio request', async () => {
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
      chapterNumber: 211,
      source: 'summary',
      ontology: 'ontology de test',
      knownEntities: [],
      knownEntitiesTotal: 0,
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

    expect(payload.max_tokens).toBe(8_000)
    expect(payload.response_format.json_schema.schema.properties.entities.maxItems).toBe(12)
    expect(payload.response_format.json_schema.schema.properties.assertions.maxItems).toBe(20)
    expect(payload.response_format.json_schema.schema.properties.events.maxItems).toBe(8)
    expect(payload.response_format.json_schema.schema.properties.mysteries.maxItems).toBe(3)

    const userText = payload.messages[1]?.content
      .map((part) => part.text ?? '')
      .join('\n')
    expect(userText).toContain('JAMAIS des objectifs à remplir')
    expect(userText).toContain('un nœud « concept » est une notion durable du monde')
  })
})
