/**
 * Comparer ce qu'une question affiche avec la première scène qui y répond
 * vraiment.
 *
 * `mystery-closing.ts` referme une question *ouverte* : il lit les scènes
 * postérieures, trouve celle qui répond, écrit la relation et la date. Il ne
 * revient jamais sur une question déjà refermée — `resolved_in_chapter IS NULL`
 * est son premier filtre —, et c'est précisément là que se cachent les défauts
 * que le Mode histoire montre :
 *
 *   une question refermée au chapitre 197 alors que le 113 y répondait déjà,
 *   parce que le balayage a lu les fenêtres dans un ordre qui datait tard, ou
 *   parce qu'un humain a accepté la seconde carte avant la première ;
 *
 *   une question laissée ouverte alors que la réponse est publiée depuis
 *   quatre-vingts chapitres, parce que la passe qui aurait dû la lire est
 *   morte au milieu ;
 *
 *   une réponse rattachée à une scène qui la redit plutôt qu'à celle qui la
 *   donne, ce qui déplace la date d'un chapitre et met le fil en désordre.
 *
 * Ce module est la moitié qui décide, et il ne sait ni lire une base ni appeler
 * un modèle. Ce qu'il reçoit est ce que `resolvingScene` a désigné — une scène
 * fournie, jamais un numéro que le modèle aurait choisi — et ce qu'il rend est
 * un constat, jamais une écriture.
 *
 * En cas de doute, rien. Une question dont la lecture ne désigne aucune scène
 * ne produit aucun constat : « le modèle n'a pas trouvé » n'est pas « il n'y a
 * pas de réponse », et un constat écrit là-dessus reprocherait une lecture
 * incomplète à une bibliothèque juste.
 */
import type { AuditFinding } from './audit.ts'
import type { Scene } from './mystery-sweep.ts'

/** Une question, avec ce que ses relations acceptées en disent. */
export interface MysteryUnderReview {
  entityId: string
  question: string
  openedInChapter: number
  state: string
  resolvedInChapter: number | null
  resolutions: Array<{ assertionId: string; sceneEntityId: string; chapter: number }>
}

/**
 * La consigne posée avec la question.
 *
 * La question de l'œuvre telle qu'elle est écrite, puis ce que le modèle a le
 * droit d'en faire. Le point qui compte est le dernier : il cite une scène
 * parmi celles qui lui sont données, et rien d'autre. Le chapitre est lu dans
 * le graphe par `resolvingScene` — une résolution datée par le modèle serait un
 * spoiler avec une note de bas de page, et c'est exactement le défaut que cette
 * page existe pour trouver.
 */
export function resolutionQuestion(question: string, openedInChapter: number): string {
  return (
    `${question}\n\n` +
    `Cette question est restée en suspens au chapitre ${openedInChapter}. Les ` +
    `scènes ci-dessous viennent des chapitres suivants. Laquelle y répond — ` +
    `c'est-à-dire laquelle dit ce que la question demandait, et non laquelle en ` +
    `reparle ?\n\n` +
    `Citez la scène par son identifiant, tel qu'il vous est donné. Si plusieurs ` +
    `y répondent, citez la première. N'indiquez aucun numéro de chapitre : la ` +
    `scène porte sa date. Si aucune de ces scènes ne répond, répondez ` +
    `« insufficient_data » : une scène qui évoque le sujet n'est pas une réponse.`
  )
}

/**
 * Ce que les relations acceptées disent réellement de cette question.
 *
 * Les résolutions absurdes sont écartées avant tout calcul : une scène qui est
 * la question elle-même, une scène du chapitre qui a posé la question. Les
 * règles gratuites en font des constats à part ; ici elles sont simplement
 * mises de côté, pour qu'une relation aberrante ne fasse pas croire qu'une
 * question est bien datée.
 */
export function soundResolutions(
  mystery: MysteryUnderReview,
): MysteryUnderReview['resolutions'] {
  return mystery.resolutions.filter(
    (resolution) =>
      resolution.sceneEntityId !== mystery.entityId &&
      resolution.chapter > mystery.openedInChapter,
  )
}

/**
 * Ce qu'une lecture de toute l'histoire reproche à une question.
 *
 * Trois constats possibles, exclusifs, dans l'ordre où ils comptent :
 *
 *   **Ouverte alors que la réponse existe.** Aucune relation ne la referme, et
 *   une scène publiée y répond. Le correctif écrit la relation — verrouillée,
 *   à votre parole — puis recalcule l'état depuis les relations acceptées.
 *
 *   **Refermée trop tard.** La première réponse acceptée est postérieure à la
 *   scène que la lecture désigne. Le correctif ajoute la vraie ; il n'en retire
 *   aucune, parce qu'une question peut recevoir plusieurs réponses et que c'est
 *   la plus ancienne qui fait la date — le recalcul s'en charge.
 *
 *   **Rattachée à la mauvaise scène.** Même chapitre, autre scène. Aucun
 *   correctif : deux scènes du même chapitre peuvent toutes deux répondre, la
 *   date ne bougerait pas, et ce qui se joue est le lien que la fiche affiche.
 *   C'est un jugement, et il se prend devant les deux phrases.
 *
 * Et un silence : quand la scène désignée est postérieure à la réponse déjà
 * écrite, la bibliothèque avait raison et la lecture a trouvé un rappel.
 */
