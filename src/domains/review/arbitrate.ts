import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { withIngest } from '@/db/boundary.ts'
import { reviewItems } from '@/db/schema/ingestion.ts'
import type { ModelProvider } from '@/domains/ai/provider.ts'
import {
  fetchChapterPages,
  type Fetcher,
  type FandomPage,
} from '@/domains/ingestion/fandom.ts'
import { autoAcceptThreshold } from './auto.ts'
import {
  arbitrationNote,
  arbitrationResult,
  briefsFor,
  settle,
  slices,
  type Arbitrated,
  type ArbitrationResult,
  type Guards,
  type PendingCard,
} from './arbitration.ts'
import { publishDecisions, type Decision, type PublishResult } from './publish.ts'
import {
  lacksObject,
  mismatchOf,
  referencedIds,
  resolveNames,
  resolveNodeTypes,
} from './queue.ts'

/**
 * La moitié qui va chercher la page, appelle le modèle et écrit ce qu'il a dit.
 *
 * `arbitration.ts` porte la règle et se teste sans base ni appel ; ici se
 * trouve tout ce qui touche au monde. Le partage est celui de `identity-sweep`
 * et de son script, et pour la même raison : une règle qu'on ne peut exercer
 * qu'au prix d'un appel payant est une règle que personne ne vérifie.
 *
 * Trois choses que cette moitié doit faire correctement, et aucune n'est du
 * ressort de la règle :
 *
 *   Une tranche perdue ne perd pas les autres. Un chapitre part en tranches de
 *   quarante cartes ; la troisième qui échoue sur un « Overloaded » laissait
 *   sinon les deux premières payées et non écrites. Chaque tranche s'écrit dès
 *   qu'elle revient, et un échec ne coûte que sa tranche.
 *
 *   Ce que le modèle a dit s'écrit sur la carte, décidé ou non. Une carte qui
 *   remonte au lecteur porte l'avis et la phrase du wiki, c'est-à-dire l'essentiel
 *   du travail d'enquête ; une carte acceptée sans lui garde par écrit sur quelle
 *   phrase — « qu'est-ce qui est entré sans moi » est la question qu'on se pose
 *   trois mois plus tard.
 *
 *   Les décisions passent par `publishDecisions`, comme celles d'un humain.
 *   C'est la seule porte du graphe, elle est atomique et elle journalise ; une
 *   passe automatique qui écrirait à côté serait une seconde porte, avec ses
 *   propres bogues et sans son journal.
 */

export interface ArbitrateOutcome {
  result: ArbitrationResult
  published: PublishResult | null
  /** Pourquoi rien n'a tourné. Null quand la passe a eu lieu. */
  skipped: string | null
  costCents: number
  tokensIn: number
  tokensOut: number
  modelId: string | null
  /** Les tranches perdues en route, avec leur raison. */
  failures: string[]
}

const empty = (skipped: string | null): ArbitrateOutcome => ({
  result: { submitted: 0, accepted: 0, rejected: 0, undecided: 0, refused: 0, advisory: 0, pages: [] },
  published: null,
  skipped,
  costCents: 0,
  tokensIn: 0,
  tokensOut: 0,
  modelId: null,
  failures: [],
})

export async function arbitrateRun(options: {
  userId: string
  runId: string
  chapterNumber: number
  provider: ModelProvider
  /** Injecté par les tests, qui ne touchent jamais le réseau. */
  fetcher?: Fetcher
}): Promise<ArbitrateOutcome> {
  const { userId, runId, chapterNumber, provider } = options

  const pending = await withIngest(async (db) => {
    const rows = await db
      .select({
        itemId: reviewItems.id,
        category: reviewItems.category,
        payload: reviewItems.payload,
        fingerprint: reviewItems.proposalFingerprint,
        confidence: reviewItems.confidence,
        requiresExplicitReview: reviewItems.requiresExplicitReview,
      })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.runId, runId),
          eq(reviewItems.userId, userId),
          eq(reviewItems.status, 'proposed'),
        ),
      )
      // Priorité d'abord, comme la file : si une tranche se perd, celles qui
      // sont parties portaient les cartes dont l'erreur coûte le plus cher.
      .orderBy(desc(reviewItems.priority))
    return rows as PendingCard[]
  })

  if (pending.length === 0) return empty('Aucune proposition à arbitrer.')

  /*
   * La page, entière, dans les deux langues.
   *
   * Sans elle il n'y a pas d'arbitrage du tout : tout verdict s'appuie sur une
   * phrase trouvée dedans, donc une passe sans page ne pourrait qu'abstenir
   * quarante fois au prix d'un appel. L'étape se déclare ignorée et dit
   * pourquoi, ce qui est une information ; la file, elle, est intacte.
   */
  const fetched = await fetchChapterPages(chapterNumber, options.fetcher)
  if (fetched.pages.length === 0) {
    return empty(
      `Page du chapitre ${chapterNumber} introuvable sur le Fandom : ` +
        (fetched.problems.map((p) => `${p.language} — ${p.reason}`).join(' · ') ||
          'aucune raison rapportée') +
        '. Les propositions restent en file.',
    )
  }

  const names = Object.fromEntries(await resolveNames(pending, pending))
  const guards = await guardsFor(pending)
  const briefs = briefsFor(pending, names, autoAcceptThreshold())

  const settled: Arbitrated[] = []
  const failures: string[] = []
  let costCents = 0
  let tokensIn = 0
  let tokensOut = 0
  let modelId: string | null = null

  for (const slice of slices(briefs)) {
    let answered: Arbitrated[]

    try {
      const reply = await provider.arbitrate({
        chapterNumber,
        pages: fetched.pages.map(forPrompt),
        cards: slice.map((brief) => brief.card),
      })

      costCents += reply.usage.costCents
      tokensIn += reply.usage.inputTokens
      tokensOut += reply.usage.outputTokens
      modelId = reply.usage.modelId

      /*
       * Un refus est une réponse, pas une panne.
       *
       * Le fournisseur rend `refusal` et laisse `value` indéfini ; le lire sans
       * vérifier ferait planter la tranche sur un champ absent, ce qui
       * transformerait « le modèle n'a pas voulu » en « l'arbitrage est cassé ».
       */
      if (reply.refusal) {
        failures.push(`Tranche refusée par le modèle : ${reply.refusal}`)
        continue
      }

      answered = settle(reply.value, slice, fetched.pages, guards)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'Erreur inconnue.')
      continue
    }

    await writeRecords(userId, answered)
    settled.push(...answered)
  }

  const result = arbitrationResult(settled, fetched.pages)
  const decisions = settled
    .filter((one) => one.record.applied)
    .map(
      (one): Decision => ({
        reviewItemId: one.itemId,
        decision: one.record.verdict === 'accept' ? 'accept' : 'reject',
        // Le journal d'audit porte la raison et la citation : la décision est
        // relisible sans rouvrir la page du wiki, qui aura pu changer.
        comment: `Arbitrage : ${one.record.reason} « ${one.record.quote} »`,
      }),
    )

  const published =
    decisions.length === 0 ? null : await publishDecisions(userId, runId, decisions)

  return { result, published, skipped: null, costCents, tokensIn, tokensOut, modelId, failures }
}

