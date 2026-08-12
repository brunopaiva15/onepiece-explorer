/**
 * The two languages the site speaks.
 *
 * The knowledge graph is authored in French — one canonical form per name,
 * per event summary, per naming decision (migrations 0016, 0017, 0019). What
 * this module localises is everything the site says *around* that content:
 * navigation, forms, labels, generated answers. English display of graph
 * content itself comes from data that carries both languages (ontology
 * `label_en`, entity labels with `lang`, the glossary's `english_term`), with
 * French as the fallback everywhere a second form was never seen.
 *
 * Deliberately not `server-only`: client components receive a `locale` prop
 * from their server parent and look their strings up themselves — a dictionary
 * full of template functions cannot cross the serialisation boundary as props.
 * The server-side half (reading the preference) lives in `./server.ts`.
 */

export type Locale = 'fr' | 'en'

export const LOCALES = ['fr', 'en'] as const satisfies readonly Locale[]

/** The language of every profile and of the interface until now. */
export const DEFAULT_LOCALE: Locale = 'fr'

/**
 * Where an anonymous visitor's choice lives. A signed-in reader's preference
 * is `profiles.language` (migration 0018); the cookie mirrors it so the
 * pre-auth pages agree with the post-auth ones.
 */
export const LANG_COOKIE = 'lang'

export function isLocale(value: unknown): value is Locale {
  return value === 'fr' || value === 'en'
}

/**
 * The right label for a row that carries both, French holding wherever an
 * English form was never provided (user-created ontology rows, entities whose
 * English name the system has not seen).
 */
export function localizedLabel(
  row: { labelFr: string; labelEn?: string | null },
  locale: Locale,
): string {
  return locale === 'en' && row.labelEn ? row.labelEn : row.labelFr
}
