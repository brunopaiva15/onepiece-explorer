import { createHash } from 'node:crypto'
import { anchorMatch, normalizeText } from '../knowledge/normalize.ts'
import type {
  CandidateAssertion,
  CandidateEntity,
  CandidateEvent,
  CandidateMystery,
  EvidenceRef,
  Extraction,
  PanelDescription,
} from './schemas.ts'

/**
 * The guard that makes the anti-hallucination promise mechanical.
 *
 * A prompt asking a model not to use outside knowledge is a request. This is
 * the enforcement: every proposal must cite a ref from a whitelist the caller
 * built, and every textual excerpt must actually occur in the cited block. A
 * proposal that fails either test is quarantined — it never reaches the review
 * queue, so it can never be accepted by a tired human clicking through a batch.
 *
 * This is ADR 0003, and it is the single most important piece of code in the
 * project. The failure it prevents is not a wrong fact; it is a *plausible*
 * wrong fact, correctly formatted, citing a real-looking panel, describing
 * something the reader has not read yet.
 *
 * Two subtleties worth stating:
 *
 *   Normalisation is applied to both sides. Requiring byte equality would
 *   reject a model that reproduced a curly apostrophe as a straight one, which
 *   is a transcription detail and not a hallucination. Requiring nothing would
 *   let a paraphrase through, which is.
 *
 *   Visual evidence anchors against descriptions produced *in the same run*.
 *   Anchoring it against nothing would make `kind: 'visual'` a free pass, and
 *   anchoring it against the page image is not something code can check.
 */

export type QuarantineReason =
  | 'unknown_ref'
  | 'excerpt_not_in_source'
  | 'visual_without_description'
  | 'unknown_predicate'
  | 'unknown_node_type'
  | 'unknown_subject'
  | 'unknown_object'
  | 'literal_object'
  | 'empty_excerpt'

export interface Quarantined {
  reason: QuarantineReason
  detail: string
  payload: unknown
}

export interface AnchorSources {
  /** ref → the block's real text, as stored. */
  textByRef: Map<string, string>
  /** ref → the description produced for that panel in this run. */
  descriptionByRef: Map<string, string>
  /** Every ref the model was allowed to cite. */
  allowedRefs: Set<string>
}

export function buildAnchorSources(input: {
  textBlocks: Array<{ ref: string; text: string }>
  descriptions: PanelDescription[]
  allowedRefs: string[]
}): AnchorSources {
  return {
    textByRef: new Map(input.textBlocks.map((b) => [b.ref, b.text])),
    descriptionByRef: new Map(
      input.descriptions.map((d) => [
        d.panel_ref,
        // The whole description, including the visual descriptors and actions:
        // a claim citing "a tall figure in a striped scarf" must anchor against
        // the descriptor list, not only the prose.
        [d.description, d.setting ?? '', ...d.characters_visible, ...d.actions].join(' \n '),
      ]),
    ),
    allowedRefs: new Set(input.allowedRefs),
  }
}

export interface AnchorFailure {
  reason: QuarantineReason
  detail: string
}

/** Check one evidence citation. Returns null when it holds. */
export function checkEvidence(
  ref: EvidenceRef,
  sources: AnchorSources,
): AnchorFailure | null {
  if (!sources.allowedRefs.has(ref.ref)) {
    return {
      reason: 'unknown_ref',
      detail:
        `La référence « ${ref.ref} » ne fait pas partie des références fournies. ` +
        `Une référence inventée est le signe d'une affirmation qui ne vient pas des pages.`,
    }
  }

  const excerpt = ref.excerpt.trim()
  if (excerpt.length === 0) {
    return {
      reason: 'empty_excerpt',
      detail: 'Preuve sans extrait : rien à vérifier.',
    }
  }

  if (ref.kind === 'text') {
    const source = sources.textByRef.get(ref.ref)
    if (source === undefined) {
      return {
        reason: 'unknown_ref',
        detail: `« ${ref.ref} » n'est pas un bloc de texte. Une preuve textuelle doit citer un bloc.`,
      }
    }
    const match = anchorMatch(excerpt, source)
    if (!match.matched) {
      return {
        reason: 'excerpt_not_in_source',
        detail:
          `L'extrait « ${truncate(excerpt)} » n'apparaît pas dans le bloc ${ref.ref} ` +
          `(« ${truncate(source)} »). Une citation reformulée n'est pas une citation.`,
      }
    }
    return null
  }

  const description = sources.descriptionByRef.get(ref.ref)
  if (description === undefined) {
    return {
      reason: 'visual_without_description',
      detail:
        `Preuve visuelle sur ${ref.ref}, mais aucune description n'a été produite pour cette case ` +
        `dans ce traitement. Sans description, rien ne peut être vérifié.`,
    }
  }

  const match = anchorMatch(excerpt, description)
  if (!match.matched) {
    return {
      reason: 'excerpt_not_in_source',
      detail:
        `L'extrait visuel « ${truncate(excerpt)} » ne correspond pas à la description de ${ref.ref} ` +
        `(« ${truncate(description)} »).`,
    }
  }
  return null
}

