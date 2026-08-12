import { NODE_TYPES, PREDICATES } from './ontology.ts'

/**
 * Read a predicate the way the graph is read: in French.
 *
 * Every predicate has carried a `labelFr` since the ontology was written — it is
 * seeded into the `predicates` table and handed to the model in the extraction
 * prompt, which is how « part de » gets proposed as `travels_from` in the first
 * place. The interface then showed the key back: « 1 promises → Roi des
 * Pirates », in a product whose whole surface is French, about a graph whose
 * every label was authored in French precisely so nothing would have to be
 * translated in the reader's head.
 *
 * A plain map rather than a query, and that is a real trade. Predicates live in
 * the database so a user-defined one works like a built-in, and this file only
 * knows the ones we ship. It is safe here because extraction is bounded by the
 * ontology — a proposal citing an unknown predicate is quarantined as
 * `unknown_predicate` and never becomes an assertion — and because the fallback
 * degrades honestly: an unknown key is shown readably rather than replaced by an
 * invented French phrase. A client component can call this, which a query
 * cannot.
 */

const FRENCH = new Map<string, string>(
  PREDICATES.map((predicate) => [predicate.key, predicate.labelFr]),
)

const NODE_FRENCH = new Map<string, string>(
  NODE_TYPES.map((type) => [type.key, type.labelFr]),
)

export function predicateLabel(key: string): string {
  const known = FRENCH.get(key)
  if (known !== undefined) return known
  // Not translated, only made readable: `secretly_member_of` is still that key,
  // and pretending otherwise would put a phrase nobody wrote into the graph.
  return key.replace(/_/g, ' ')
}

/** The same, for a node type — « Personnage » rather than `character`. */
export function nodeTypeLabel(key: string): string {
  return NODE_FRENCH.get(key) ?? key.replace(/_/g, ' ')
}
