'use server'

import { revalidatePath } from 'next/cache'
import { requireOwner } from '@/domains/auth/session.ts'
import { consume } from '@/domains/observability/rate-limit.ts'
import {
  applyFinding,
  forgetReadings,
  ignoreFinding,
  readStoryWithModel,
  sweepStory,
  type RelectureReport,
  type SweepReport,
} from '@/domains/review/audit-run.ts'

/**
 * Ce que la page d'analyse a le droit de demander au serveur.
 *
 * Chaque action revérifie qui appelle. Une action de serveur est une route POST
 * atteignable sans passer par le bouton qui l'a offerte, et l'identifiant d'un
 * constat qui arrive du navigateur ne prouve rien — c'est `applyFinding` qui
 * relit le constat en base, et `requireOwner` qui dit à qui il appartient.
 */

export interface SweepActionResult {
  ok: boolean
  report?: SweepReport
  error?: string
}

/**
 * Passer toute la bibliothèque sous les règles.
 *
 * Sans limite de débit, à la différence de la relecture : aucune ligne ne quitte
 * la machine, rien n'est facturé, et le seul coût est quelques requêtes sur la
 * base du lecteur. Un bouton qu'on peut cliquer deux fois de suite est ce qu'il
 * faut ici — on corrige, on relance, et la liste raccourcit.
 */
export async function sweepStoryAction(): Promise<SweepActionResult> {
  try {
    const session = await requireOwner()
    const report = await sweepStory(session.userId, session.workId)

    revalidatePath('/admin/analyse')
    revalidatePath('/admin/chapitres')

    return { ok: true, report }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Analyse impossible.',
    }
  }
}

export interface FindingActionResult {
  ok: boolean
  message?: string
  error?: string
}

export async function applyFindingAction(findingId: string): Promise<FindingActionResult> {
  try {
    const session = await requireOwner()
    const result = await applyFinding(session.userId, findingId)

    if (result.ok) {
      // Une correction touche le fil, le graphe et les fiches : tout ce qui lit
      // la connaissance doit être refait, pas seulement cette page.
      revalidatePath('/admin/analyse')
      revalidatePath('/histoire')
      revalidatePath('/graph')
      revalidatePath('/chronologie')
    }

    return result.ok
      ? { ok: true, message: result.message }
      : { ok: false, error: result.message }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Correction impossible.',
    }
  }
}

export async function ignoreFindingAction(findingId: string): Promise<FindingActionResult> {
  try {
    const session = await requireOwner()
    const done = await ignoreFinding(session.userId, findingId)
    if (done) revalidatePath('/admin/analyse')
    return done
      ? { ok: true, message: 'Écarté. Un prochain balayage ne le reproposera pas.' }
      : { ok: false, error: 'Constat introuvable ou déjà tranché.' }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Impossible d’écarter ce constat.',
    }
  }
}

export interface RelectureActionResult {
  ok: boolean
  report?: RelectureReport
  error?: string
}

/**
 * Combien de chapitres une seule demande relit.
 *
 * Un appel par chapitre, et une action de serveur a un plafond de durée : au-delà
 * d'une poignée, la réponse meurt en emportant les appels déjà payés. Le
 * navigateur redemande, ce qui est aussi ce qui rend la progression visible et
 * l'arrêt possible entre deux paquets.
 */
const MAX_BATCH = 8

/** Et combien de chapitres ratés une passe peut mettre de côté avant de renoncer. */
const MAX_SKIPPED = 500

/**
 * Relire un paquet de chapitres.
 *
 * Limitée sous « ask » parce que c'est la même dépense : une question posée à un
 * modèle avec un contexte. Comptée par demande et non par chapitre — un paquet
 * est un geste, et ce que la limite doit arrêter est une boucle, pas une
 * relecture qui avance.
 */
export async function relireAction(
  batch = 4,
  /** Les chapitres que cette passe a déjà ratés. Voir `readStoryWithModel`. */
  skip: number[] = [],
): Promise<RelectureActionResult> {
  try {
    const session = await requireOwner()

    const allowance = await consume(session.userId, 'ask')
    if (!allowance.allowed) {
      return {
        ok: false,
        error:
          `Limite atteinte. Réessayez dans ${allowance.retryInMinutes} minute(s). ` +
          allowance.explain,
      }
    }

    const size = Number.isFinite(batch) ? Math.min(MAX_BATCH, Math.max(1, Math.floor(batch))) : 4

    /*
     * Les arguments viennent du navigateur, y compris celui-ci.
     *
     * Il ne sert qu'à *retirer* des chapitres de la passe, donc le pire qu'une
     * valeur inventée puisse faire est d'en sauter — pas d'en lire un qui ne
     * serait pas à lire. Il est quand même filtré et borné : un tableau de
     * cinquante mille entrées traverserait le réseau et finirait dans un `IN`.
     */
    const setAside = (Array.isArray(skip) ? skip : [])
      .filter((chapter) => Number.isInteger(chapter) && chapter > 0)
      .slice(0, MAX_SKIPPED)

    const report = await readStoryWithModel(session.userId, session.workId, size, setAside)

    if (report.found > 0 || report.read > 0) revalidatePath('/admin/analyse')

    return report.error ? { ok: false, error: report.error } : { ok: true, report }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Relecture impossible.',
    }
  }
}

export interface ForgetActionResult {
  ok: boolean
  forgotten?: number
  error?: string
}

/** Tout relire à nouveau — et donc tout repayer. Le seul geste qui efface. */
export async function forgetReadingsAction(): Promise<ForgetActionResult> {
  try {
    const session = await requireOwner()
    const forgotten = await forgetReadings(session.userId, session.workId)
    revalidatePath('/admin/analyse')
    return { ok: true, forgotten }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Remise à zéro impossible.',
    }
  }
}