/** La note d'étape, une fois la passe faite. */
export function arbitrateNote(outcome: ArbitrateOutcome): string {
  const parts = [arbitrationNote(outcome.result)]

  if (outcome.published && outcome.published.failures.length > 0) {
    parts.push(`${outcome.published.failures.length} non appliquée(s)`)
  }
  if (outcome.failures.length > 0) {
    parts.push(`${outcome.failures.length} tranche(s) perdue(s) : ${outcome.failures[0]}`)
  }

  return parts.join(' · ')
}

/**
 * Ce qu'une carte seule ne peut pas savoir d'elle-même.
 *
 * Trois lectures que la règle ne peut pas faire — elle n'a ni base ni
 * ontologie — et dont chacune décide si un verdict est applicable. Calculées
 * une fois pour tout le traitement, sur toutes les cartes en attente, plutôt
 * qu'une fois par tranche : ce qui protège une entité, c'est n'importe quelle
 * carte qui la nomme, y compris une carte partie dans une autre tranche.
 */
async function guardsFor(pending: readonly PendingCard[]): Promise<Guards> {
  const protectedIds = new Set(pending.flatMap((item) => referencedIds(item.payload)))

  const contested = new Set(
    pending
      .filter((item) => item.category === 'resolution')
      .map((item) =>
        item.payload !== null && typeof item.payload === 'object'
          ? (item.payload as Record<string, unknown>).candidateFingerprint
          : null,
      )
      .filter((fingerprint): fingerprint is string => typeof fingerprint === 'string'),
  )

  /*
   * Ce que la publication refuserait de toute façon.
   *
   * Une relation au prédicat incompatible échouerait au déclencheur, une
   * relation sans objet à la contrainte — dans les deux cas contenue par un
   * point de sauvegarde, donc sans dégât, mais l'appel aurait été dépensé pour
   * une carte qui revient au lecteur quand même. Autant le lui dire tout de
   * suite : sa carte, elle, porte les prédicats de rechange.
   */
  const nodeTypes = await resolveNodeTypes([...pending], [...pending])
  const unpublishable = new Map<string, string>()

  for (const item of pending) {
    if (item.category !== 'assertion') continue

    if (lacksObject(item.payload)) {
      unpublishable.set(
        item.itemId,
        'Relation sans objet : elle n’a qu’un bout, donc elle ne s’écrit pas.',
      )
      continue
    }

    const mismatch = mismatchOf(item.payload, nodeTypes)
    if (mismatch !== null) {
      unpublishable.set(
        item.itemId,
        'Prédicat incompatible avec les deux bouts : la carte de revue propose ' +
          'ceux qui conviennent, et choisir est un jugement sur le sens.',
      )
    }
  }

  return { protectedIds, contested, unpublishable }
}

function forPrompt(page: FandomPage): {
  language: string
  page: string
  url: string
  text: string
} {
  return { language: page.language, page: page.page, url: page.url, text: page.text }
}

/**
 * Ce que le modèle a répondu, écrit sur la carte.
 *
 * Une requête par verdict distinct plutôt qu'une par carte : sur une tranche de
 * quarante, la plupart des réponses sont le même « undecided » avec le même
 * motif, et quarante allers-retours pour écrire trois valeurs différentes est un
 * coût que rien ne justifie.
 */
async function writeRecords(userId: string, settled: readonly Arbitrated[]): Promise<void> {
  if (settled.length === 0) return

  const groups = new Map<string, { record: Arbitrated['record']; ids: string[] }>()
  for (const one of settled) {
    const key = JSON.stringify(one.record)
    const existing = groups.get(key)
    if (existing) existing.ids.push(one.itemId)
    else groups.set(key, { record: one.record, ids: [one.itemId] })
  }

  await withIngest(async (db) => {
    for (const group of groups.values()) {
      await db
        .update(reviewItems)
        .set({ arbitration: group.record })
        .where(and(eq(reviewItems.userId, userId), inArray(reviewItems.id, group.ids)))
    }
  })
}
