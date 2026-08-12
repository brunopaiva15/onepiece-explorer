import type { Locale } from '../index.ts'

/** Strings for the review area. French defines the shape; typeof fr makes English cover every key. */
const fr = {}

const en: typeof fr = {}

export const review = { fr, en } satisfies Record<Locale, typeof fr>
