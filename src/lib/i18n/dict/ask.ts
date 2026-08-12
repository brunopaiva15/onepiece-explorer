import type { Locale } from '../index.ts'

/** Strings for the ask area. French defines the shape; typeof fr makes English cover every key. */
const fr = {}

const en: typeof fr = {}

export const ask = { fr, en } satisfies Record<Locale, typeof fr>
