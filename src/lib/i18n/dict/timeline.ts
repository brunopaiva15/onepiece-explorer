import type { Locale } from '../index.ts'

/**
 * Strings for the timeline (/chronologie), the narrative delta (/delta) and
 * the temporal domain's composed fallbacks. Stored story-time descriptions
 * were authored with the graph — canonical French — and are shown as stored;
 * only text composed at read time follows the reader.
 */
const fr = {
  yearsEarlier: (years: string) => `environ ${years} ans plus tôt`,
  relativeOrderKnown: 'ordre relatif connu',
  unknownMoment: 'moment inconnu',
}

const en: typeof fr = {
  yearsEarlier: (years: string) => `about ${years} years earlier`,
  relativeOrderKnown: 'relative order known',
  unknownMoment: 'unknown moment',
}

export const timeline = { fr, en } satisfies Record<Locale, typeof fr>
