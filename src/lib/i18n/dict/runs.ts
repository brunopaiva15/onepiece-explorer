import type { Locale } from '../index.ts'

/** Strings for the runs area. French defines the shape; typeof fr makes English cover every key. */
const fr = {}

const en: typeof fr = {}

export const runs = { fr, en } satisfies Record<Locale, typeof fr>