export function mysteryFindings(input: {
  mystery: MysteryUnderReview
  /** La scène désignée par la lecture, ou rien si elle n'a rien désigné. */
  answering: Scene | null
}): AuditFinding[] {
  const { mystery, answering } = input
  if (answering === null) return []
  if (answering.chapter <= mystery.openedInChapter) return []

  const sound = soundResolutions(mystery)

  if (sound.length === 0) {
    return [
      {
        kind: 'mystere_sans_resolution_ecrite',
        chapter: answering.chapter,
        title: `« ${mystery.question} » : la réponse est publiée depuis le chapitre ${answering.chapter}`,
        detail:
          `La question est ouverte depuis le chapitre ${mystery.openedInChapter} et ` +
          `aucune relation ne la referme, alors qu'une scène y répond :\n\n` +
          `« ${answering.summary} » (chapitre ${answering.chapter})\n\n` +
          `Le correctif écrit « résout le mystère » de cette scène vers la question, ` +
          `verrouillée à votre parole, puis recalcule l'état depuis les relations ` +
          `acceptées.`,
        subjectEntityId: mystery.entityId,
        objectEntityId: answering.entityId,
        fix: {
          action: 'publier_resolution',
          mysteryEntityId: mystery.entityId,
          sceneEntityId: answering.entityId,
          chapter: answering.chapter,
        },
        fingerprint: `mystere_sans_resolution_ecrite|${mystery.entityId}|${answering.entityId}`,
      },
    ]
  }

  const earliest = Math.min(...sound.map((resolution) => resolution.chapter))

  if (answering.chapter < earliest) {
    return [
      {
        kind: 'mystere_resolu_trop_tard',
        chapter: answering.chapter,
        title: `« ${mystery.question} » est refermée au ${earliest}, répondue au ${answering.chapter}`,
        detail:
          `La bibliothèque date la réponse du chapitre ${earliest}` +
          (mystery.resolvedInChapter !== null && mystery.resolvedInChapter !== earliest
            ? ` (et l'affiche au ${mystery.resolvedInChapter})`
            : '') +
          `. La lecture trouve une scène qui y répond ${earliest - answering.chapter} ` +
          `chapitre(s) plus tôt :\n\n` +
          `« ${answering.summary} » (chapitre ${answering.chapter})\n\n` +
          `Le lecteur a donc su au ${answering.chapter}, et le fil lui fait la ` +
          `révélation au ${earliest}. Le correctif ajoute la vraie réponse ; il n'en ` +
          `retire aucune, la date étant celle de la plus ancienne.`,
        subjectEntityId: mystery.entityId,
        objectEntityId: answering.entityId,
        fix: {
          action: 'publier_resolution',
          mysteryEntityId: mystery.entityId,
          sceneEntityId: answering.entityId,
          chapter: answering.chapter,
        },
        fingerprint: `mystere_resolu_trop_tard|${mystery.entityId}|${answering.entityId}`,
      },
    ]
  }

  if (answering.chapter > earliest) return []

  const recorded = sound.filter((resolution) => resolution.chapter === earliest)
  if (recorded.some((resolution) => resolution.sceneEntityId === answering.entityId)) return []

  return [
    {
      kind: 'mystere_mauvaise_scene',
      chapter: answering.chapter,
      title: `« ${mystery.question} » : la scène qui referme n'est pas celle qui répond`,
      detail:
        `La question est rattachée à une autre scène du chapitre ${earliest}. La ` +
        `lecture désigne celle-ci :\n\n` +
        `« ${answering.summary} »\n\n` +
        `La date ne change pas ; ce qui change est la scène que la fiche montre ` +
        `comme réponse. Deux scènes d'un même chapitre peuvent y répondre toutes ` +
        `les deux : le lien se choisit devant les deux phrases, sur la fiche.`,
      subjectEntityId: mystery.entityId,
      objectEntityId: answering.entityId,
      fix: null,
      fingerprint: `mystere_mauvaise_scene|${mystery.entityId}|${answering.entityId}`,
    },
  ]
}

/**
 * L'empreinte de ce qui a été donné à lire sur une question.
 *
 * La question, sa date d'ouverture, ce que ses relations en disent, et la liste
 * des scènes soumises. Publier un chapitre ajoute des scènes et redonne la
 * question à lire ; accepter une résolution la redonne à lire aussi, parce que
 * le verdict porte sur la comparaison. Relancer la page ne change rien.
 */
export function mysteryInputs(
  mystery: MysteryUnderReview,
  scenes: readonly Scene[],
): string[] {
  return [
    mystery.entityId,
    mystery.question,
    String(mystery.openedInChapter),
    `${mystery.state}@${mystery.resolvedInChapter ?? '-'}`,
    ...mystery.resolutions
      .map((resolution) => `${resolution.sceneEntityId}@${resolution.chapter}`)
      .sort(),
    ...scenes.map((scene) => `${scene.entityId}@${scene.chapter}`),
  ]
}
