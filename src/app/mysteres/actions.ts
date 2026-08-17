'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { ClaudeAgentError } from '@/domains/ai/claude-agent/runtime.ts'
import { consume } from '@/domains/observability/rate-limit.ts'
import {
  closeIfAnswered,
  openQuestions,
  providerReads,
  type OpenQuestion,
} from '@/domains/review/mystery-closing.ts'
import { tellableResolution } from '@/domains/review/mystery-sweep.ts'

/**
 * « L'histoire y a-t-elle répondu ? », posé depuis la page qui montre les
 * questions.
 *
 * Deux actions plutôt qu'une, parce que le balayage est long et que le découpage
 * est ce qui le rend utilisable dans un navigateur : la première établit la
 * liste, la seconde traite **une** question. La page les enchaîne et affiche
 * l'avancée ; une invocation ne tient jamais plus qu'un appel de modèle, ce qui
 * est la seule taille qui passe sous les trois cents secondes d'un hébergement
 * sans serveur.
 *
 * Le rapport rendu ici est celui d'un lecteur, pas celui du script. Le balayage
 * lit toute la bibliothèque publiée — c'est ce qui date une réponse correctement
 * — mais la personne qui a pressé le bouton est assise à un chapitre, et lui
 * annoncer « refermée au chapitre 412 » serait un spoiler passé par la porte
 * qu'elle a ouverte elle-même. Voir `tellableResolution`.
 */

export interface SweepPlan {
  ok: boolean
  questions?: OpenQuestion[]
  error?: string
}

/**
 * Les questions à examiner, telles que la table les connaît.
 *
 * Pas celles que la page affiche : « Sans réponse » à l'écran contient les
 * questions dont la résolution est postérieure au curseur du lecteur, et les
 * redemander au modèle serait payer pour s'entendre dire ce que le graphe sait
 * déjà. Le décompte du bouton vient donc d'ici.
 */
export async function planSweepAction(): Promise<SweepPlan> {
  try {
    const session = await requireOwner()

    const provider = providerReads()
    if (!provider.reads) return { ok: false, error: provider.explain }

    return { ok: true, questions: await openQuestions(session.userId) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Lecture des questions impossible.',
    }
  }
}

export interface SweepStep {
  ok: boolean
  entityId?: string
  /** 'closed' | 'open' | 'already' | 'gone' — voir ClosingVerdict. */
  kind?: 'closed' | 'open' | 'already' | 'gone'
  /**
   * Vrai quand la question suivante n'a aucune raison d'échouer aussi.
   *
   * Le balayage est une boucle de soixante-dix appels, et toutes les pannes n'ont
   * pas la même portée. Un jeton refusé ou une allocation épuisée se
   * reproduiront à l'identique : les soixante-neuf appels restants ne feraient
   * que le confirmer plus lentement, et le balayage s'arrête. Un CLI qui meurt
   * sans un mot, un bac à sable repris, un modèle qui rend une réponse non
   * conforme au schéma n'engagent que la question qu'ils ont rencontrée — la
   * suivante repart intacte, et c'est ce que dit `false`.
   */
  fatal?: boolean
  /** Pourquoi elle reste ouverte, quand elle reste ouverte. */
  because?: 'no-scenes' | 'unanswered' | 'refused'
  /**
   * Le chapitre qui répond — **seulement s'il a été lu**.
   *
   * Null sur une question refermée signifie « plus loin que là où vous êtes »,
   * et non « on ne sait pas ». La page le dit ainsi.
   */
  chapter?: number | null
  /** Le résumé de la scène qui referme, masqué de la même façon. */
  summary?: string | null
  scenesRead?: number
  scenesDropped?: number
  costCents?: number
  error?: string
}

/**
 * Une question, un appel de modèle, un verdict.
 *
 * Compté sous `ask` et non sous `start_run` : c'est exactement une question
 * posée à un modèle sur les chapitres lus, ce que fait l'assistant, et soixante
 * par heure est la taille d'un rattrapage sans être celle d'une boucle. Compté
 * ici plutôt que dans l'action qui établit le plan, parce que c'est ici que la
 * dépense a lieu — un plan de deux cents questions ne coûte rien tant que
 * personne ne les pose.
 */
export async function sweepQuestionAction(entityId: string): Promise<SweepStep> {
  try {
    const session = await requireOwner()

    const provider = providerReads()
    if (!provider.reads) return { ok: false, error: provider.explain }

    const allowance = await consume(session.userId, 'ask')
    if (!allowance.allowed) {
      return {
        ok: false,
        entityId,
        // Une limite horaire ne se rouvre pas à la question d'après.
        fatal: true,
        error:
          `Limite atteinte après ${allowance.max} question(s). Réessayez dans ` +
          `${allowance.retryInMinutes} minute(s). ${allowance.explain}`,
      }
    }

    const verdict = await closeIfAnswered(session.userId, entityId)

    if (verdict.kind === 'closed') {
      revalidatePath('/mysteres')
      revalidatePath(`/entite/${entityId}`)
      revalidatePath('/graph')

      const tellable = tellableResolution(verdict.chapter, session.boundaryChapter)

      return {
        ok: true,
        entityId,
        kind: 'closed',
        chapter: tellable,
        summary: tellable === null ? null : verdict.summary,
        scenesRead: verdict.scenesRead,
        scenesDropped: verdict.scenesDropped,
        costCents: verdict.costCents,
      }
    }

    if (verdict.kind === 'open') {
      return {
        ok: true,
        entityId,
        kind: 'open',
        because: verdict.because,
        scenesRead: verdict.scenesRead,
        scenesDropped: verdict.scenesDropped,
        costCents: verdict.costCents,
      }
    }

    if (verdict.kind === 'already') {
      return {
        ok: true,
        entityId,
        kind: 'already',
        chapter: tellableResolution(verdict.chapter, session.boundaryChapter),
      }
    }

    return { ok: true, entityId, kind: 'gone' }
  } catch (error) {
    return {
      ok: false,
      entityId,
      fatal: condemnsTheRest(error),
      error: error instanceof Error ? error.message : 'Vérification impossible.',
    }
  }
}

/**
 * Cette panne emporte-t-elle aussi les questions qu'on n'a pas encore posées ?
 *
 * Trois genres seulement, et ce sont les trois qui décrivent l'accès plutôt que
 * la requête : un jeton que Claude refuse, une allocation épuisée, et un
 * hébergeur qui refuse de fournir la machine sur laquelle Claude devait
 * tourner. Tout le reste — le bac à sable repris, le CLI disparu, la réponse
 * hors schéma — est une panne de cet appel-là. Se tromper ici du côté « fatal »
 * perd le travail restant ; s'en tromper de l'autre côté coûte quelques appels
 * que la boucle arrête d'elle-même après trois échecs de suite. Le doute penche
 * donc vers « continuer ».
 *
 * `billing` a rejoint la liste par l'observation : une allocation Sandbox
 * épuisée est aussi définitive qu'un quota Claude, et la faire découvrir trois
 * fois de suite ne fait que répéter le même paragraphe à quelqu'un qui l'a
 * déjà lu.
 */
function condemnsTheRest(error: unknown): boolean {
  return (
    error instanceof ClaudeAgentError &&
    (error.kind === 'auth' || error.kind === 'quota' || error.kind === 'billing')
  )
}