export interface OntologyView {
  nodeTypes: Set<string>
  predicates: Set<string>
  /**
   * Predicates whose object may be a literal instead of an entity.
   *
   * Empty for the ontology we ship: every built-in predicate declares entity
   * object types, `dies_at` accepting an event, a battle or a place. A
   * user-defined predicate with no declared object type is the one case where a
   * value belongs in that slot, and this is where it is recorded.
   *
   * Absent means "check nothing", so a caller written before this existed keeps
   * behaving as it did.
   */
  literalObjects?: Set<string>
}

export interface FilterResult {
  accepted: Extraction
  quarantined: Quarantined[]
}

/**
 * Split an extraction into what can be trusted and what cannot.
 *
 * Order matters: entities are filtered first, because an assertion whose
 * subject was itself quarantined has nothing to attach to. Dropping the
 * assertion silently would hide the reason — so it is quarantined too, with a
 * reason that names the missing subject.
 */
export function filterExtraction(
  extraction: Extraction,
  sources: AnchorSources,
  ontology: OntologyView,
  knownEntityIds: Set<string>,
): FilterResult {
  const quarantined: Quarantined[] = []

  const entities: CandidateEntity[] = []
  const localIds = new Set<string>()

  for (const entity of extraction.entities) {
    if (!ontology.nodeTypes.has(entity.node_type)) {
      quarantined.push({
        reason: 'unknown_node_type',
        detail: `Type de nœud inconnu : « ${entity.node_type} ».`,
        payload: entity,
      })
      continue
    }

    const failure = firstFailure(entity.evidence, sources)
    if (failure) {
      quarantined.push({ ...failure, payload: entity })
      continue
    }

    entities.push(entity)
    localIds.add(entity.local_id)
  }

  const resolvable = (ref: string): boolean =>
    localIds.has(ref) || knownEntityIds.has(ref)

  const assertions: CandidateAssertion[] = []
  for (const assertion of extraction.assertions) {
    if (!ontology.predicates.has(assertion.predicate)) {
      quarantined.push({
        reason: 'unknown_predicate',
        detail: `Prédicat inconnu : « ${assertion.predicate} ».`,
        payload: assertion,
      })
      continue
    }

    if (!resolvable(assertion.subject)) {
      quarantined.push({
        reason: 'unknown_subject',
        detail:
          `Sujet « ${assertion.subject} » introuvable : ni une entité proposée et retenue, ` +
          `ni une entité déjà validée. L'entité a peut-être été mise en quarantaine.`,
        payload: assertion,
      })
      continue
    }

    if (assertion.object !== null && assertion.object.length > 0 && !resolvable(assertion.object)) {
      quarantined.push({
        reason: 'unknown_object',
        detail: `Objet « ${assertion.object} » introuvable.`,
        payload: assertion,
      })
      continue
    }

    const failure = firstFailure(assertion.evidence, sources)
    if (failure) {
      quarantined.push({ ...failure, payload: assertion })
      continue
    }

    /*
     * A relation joins two things. A sentence is not one of them.
     *
     * « Kuina — meurt à — "Kuina meurt en tombant dans un escalier" » is what
     * this catches: a real fact, phrased as prose and dropped into the object
     * slot, where it forms no edge, joins nothing, and cannot be found from the
     * other end. The ontology already says what `dies_at` takes — an event, a
     * battle or a place — and the model, having none to hand, wrote the story
     * instead. What it wrote is an *event*, and the extraction has a category
     * for those.
     *
     * After the evidence check, deliberately. An unanchored claim must be
     * quarantined as unanchored whatever else is wrong with it — that is the
     * guarantee the blocking tests are about, and a second reason arriving
     * first would quietly take its place in them.
     *
     * Quarantined rather than dropped, so the reason is visible and the fact is
     * not silently lost: the panel says the object must be an entity, which is
     * also the sentence that prevents the next occurrence.
     */
    const literal = assertion.object_value?.trim() ?? ''
    const hasEntityObject = assertion.object !== null && assertion.object.length > 0
    const allowsLiteral = ontology.literalObjects?.has(assertion.predicate) ?? false

    if (!hasEntityObject && literal.length > 0 && !allowsLiteral) {
      quarantined.push({
        reason: 'literal_object',
        detail:
          `L'objet de « ${assertion.predicate} » doit être une entité, pas une phrase : ` +
          `« ${literal.slice(0, 120)} ». Ce qui se raconte en une phrase est un événement.`,
        payload: assertion,
      })
      continue
    }

    assertions.push(assertion)
  }

  const events: CandidateEvent[] = []
  for (const event of extraction.events) {
    const failure = firstFailure(event.evidence, sources)
    if (failure) {
      quarantined.push({ ...failure, payload: event })
      continue
    }
    events.push({
      ...event,
      // Participants that did not survive are dropped from the list rather than
      // sinking the whole event: an event is still a real event if one of its
      // participants could not be anchored.
      participants: event.participants.filter(resolvable),
    })
  }

  const mysteries: CandidateMystery[] = []
  for (const mystery of extraction.mysteries) {
    const failure = firstFailure(mystery.evidence, sources)
    if (failure) {
      quarantined.push({ ...failure, payload: mystery })
      continue
    }
    mysteries.push(mystery)
  }

  return {
    accepted: { entities, assertions, events, mysteries },
    quarantined,
  }
}

