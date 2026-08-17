import { createHash } from 'node:crypto'
import { anchorMatch, isAnchoredIn, normalizeText } from '../knowledge/normalize.ts'
import { OCCURRENCE_TYPES, type OccurrenceKind } from '../knowledge/ontology.ts'
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
  | 'missing_object'
  | 'self_reference'
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
  /**
   * Whether a near-miss counts as a quote.
   *
   * True only where a machine read the source. See `matches()` below for why
   * this is not a tuning knob.
   */
  tolerateNoise: boolean
}

export function buildAnchorSources(input: {
  textBlocks: Array<{ ref: string; text: string }>
  descriptions: PanelDescription[]
  allowedRefs: string[]
  /** `sourceKind === 'pages'`. Stated by the caller, never defaulted. */
  tolerateNoise: boolean
}): AnchorSources {
  return {
    tolerateNoise: input.tolerateNoise,
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

/**
 * Is this excerpt a quote of that source?
 *
 * Exact, unless a machine did the reading. The edit-distance budget in
 * `anchorMatch` exists for OCR confusions — rn/m, l/I, 0/O — on scanned pages,
 * where the stored text is itself a guess and demanding character equality
 * would reject quotes that are perfectly faithful to the printed page.
 *
 * A chapter you typed has no such excuse (ADR 0008: « un extrait apparaît dans
 * votre texte ou n'y apparaît pas »), and the tolerance there does active harm
 * in two ways.
 *
 * It admits paraphrase. The budget is capped at four edits, so on a long
 * sentence it comfortably absorbs a short word swapped for another: « **he**
 * tells Zoro how Luffy punched Helmeppo » passed against a passage reading
 * « **Koby** tells Zoro how Luffy punched Helmeppo ». Four edits, budget four.
 * That is a different claim about who spoke, which is precisely what this
 * module exists to catch — and `checkEvidence` says so itself, one screen up:
 * une citation reformulée n'est pas une citation.
 *
 * And it disagrees with the database. `app.validate_evidence_anchor` requires
 * the normalised excerpt to occur in the block, with no tolerance whatsoever
 * (migration 0006). A near-miss accepted here therefore reaches the review
 * queue, gets accepted by a reviewer, and fails at publication — inside the
 * transaction, so it takes the whole batch down with it and the chapter cannot
 * be published at all. The application must not accept what the database will
 * refuse; `tests/db/normalize-parity.test.ts` states that contract, and this is
 * the branch that has to hold up its end.
 */
function matches(excerpt: string, source: string, tolerateNoise: boolean): boolean {
  return tolerateNoise ? anchorMatch(excerpt, source).matched : isAnchoredIn(excerpt, source)
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
    if (!matches(excerpt, source, sources.tolerateNoise)) {
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

/**
 * A scene's in-world date, kept only if the chapter says it.
 *
 * Checked against the blocks the *event itself* cites, and no others. That
 * restriction is what stops the field from becoming a back door: a chapter is
 * full of numbers, and a quote hunted down anywhere in it could date any scene
 * with any of them. « Dix ans plus tôt » has to be in the same passage that
 * proves the event, which is the same thing as saying the chapter dated *this*
 * scene rather than that the words appear somewhere in the volume.
 *
 * Visual refs are excluded on purpose. A dating quote is a sentence the chapter
 * writes; a panel description is a sentence *this run* wrote about a drawing,
 * and letting a date anchor to it would let the model date a scene against its
 * own earlier output.
 */
function anchorStoryTime(
  event: CandidateEvent,
  sources: AnchorSources,
): { accepted: CandidateEvent['story_time']; rejected: Quarantined | null } {
  const time = event.story_time
  if (time === null || time === undefined) return { accepted: null, rejected: null }

  const quote = time.quote.trim()
  const cited = event.evidence
    .filter((ref) => ref.kind === 'text')
    .map((ref) => sources.textByRef.get(ref.ref))
    .filter((text): text is string => text !== undefined)

  if (quote.length > 0 && cited.some((text) => matches(quote, text, sources.tolerateNoise))) {
    return { accepted: time, rejected: null }
  }

  return {
    accepted: null,
    rejected: {
      reason: 'excerpt_not_in_source',
      detail:
        `La datation « ${truncate(time.description)} » cite « ${truncate(quote)} », ` +
        `qui n'apparaît dans aucun des blocs cités par la scène. ` +
        `L'événement est conservé sans date : c'est la date qui n'est pas prouvée, pas la scène.`,
      payload: { local_id: event.local_id, story_time: time },
    },
  }
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
 * Node types the extraction has an array of its own for.
 *
 * An occurrence and a `mystery` are in the ontology because a relation has to
 * be able to point at one — `participates_in` takes an event, `resolves_mystery`
 * takes a mystery. They are not there to be *proposed* as entities, and the two
 * are a hair apart in a schema that offers `entities`, `events` and `mysteries`
 * side by side.
 *
 * All three occurrence types, not `event` alone. `battle` and `voyage` are node
 * types the model may write in that same slot, and it writes them for the best
 * of reasons: it classified the scene *better*. « Dix ans plus tard, Luffy
 * quitte seul le Village de Fuchsia pour prendre la mer » is a voyage, said so,
 * and went straight past a door that was only watching for the word `event`.
 */
const OCCURRENCE = new Set<string>(OCCURRENCE_TYPES)
const HAS_OWN_CATEGORY = new Set<string>([...OCCURRENCE, 'mystery'])

/**
 * An event proposed as an entity, put back where events go.
 *
 * The failure this repairs is silent and total. An `entities` row of an
 * occurrence type is a node with a sentence for a name and no row in `events`:
 * absent from the chronology, which reads that table; absent from story mode's
 * « il arrive », which reads it too; and caught instead by the arm that
 * announces whoever has no beat of their own — so a chapter's six events
 * arrived as six characters walking on, labelled « entre en scène ·
 * Événement ». Nothing about it is visible in review, where the card says
 * « entité » and shows a sentence, which is exactly what an event card shows.
 *
 * And it does not stay quiet in its own chapter. The node is an entity like any
 * other, so the next chapter's extraction is handed it among the people and the
 * places — a sentence naming three characters, offered as something a relation
 * may point at. `located_at`, `travels_from` and `travels_to` all accept an
 * occurrence as their subject, so « <la phrase où Luffy quitte Fuchsia> se
 * trouve à la Base de la Marine » is well typed, passes every check, and reads
 * on the review card as a claim about Luffy. The scene has become the character
 * it mentions.
 *
 * The prompt now says where an event goes (PROMPT_VERSION 6). This is the part
 * that does not depend on the model having read it — the same division of
 * labour as everywhere else in this file.
 *
 * A mystery is refiled only when nothing in the extraction names it, and that
 * asymmetry is not an oversight: an event keeps its `local_id` and stays
 * referenceable, a mystery has none in the schema, so refiling one that a
 * relation points at would cut the edge in the name of tidiness. Left as an
 * entity, it is at least a node the relation still reaches.
 */
export function refileMisfiled(extraction: Extraction): {
  extraction: Extraction
  refiled: { events: number; mysteries: number }
} {
  if (!extraction.entities.some((entity) => HAS_OWN_CATEGORY.has(entity.node_type))) {
    return { extraction, refiled: { events: 0, mysteries: 0 } }
  }

  const named = new Set<string>([
    ...extraction.assertions.flatMap((assertion) =>
      assertion.object === null ? [assertion.subject] : [assertion.subject, assertion.object],
    ),
    ...extraction.events.flatMap((event) => event.participants),
  ])

  const entities: CandidateEntity[] = []
  const events = [...extraction.events]
  const mysteries = [...extraction.mysteries]
  const refiled = { events: 0, mysteries: 0 }

  for (const entity of extraction.entities) {
    if (OCCURRENCE.has(entity.node_type)) {
      events.push({
        local_id: entity.local_id,
        summary: entity.label,
        /*
         * The sort of scene it said this was, carried over rather than guessed
         * again — and only when it says more than the fallback would.
         *
         * Publication resolves an absent `kind` by re-reading the summary, and
         * that reading never returns `voyage` on purpose: a departure has no
         * vocabulary a chapter of seafaring does not use constantly. So dropping
         * a stated `voyage` here would file the one scene the model named
         * precisely as an ordinary event, invisibly.
         *
         * `event` is the fallback's own answer, and stating it would be worse
         * than saying nothing: « Zoro affronte Baggy en duel » misfiled as an
         * entity of type `event` is still a combat, and it is the re-reading
         * that finds it. Silence here is what keeps that door open.
         */
        ...(entity.node_type === 'event'
          ? {}
          : { kind: entity.node_type as OccurrenceKind }),
        participants: [],
        // Nothing in an entity proposal says a scene is a memory. Claiming it
        // is one would put it at the wrong place on the story axis, which is
        // the one thing the timeline exists to get right.
        is_flashback: false,
        evidence: entity.evidence,
        confidence: entity.confidence,
      })
      refiled.events++
      continue
    }

    if (entity.node_type === 'mystery' && !named.has(entity.local_id)) {
      mysteries.push({
        question: entity.label,
        evidence: entity.evidence,
        confidence: entity.confidence,
      })
      refiled.mysteries++
      continue
    }

    entities.push(entity)
  }

  return {
    extraction: { entities, assertions: extraction.assertions, events, mysteries },
    refiled,
  }
}

/**
 * Split an extraction into what can be trusted and what cannot.
 *
 * Order matters: entities are filtered first, because an assertion whose
 * subject was itself quarantined has nothing to attach to. Dropping the
 * assertion silently would hide the reason — so it is quarantined too, with a
 * reason that names the missing subject.
 *
 * Events are filtered second, before the assertions rather than after them, and
 * that ordering is a fix rather than a tidy-up. An event is a node — half the
 * ontology's temporal predicates take one as their object — and while its
 * `local_id` was absent from the resolvable set, « Zoro participe à <l'attaque
 * du Buggy Ball> » could not be written by anyone: the model proposed the
 * event, named it in a relation, and the relation was quarantined as
 * `unknown_object` for naming something this very response had declared.
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

  const events: CandidateEvent[] = []
  for (const event of extraction.events) {
    const failure = firstFailure(event.evidence, sources)
    if (failure) {
      quarantined.push({ ...failure, payload: event })
      continue
    }

    /*
     * The dating, held to the same standard as everything else — and dropped on
     * its own rather than sinking the scene.
     *
     * An event whose evidence anchors is a real event; that the model then
     * paraphrased the sentence giving its date is a fault in one field, and
     * throwing away « Shanks perd son bras » because « il y a dix ans » was
     * quoted loosely would lose a fact to punish a footnote. So the scene
     * publishes undated, and the rejected dating goes to quarantine on its own
     * — visible in the review centre, where a silent drop would not be.
     */
    const dating = anchorStoryTime(event, sources)
    if (dating.rejected) quarantined.push(dating.rejected)

    events.push({
      ...event,
      story_time: dating.accepted,
      // Participants that did not survive are dropped from the list rather than
      // sinking the whole event: an event is still a real event if one of its
      // participants could not be anchored.
      //
      // Read before the event's own id joins the set, so a participant list
      // cannot name the event it belongs to.
      participants: event.participants.filter(resolvable),
    })
  }

  // Now the events are nodes like any other, and a relation may name one.
  for (const event of events) localIds.add(event.local_id)

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
    /*
     * Nothing is related to itself.
     *
     * « Qui a fait exploser le rhum de Dorry ? — résout le mystère — Qui a fait
     * exploser le rhum de Dorry ? » is what this catches: the model, handed the
     * open questions among the validated entities and asked which of them this
     * chapter answers, points the relation back at the question instead of at
     * the scene that answers it. Both ends are the same identifier, every other
     * check agrees, and the card in review shows the same sentence twice.
     *
     * The ontology now refuses a question as the subject of the three mystery
     * predicates, which covers that case at the type level. This is the general
     * statement, and it is worth making on its own: a relation joins two things,
     * and one thing is not two. « Zoro rencontre Zoro » says nothing either, and
     * on an identity predicate a loop would join a node to itself in the
     * union-find for ever.
     *
     * Compared on the identifier before it is resolved, so it catches what the
     * response wrote. The same loop can also be *created* later — publication
     * joins a proposal to an entity already in the graph by its label, and two
     * different identifiers can land on one row — which is why publication
     * checks again on the resolved ids.
     */
    if (
      assertion.object !== null &&
      assertion.object.trim().length > 0 &&
      assertion.object.trim() === assertion.subject.trim()
    ) {
      quarantined.push({
        reason: 'self_reference',
        detail:
          `« ${assertion.predicate} » joint « ${assertion.subject} » à lui-même. ` +
          `Une relation joint deux choses distinctes : une question ne se résout pas ` +
          `elle-même, et rien ne se rencontre soi-même.`,
        payload: assertion,
      })
      continue
    }

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

    /*
     * A relation with one end is not a relation.
     *
     * « Kaloo — blesse — ∅ » is what this catches: the chapter says a stray
     * bullet hits him, there is no shooter to point at, and the model writes the
     * predicate anyway with `object` and `object_value` both null. Every other
     * check agrees — the predicate exists, the subject resolves, the excerpt is
     * a real quote — so the card reaches review reading « Kaloo blesse », with
     * nothing after the verb and no way to tell that accepting it cannot work.
     *
     * The database has said so since the first migration: `assertion_has_object`
     * demands one of the two columns. It was saying it at the last possible
     * moment, in the red block after « Publier », as
     * « violates check constraint "assertion_has_object" » — a sentence about a
     * constraint name, for a reviewer who asked about a duck.
     *
     * Universal, and not a property of the predicate: even one the ontology lets
     * carry a literal must carry *that*. A predicate with nothing on the other
     * side states nothing, and what the chapter did show — someone is hit, by
     * something nobody can name — is an event, which the extraction has a
     * category for.
     */
    if (!hasEntityObject && literal.length === 0) {
      quarantined.push({
        reason: 'missing_object',
        detail:
          `« ${assertion.predicate} » n'a pas d'objet : ni entité, ni valeur. ` +
          `Une relation joint deux choses, et il n'y en a qu'une ici. ` +
          `Si l'autre bout n'a pas de nom dans le chapitre, c'est un événement.`,
        payload: assertion,
      })
      continue
    }

    assertions.push(assertion)
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
