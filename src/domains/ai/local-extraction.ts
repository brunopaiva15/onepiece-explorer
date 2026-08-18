import { normalizeText } from '@/domains/knowledge/normalize.ts'
import type { ExtractRequest } from './provider.ts'
import type {
  CandidateAssertion,
  CandidateEntity,
  CandidateEvent,
  CandidateMystery,
  EvidenceRef,
  Extraction,
} from './schemas.ts'

/**
 * Qwen/llama.cpp is much more sensitive than Claude to JSON-Schema array
 * maxima: in practice it tends to read maxItems as a target. These limits are
 * therefore intentionally closer to the density Claude produces on the same
 * slices. They remain ceilings, not quotas.
 */
export interface LocalExtractionLimits {
  units: number
  entities: number
  assertions: number
  events: number
  mysteries: number
  maxTokens: number
}

export function localExtractionLimitsForUnits(rawUnits: number): LocalExtractionLimits {
  const units = Math.max(1, Math.floor(rawUnits))

  return {
    units,
    entities: Math.min(32, 4 + Math.ceil(units * 0.8)),
    assertions: Math.min(60, 6 + Math.ceil(units * 1.6)),
    events: Math.min(16, 3 + Math.ceil(units * 0.8)),
    mysteries: Math.min(6, 1 + Math.ceil(units * 0.2)),
    maxTokens: Math.min(12_000, Math.max(6_000, 4_500 + units * 400)),
  }
}

/**
 * Extra instructions for the self-hosted model only.
 *
 * Claude already behaves selectively with the shared extraction prompt. Qwen
 * needs the editorial rule stated much more literally or it atomises every
 * sentence into a card, then does it again for the parallel translation.
 */
export function localExtractionDiscipline(limits: LocalExtractionLimits): string {
  return [
    'DISCIPLINE DE SÉLECTION POUR CE MODÈLE AUTO-HÉBERGÉ.',
    'Les maxima du schéma sont des garde-fous, JAMAIS des objectifs à remplir.',
    'Cherchez la même granularité qu’un lecteur humain : quelques faits importants, pas une carte par phrase.',
    '',
    'UNE SCÈNE = UN ÉVÉNEMENT.',
    'Quand plusieurs phrases décrivent la même action, sa conséquence immédiate ou la même conclusion narrative,',
    'fusionnez-les dans UN seul événement. Ne créez jamais deux événements qui veulent dire la même chose avec',
    'des mots différents. Avant de rendre le JSON, relisez la liste et supprimez tout doublon ou quasi-doublon.',
    '',
    'LE TEXTE PARALLÈLE EST LE MÊME CHAPITRE, PAS UNE DEUXIÈME SOURCE.',
    'Il sert uniquement à faire correspondre les noms entre les langues. Un fait vu dans le texte principal et',
    'reformulé dans le texte parallèle ne doit produire qu’UNE proposition. Ne doublez jamais une entité, une',
    'relation, un événement ou un mystère parce que les deux langues racontent la même chose.',
    '',
    'RÉUTILISEZ CE QUI EXISTE.',
    'Si les entités déjà validées ou déjà proposées contiennent la même chose, avec le même type et le même nom,',
    'utilisez leur identifiant. Ne créez pas un nouveau local_id pour Luffy, Cobra, la Marine, un équipage ou tout',
    'autre nœud déjà présent. source_term est une désignation courte de la source, jamais une phrase entière.',
    '',
    'UN MYSTÈRE EST UNE QUESTION NARRATIVE RÉELLEMENT LAISSÉE OUVERTE.',
    'Une information simplement omise, le nom d’un figurant non donné, un détail non précisé ou une phrase que',
    'vous pourriez transformer en question ne sont PAS des mystères. Deux formulations de la même inconnue donnent',
    'un seul mystère. Dans le doute, n’en créez pas.',
    '',
    'LES RELATIONS ÉCRIVENT DES LIENS DURABLES, PAS UNE DEUXIÈME VERSION DE CHAQUE ÉVÉNEMENT.',
    'N’épuisez pas les prédicats possibles. Une relation n’est utile que si elle ajoute un lien réutilisable dans le graphe.',
    'Ne créez pas une entité pour reformuler un fait, une action, un état ou la conclusion d’une scène :',
    'un nœud « concept » est une notion durable du monde, pas un événement nominalisé.',
    '',
    `Cette tranche contient ${limits.units} unité(s) de matière. Plafonds absolus : ` +
      `${limits.entities} entités, ${limits.assertions} relations, ` +
      `${limits.events} événements, ${limits.mysteries} mystères.`,
    'Une bonne réponse est normalement nettement en dessous de ces nombres.',
  ].join('\n')
}

export interface LocalCompactionStats {
  reusedEntities: number
  duplicateEntities: number
  duplicateAssertions: number
  duplicateEvents: number
  duplicateMysteries: number
}

interface ExistingEntityRef {
  id: string
  label: string
  nodeType: string
}

function entityKey(nodeType: string, label: string): string {
  return `${nodeType}\u0000${normalizeText(label)}`
}