/**
 * All evidence must hold, not just one piece.
 *
 * The permissive reading — "at least one citation checks out" — would let a
 * model attach one real quote to a claim and pad the rest with invented refs,
 * which is precisely the failure this guard exists to catch.
 */
function firstFailure(
  refs: EvidenceRef[],
  sources: AnchorSources,
): AnchorFailure | null {
  for (const ref of refs) {
    const failure = checkEvidence(ref, sources)
    if (failure) return failure
  }
  return null
}

/**
 * Does a transcription look like it came from the page rather than from memory?
 *
 * OCR and model transcription both produce text nothing else can be checked
 * against, so there is no anchor available. What *can* be checked is that a
 * model asked to transcribe did not instead narrate: a transcription whose
 * blocks cite panel refs that do not exist is not a transcription.
 */
export function filterTranscription(
  blocks: Array<{ panel_ref: string; text: string; kind: string; confidence: number }>,
  allowedRefs: Set<string>,
): {
  accepted: typeof blocks
  quarantined: Quarantined[]
} {
  const accepted: typeof blocks = []
  const quarantined: Quarantined[] = []

  for (const block of blocks) {
    // 'hors_case' is the documented escape hatch for page furniture.
    if (block.panel_ref !== 'hors_case' && !allowedRefs.has(block.panel_ref)) {
      quarantined.push({
        reason: 'unknown_ref',
        detail: `Bloc rattaché à « ${block.panel_ref} », qui n'est pas une case de cette page.`,
        payload: block,
      })
      continue
    }
    if (block.text.trim().length === 0) continue
    accepted.push(block)
  }

  return { accepted, quarantined }
}

/**
 * Stable identity of a proposal, for surviving a re-import.
 *
 * Hashes the normalised claim together with its evidence anchors. Two runs over
 * the same chapter produce the same fingerprint, so a decision recorded against
 * it applies again automatically and the item never returns to the queue. It
 * deliberately does *not* include confidence, the model id or the prompt
 * version: a better model reaching the same conclusion from the same evidence
 * is the same proposal, and re-asking about it would be exactly the annoyance
 * this mechanism exists to remove.
 */
export function proposalFingerprint(parts: {
  kind: 'entity' | 'assertion' | 'event' | 'mystery'
  subject: string
  predicate?: string
  object?: string | null
  evidence: EvidenceRef[]
}): string {
  const anchors = parts.evidence
    .map((e) => `${e.ref}:${e.kind}:${normalizeText(e.excerpt)}`)
    .sort()

  const canonical = [
    parts.kind,
    normalizeText(parts.subject),
    parts.predicate ?? '',
    normalizeText(parts.object ?? ''),
    ...anchors,
  ].join('|')

  return createHash('sha256').update(canonical).digest('hex')
}

function truncate(value: string, max = 90): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
