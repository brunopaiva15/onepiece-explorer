/**
 * Refs: the short names a model is allowed to cite.
 *
 * A UUID is a bad thing to put in a prompt. It costs a dozen tokens, a model
 * transcribes it wrong often enough to matter, and when it does the failure
 * looks like a hallucination rather than a typo — which sends a legitimate
 * proposal to quarantine and hides the real problem.
 *
 * So the pipeline hands out `p3c2` and `b17`, keeps the mapping in memory for
 * the duration of the run, and translates back before anything is stored. The
 * whitelist the anchoring guard checks against is the set of these refs, which
 * means a well-formed but unoffered ref — `p9c9` on a page with two panels — is
 * caught as what it is.
 */

export interface RefTable {
  /** ref → database id */
  panelIds: Map<string, string>
  blockIds: Map<string, string>
  /** database id → ref, for building requests */
  panelRefs: Map<string, string>
  blockRefs: Map<string, string>
}

export function panelRef(pageIndex: number, panelIndex: number): string {
  return `p${pageIndex + 1}c${panelIndex + 1}`
}

export function blockRef(index: number): string {
  return `b${index + 1}`
}

export function buildRefTable(input: {
  panels: Array<{ id: string; pageIndex: number; index: number }>
  blocks: Array<{ id: string }>
}): RefTable {
  const table: RefTable = {
    panelIds: new Map(),
    blockIds: new Map(),
    panelRefs: new Map(),
    blockRefs: new Map(),
  }

  for (const panel of input.panels) {
    const ref = panelRef(panel.pageIndex, panel.index)
    table.panelIds.set(ref, panel.id)
    table.panelRefs.set(panel.id, ref)
  }

  for (const [index, block] of input.blocks.entries()) {
    const ref = blockRef(index)
    table.blockIds.set(ref, block.id)
    table.blockRefs.set(block.id, ref)
  }

  return table
}

/** Every ref a model may cite in this run. */
export function allowedRefs(table: RefTable): string[] {
  return [...table.panelIds.keys(), ...table.blockIds.keys()]
}

/**
 * Resolve a ref back to what it points at.
 *
 * Returns a discriminated result rather than throwing: an unresolvable ref is a
 * quarantine reason, not an exception, and the caller already has a place to
 * record it with an explanation the user can read.
 */
export function resolveRef(
  table: RefTable,
  ref: string,
): { kind: 'panel'; id: string } | { kind: 'block'; id: string } | null {
  const panel = table.panelIds.get(ref)
  if (panel) return { kind: 'panel', id: panel }
  const block = table.blockIds.get(ref)
  if (block) return { kind: 'block', id: block }
  return null
}