function evidenceKey(evidence: EvidenceRef[]): string {
  return evidence
    .map((ref) => `${ref.ref}\u0000${ref.kind}\u0000${normalizeText(ref.excerpt)}`)
    .sort()
    .join('\u0001')
}

function assertionKey(assertion: CandidateAssertion): string {
  return [
    assertion.subject,
    assertion.predicate,
    assertion.object ?? '',
    normalizeText(assertion.object_value),
  ].join('\u0000')
}

function eventSummaryKey(event: CandidateEvent): string {
  return normalizeText(event.summary)
}

function eventEvidenceKey(event: CandidateEvent): string {
  const participants = [...new Set(event.participants)].sort().join('\u0000')
  return [
    event.kind ?? 'event',
    event.is_flashback ? 'flashback' : 'present',
    participants,
    evidenceKey(event.evidence),
  ].join('\u0001')
}

function mysteryKey(mystery: CandidateMystery): string {
  return normalizeText(mystery.question)
}

function resolveRef(ref: string, remap: Map<string, string>): string {
  let current = ref
  const seen = new Set<string>()
  while (remap.has(current) && !seen.has(current)) {
    seen.add(current)
    current = remap.get(current)!
  }
  return current
}

/**
 * Conservative, mechanical cleanup for the local model.
 *
 * This deliberately does not attempt semantic fuzzy matching. It removes only
 * things whose identity is mechanically defensible: exact normalised
 * label+type matches, exact relation triples, exact mystery wording, or events
 * backed by the exact same evidence and participant set. The more ambitious
 * judgement stays with the model/review pipeline.
 */
export function compactLocalExtraction(
  extraction: Extraction,
  context: {
    knownEntities: readonly ExistingEntityRef[]
    proposedSoFar?: readonly ExistingEntityRef[]
  },
): { value: Extraction; stats: LocalCompactionStats } {
  const stats: LocalCompactionStats = {
    reusedEntities: 0,
    duplicateEntities: 0,
    duplicateAssertions: 0,
    duplicateEvents: 0,
    duplicateMysteries: 0,
  }

  const identity = new Map<string, string>()
  for (const existing of [...context.knownEntities, ...(context.proposedSoFar ?? [])]) {
    const key = entityKey(existing.nodeType, existing.label)
    if (normalizeText(existing.label).length > 0 && !identity.has(key)) {
      identity.set(key, existing.id)
    }
  }

  const remap = new Map<string, string>()
  const entities: CandidateEntity[] = []

  for (const entity of extraction.entities) {
    const key = entityKey(entity.node_type, entity.label)
    const existing = identity.get(key)
    if (existing !== undefined) {
      remap.set(entity.local_id, existing)
      if (context.knownEntities.some((candidate) => candidate.id === existing) ||
          context.proposedSoFar?.some((candidate) => candidate.id === existing)) {
        stats.reusedEntities++
      } else {
        stats.duplicateEntities++
      }
      continue
    }

    identity.set(key, entity.local_id)
    entities.push(entity)
  }

  const remappedAssertions = extraction.assertions.map((assertion) => ({
    ...assertion,
    subject: resolveRef(assertion.subject, remap),
    object: assertion.object === null ? null : resolveRef(assertion.object, remap),
  }))

  const remappedEvents = extraction.events.map((event) => ({
    ...event,
    participants: event.participants.map((participant) => resolveRef(participant, remap)),
  }))

  const assertions: CandidateAssertion[] = []
  const assertionKeys = new Set<string>()
  for (const assertion of remappedAssertions) {
    const key = assertionKey(assertion)
    if (assertionKeys.has(key)) {
      stats.duplicateAssertions++
      continue
    }
    assertionKeys.add(key)
    assertions.push(assertion)
  }

  const events: CandidateEvent[] = []
  const eventSummaries = new Set<string>()
  const eventEvidence = new Set<string>()
  for (const event of remappedEvents) {
    const summary = eventSummaryKey(event)
    const evidence = eventEvidenceKey(event)
    if ((summary.length > 0 && eventSummaries.has(summary)) || eventEvidence.has(evidence)) {
      stats.duplicateEvents++
      continue
    }
    if (summary.length > 0) eventSummaries.add(summary)
    eventEvidence.add(evidence)
    events.push(event)
  }

  const mysteries: CandidateMystery[] = []
  const mysteryKeys = new Set<string>()
  for (const mystery of extraction.mysteries) {
    const key = mysteryKey(mystery)
    if (key.length > 0 && mysteryKeys.has(key)) {
      stats.duplicateMysteries++
      continue
    }
    if (key.length > 0) mysteryKeys.add(key)
    mysteries.push(mystery)
  }

  return {
    value: { entities, assertions, events, mysteries },
    stats,
  }
}

export function extractionUnits(request: ExtractRequest): number {
  if (request.source === 'summary') return request.textBlocks.length
  return request.descriptions.length > 0 ? request.descriptions.length : request.textBlocks.length
}
