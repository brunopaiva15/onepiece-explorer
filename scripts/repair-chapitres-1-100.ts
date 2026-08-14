/**
 * Les corrections relevées à la relecture des chapitres 1 à 100.
 *
 *   pnpm repair:chapitres-1-100 -- --dry-run     # dit tout, n'écrit rien
 *   pnpm repair:chapitres-1-100                  # applique
 *   TEST_DB=1 pnpm repair:chapitres-1-100        # base de test
 *
 * La suite de `repair:chapitres-1-42`, sur les six arcs que la relecture couvre
 * — Romance Dawn, Orange Town, Syrup Village, Baratie, Arlong Park, Loguetown.
 * Les bornes d'arcs et la numérotation sont justes ; ce qui ne l'est pas se
 * range en huit sortes, et elles ne sont pas de même nature :
 *
 *   1. Deux nœuds pour une personne ou pour un lieu. « Second majordome de
 *      Kaya » est Merry, « Homme aux yeux rouges » est Mihawk, « Fille au sabre
 *      ressemblant à Kuina » est Tashigi, « Personnage mystérieux de Logue
 *      Town » est Dragon, et les deux plates-formes d'exécution de Loguetown
 *      sont la même estrade.
 *
 *   2. Ce qu'un nom est, une fois la fusion faite. C'est indissociable de la
 *      première : replier deux nœuds met leurs libellés dans la même
 *      composante, et la fiche affiche le mieux classé. Sans la section 2, la
 *      section 1 remplacerait « Dracule Mihawk » par « Homme aux yeux rouges ».
 *
 *   3. Un nom écrit de deux façons. Le bateau de Sanji est « Hobbit » dans une
 *      entité et « Orbite » dans un événement ; le monstre marin est « Momoo »
 *      et « Meuh-Meuh » d'un chapitre à l'autre.
 *
 *   4. Un résumé qui dit autre chose que le chapitre. « Zeff a caché toute la
 *      nourriture pour lui » dit l'inverse de ce que le chapitre 58 révèle ;
 *      « Nami récupère son chapeau » donne le chapeau de paille à Nami ; « Le
 *      Chapitre de paille quitte Logue Town » est une coquille sur l'équipage.
 *
 *   5. La même scène écrite deux fois. Le bouclier humain du chapitre 5, la
 *      mouche du 43, la seconde chute de Krieg au 63, son armure racontée au 65
 *      puis au 66, l'exécution de Bell-mère au 78.
 *
 *   6. Une scène rangée dans le mauvais chapitre. Le vol de Nezumi appartient
 *      au 80, le désespoir de Nami au 81.
 *
 *   7. Une entrée en scène datée d'après. Hatchan, Kuroobi et Chew sont sur la
 *      page dès le 69 ; Baggy entre en scène au 9 et son retour au 98 était lu
 *      comme une première apparition.
 *
 *   8. Une question refermée par la mauvaise scène — ou pas refermée du tout.
 *      Huit liens à déplacer ou à défaire, et un à écrire : l'homme que Zoro
 *      cherche depuis le chapitre 8 est nommé aux chapitres 49–50.
 *
 * Rien n'est supprimé. Une scène ou une entité en double est rejointe à sa
 * jumelle par une relation d'identité datée du chapitre — le mécanisme que le
 * dépôt emploie déjà pour les fusions — et reste donc lisible et défaisable. Un
 * lien de résolution fautif est rejeté, pas effacé : les assertions sont en
 * ajout seul et `review_status` est l'un des deux champs qu'elles laissent
 * changer.
 *
 * Rejouable. Chaque opération vérifie d'abord si elle a déjà eu lieu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ce que ce script ne peut pas savoir, et comment il le dit.
 *
 * Les corrections désignent des scènes par des *mots*, pas par des
 * identifiants — comme les deux relectures précédentes, et pour la même raison :
 * un identifiant est propre à une bibliothèque et rend le script invérifiable
 * ailleurs, tandis qu'un mot se relit contre le manga. Mais la relecture qui a
 * produit cette liste décrit les scènes ; elle ne les cite pas mot pour mot, et
 * l'export sur lequel elle porte était incomplet — cent cinquante-six
 * événements manquaient. Les mots choisis ici sont donc les plus improbables à
 * manquer (des noms propres, « tatouage », « mouche », « MH5 »), et rien de
 * plus.
 *
 * D'où le dry-run, et d'où la forme de la sortie. Une désignation qui ne trouve
 * rien dit « introuvable » ; une qui trouve plusieurs scènes les imprime toutes
 * et ne touche à aucune. Aucune correction n'est appliquée sur un à-peu-près :
 * lancez d'abord `--dry-run`, lisez la liste, et resserrez les mots des lignes
 * qui n'ont pas trouvé leur scène. C'est le mode par défaut du bouton
 * `repair.yml` pour exactement cette raison.
 *
 * `--conditions=react-server` dans le script pnpm n'est pas décoratif : les
 * modules qui lisent la connaissance sont marqués `server-only`, et ce drapeau
 * est ce qui résout le marqueur hors de Next.
 */
import '../src/lib/load-env.ts'
import postgres from 'postgres'
import { normalizeText } from '../src/domains/knowledge/normalize.ts'
import { tokenOverlap } from '../src/domains/resolution/scoring.ts'

const dryRun = process.argv.includes('--dry-run')
const testDb = process.env.TEST_DB === '1'
const url = testDb
  ? (process.env.TEST_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test')
  : (process.env.DIRECT_URL ?? '')

if (!url) {
  console.error(
    'Aucune connexion. Lancez avec TEST_DB=1 pour la base locale, ou renseignez DIRECT_URL.',
  )
  process.exit(1)
}

/** Le premier chapitre que les deux relectures précédentes n'ont pas balayé. */
const ECHO_FROM = 43
const ECHO_TO = 100

/** Le rang sous lequel un libellé existe pour la recherche et ne s'affiche pas. */
const SEARCH_ONLY_PRECEDENCE = 5

/**
 * Deux nœuds pour une personne ou pour un lieu.
 *
 * `keep` est le nœud que le lecteur rencontre en premier, et l'ordre n'est pas
 * cosmétique : replier consiste à *rejeter* l'autre, et rejeter le plus ancien
 * ferait disparaître la personne des chapitres où elle est déjà là. Mihawk est
 * nommé au 48 et « Homme aux yeux rouges » apparaît au 49, donc c'est Mihawk
 * qu'on garde ; la silhouette du 96 précède Tashigi du 97, donc c'est la
 * silhouette qu'on garde. Le script vérifie l'ordre et l'inverse en le disant
 * plutôt que de faire confiance à cette table : une bibliothèque peut avoir
 * daté ses nœuds autrement.
 *
 * Ce que la fiche *affiche* ne se décide pas ici mais dans `RECLASSEMENTS` —
 * c'est la précédence des libellés qui en décide, et elle est indépendante du
 * sens de la fusion.
 */
const FUSIONS: ReadonlyArray<{ keep: string; drop: string; chapter: number; why: string }> = [
  {
    keep: 'Merry',
    drop: 'Second majordome de Kaya',
    chapter: 27,
    why: 'le majordome de Kaya est entré en scène au 24',
  },
  {
    keep: 'Dracule Mihawk',
    drop: 'Homme aux yeux rouges',
    chapter: 49,
    why: 'Mihawk est nommé au 48',
  },
  {
    keep: 'Orbite',
    drop: 'Hobbit',
    chapter: 56,
    why: 'un seul bateau, deux graphies',
  },
  {
    keep: 'Meuh-Meuh',
    drop: 'Momoo',
    chapter: 73,
    why: 'un seul monstre marin, deux noms',
  },
  {
    keep: 'Fille au sabre ressemblant à Kuina',
    drop: 'Tashigi',
    chapter: 97,
    why: 'la silhouette du 96 est nommée au 97',
  },
  {
    keep: 'Plate-forme d’exécution de Roger',
    drop: 'Plateforme d’exécution de Loguetown',
    chapter: 99,
    why: 'une seule estrade',
  },
  {
    keep: 'Personnage mystérieux de Logue Town',
    drop: 'Dragon',
    chapter: 100,
    why: 'Smoker le nomme dans le chapitre même',
  },
]

/**
 * Ce qu'un nom est, une fois la fusion faite.
 *
 * Sans cette section, la précédente se retourne contre elle-même : les libellés
 * d'une composante se disputent l'affichage au rang, et « Homme aux yeux
 * rouges » — enregistré comme un vrai nom au chapitre 49 — battrait « Dracule
 * Mihawk » révélé au 48. La fusion aurait donc pour effet visible de remplacer
 * le nom par la description.
 *
 * La date ne bouge pas, jamais. Le lecteur a bien lu « Homme aux yeux rouges »
 * au chapitre 49 ; la déplacer ouvrirait dans le curseur un chapitre où
 * personne n'a de nom. Seuls la nature du libellé et son rang changent — ce qui
 * décide s'il s'affiche, pas s'il est connu. C'est aussi ce qui produit la
 * « révélation de nom » que la relecture demande : la description au chapitre
 * où elle est lue, le nom au chapitre où il est donné, et le curseur qui passe
 * de l'une à l'autre tout seul.
 *
 * Deux rangs, deux intentions. `placeholder` (10) reste affichable tant qu'il
 * est seul — c'est ce qu'il faut pour une silhouette qui n'a pas encore de nom.
 * `SEARCH_ONLY` (5) ne s'affiche jamais : c'est le rang des graphies qu'on garde
 * uniquement pour que la recherche et les catalogues d'illustrations retrouvent
 * le nœud, et c'est là que vont « Hobbit » et « Momoo », qui ne sont pas des
 * descriptions mais des variantes fautives.
 */
const RECLASSEMENTS: ReadonlyArray<{
  label: string
  kind: string
  precedence: number
  why: string
}> = [
  {
    label: 'Second majordome de Kaya',
    kind: 'placeholder',
    precedence: 10,
    why: 'une description, pas un second majordome',
  },
  {
    label: 'Homme aux yeux rouges',
    kind: 'placeholder',
    precedence: 10,
    why: 'la description du 49, avant le nom du 48',
  },
  {
    label: 'Fille au sabre ressemblant à Kuina',
    kind: 'placeholder',
    precedence: 10,
    why: 'la silhouette du 96, que le 97 nomme Tashigi',
  },
  {
    label: 'Personnage mystérieux de Logue Town',
    kind: 'placeholder',
    precedence: 10,
    why: 'la silhouette du 100, que Smoker nomme Dragon',
  },
  {
    label: 'Plateforme d’exécution de Loguetown',
    kind: 'alias',
    precedence: 50,
    why: 'l’autre façon de désigner l’estrade du 97',
  },
  {
    label: 'Hobbit',
    kind: 'alias',
    precedence: SEARCH_ONLY_PRECEDENCE,
    why: 'graphie fautive d’« Orbite »',
  },
  {
    label: 'Momoo',
    kind: 'alias',
    precedence: SEARCH_ONLY_PRECEDENCE,
    why: 'graphie fautive de « Meuh-Meuh »',
  },
]

/**
 * Un mot pour un autre, dans la prose des résumés et des questions.
 *
 * Les deux tables, parce que la relecture des chapitres 1 à 42 ne lisait que
 * les résumés et que « Kuro » a survécu dans les questions pendant deux
 * chapitres. Le mot entier, jamais un fragment : `\y` est la limite de mot de
 * PostgreSQL et `\b` celle de JavaScript, donc la sélection et le remplacement
 * disent la même chose.
 *
 * « Second majordome de Kaya » est ici pour la raison que la relecture donne :
 * la question sur sa survie doit nommer Merry, faute de quoi la fiche de Merry
 * porte une question qui parle de quelqu'un d'autre.
 */
const TERMES: ReadonlyArray<{ from: string; to: string; why: string }> = [
  { from: 'Hobbit', to: 'Orbite', why: 'le bateau de Sanji s’appelle Orbite' },
  { from: 'Momoo', to: 'Meuh-Meuh', why: 'un seul nom pour le monstre marin' },
  {
    from: 'Second majordome de Kaya',
    to: 'Merry',
    why: 'la question sur sa survie doit le nommer',
  },
]

/**
 * Un résumé qui dit autre chose que le chapitre.
 *
 * `terms` désigne la scène : tous les mots doivent s'y trouver, comparés sans
 * accents ni casse ni apostrophes. Un mot plutôt qu'une phrase entière, parce
 * qu'une phrase citée de mémoire ne trouve rien et qu'un mot improbable — « MH5 »,
 * « tatouage » — désigne aussi bien. Si la désignation trouve deux scènes, le
 * script les imprime et n'en réécrit aucune.
 */
const RÉSUMÉS: ReadonlyArray<{ chapter: number; terms: string[]; to: string; why: string }> = [
  {
    chapter: 58,
    terms: ['caché', 'nourriture'],
    why: 'Zeff n’a rien caché : il a tout donné',
    to:
      'Sanji découvre que Zeff lui avait donné toute la nourriture disponible. ' +
      'Le sac que Zeff avait gardé ne contenait que des trésors, et celui-ci a ' +
      'survécu en mangeant sa propre jambe.',
  },
  {
    chapter: 60,
    terms: ['MH5'],
    why: 'Krieg ne tire pas un MH5 qui se change en shuriken',
    to:
      'Don Krieg fait croire qu’il va utiliser le MH5 contre Luffy, mais le ' +
      'projectile se révèle être une bombe-shuriken et non une bombe empoisonnée.',
  },
  {
    chapter: 74,
    terms: ['Yosaku', 'Meuh-Meuh'],
    why: 'Zoro n’est pas porté par Meuh-Meuh',
    to:
      'Luffy, Sanji et Yosaku arrivent près d’Arlong Park après avoir été ' +
      'transportés par Meuh-Meuh, tandis que Zoro rejoint les autres séparément.',
  },
  {
    chapter: 88,
    terms: ['Usopp', 'Chew'],
    why: 'la victoire sur Chew appartient au 87 ; le 88 est le retour d’Usopp',
    to:
      'Usopp revient à Arlong Park après sa victoire et attaque Arlong pour ' +
      'aider ses compagnons.',
  },
  {
    chapter: 91,
    terms: ['dents'],
    why: 'les dents brisées appartiennent au 90 ; le 91 est la suite du combat',
    to:
      'Le combat reprend : Arlong se sert des dents arrachées lors de l’échange ' +
      'précédent, puis attaque Luffy depuis l’eau.',
  },
  {
    chapter: 94,
    terms: ['chapeau'],
    why: 'le chapeau de paille n’a jamais été celui de Nami',
    to:
      'Nami rend son chapeau de paille à Luffy et récupère l’argent confisqué ' +
      'par Nezumi.',
  },
  {
    chapter: 95,
    terms: ['villageois'],
    why: 'Nami ne rend pas l’argent volé : elle laisse le sien et vole le leur',
    to:
      'Nami laisse ses économies aux villageois avant son départ, puis leur vole ' +
      'leurs portefeuilles en courant vers le Vogue Merry, en guise d’adieu.',
  },
  {
    chapter: 100,
    terms: ['Chapitre de paille'],
    why: 'coquille : c’est l’équipage, pas le chapitre',
    to:
      'L’Équipage du Chapeau de paille quitte Logue Town et aperçoit le phare ' +
      'marquant l’entrée de Grand Line. Les membres renouvellent ensuite leurs ' +
      'rêves avant d’entamer cette nouvelle étape.',
  },
]

/**
 * Deux fois la même scène, quand les deux versions se ressemblent.
 *
 * Retrouvées comme la publication les retrouverait : parmi les scènes des
 * chapitres visés qui contiennent tous les mots, le script prend la paire la
 * plus ressemblante au sens de `tokenOverlap` — la mesure sur laquelle
 * `echoes.ts` a réglé ses deux seuils — et refuse d'agir si même la meilleure
 * paire reste sous `ECHO_WORTH_SHOWING`. C'est ce qui permet d'écrire des mots
 * larges (« Krieg ») sans risquer de replier deux scènes voisines mais
 * distinctes : les mots désignent le voisinage, la ressemblance tranche.
 *
 * `keep` dit laquelle des deux survit. « la plus longue » quand la relecture
 * demande de garder le récit détaillé, « la première » quand elle demande de
 * garder le chapitre d'origine et de retirer la répétition du suivant.
 */
const DOUBLONS: ReadonlyArray<{
  chapters: number[]
  terms: string[]
  keep: 'la plus longue' | 'la première'
  why: string
}> = [
  {
    chapters: [5],
    terms: ['Hermep', 'bouclier'],
    keep: 'la plus longue',
    why: 'le bouclier humain, raconté deux fois',
  },
  {
    chapters: [43],
    terms: ['mouche'],
    keep: 'la plus longue',
    why: 'la mouche de Fullbody, racontée deux fois',
  },
  {
    chapters: [65, 66],
    terms: ['armure'],
    keep: 'la première',
    why: 'l’armure de Krieg détruite au 65, répétée au 66',
  },
  {
    chapters: [78],
    terms: ['Bell-mère'],
    keep: 'la plus longue',
    why: 'l’exécution de Bell-mère, racontée deux fois de suite',
  },
]

/**
 * Deux fois la même scène, quand les deux versions **ne** se ressemblent pas.
 *
 * La seconde chute de Krieg est racontée une fois en gros, une fois en détail :
 * deux récits du même geste, rédigés séparément, qui ne partagent presque aucun
 * mot. Aucun seuil de ressemblance ne les rapproche sans rapprocher aussi deux
 * scènes voisines mais distinctes — ce qui est la faute que ce script répare,
 * dans l'autre sens. Donc à la main et nommément, comme la relecture des 1–42 a
 * dû le faire pour ses quatre paires.
 *
 * Chaque côté doit désigner exactement une scène. Deux, et le script les
 * imprime et ne replie rien : replier au hasard serait pire que ne rien faire.
 */
const SCÈNES_NOMMÉES: ReadonlyArray<{
  keep: { chapter: number; terms: string[] }
  drop: { chapter: number; terms: string[] }
  why: string
}> = [
  {
    keep: { chapter: 63, terms: ['canon'] },
    drop: { chapter: 63, terms: ['seconde'] },
    why: 'la seconde chute de Krieg : garder le récit détaillé, replier le résumé',
  },
]

/**
 * Une scène rangée dans le mauvais chapitre.
 *
 * Trois écritures pour un déplacement, et les trois sont nécessaires : la ligne
 * `events` que lit le fil, le `first_seen_chapter` du nœud que lit la frontière,
 * et le `revealed_in_chapter` du libellé — un événement se nomme par sa propre
 * phrase, et une phrase révélée au 81 est invisible au 80. En écrire deux sur
 * trois donne une scène qui change de chapitre et s'affiche « événement sans
 * nom ».
 */
const DÉPLACEMENTS: ReadonlyArray<{
  from: number
  to: number
  terms: string[]
  why: string
}> = [
  { from: 81, to: 80, terms: ['Nezumi', 'argent'], why: 'le vol de l’argent de Nami' },
  { from: 80, to: 81, terms: ['Nami', 'Arlong'], why: 'la confrontation de Nami avec Arlong' },
  { from: 80, to: 81, terms: ['tatouage'], why: 'les coups de dague sur le tatouage' },
  { from: 80, to: 81, terms: ['Luffy', 'aide'], why: 'la demande d’aide de Nami à Luffy' },
]

/**
 * Le chapitre où quelqu'un entre dans la case.
 *
 * Le fil décide de « entre en scène » sur deux choses : le `first_seen_chapter`
 * du nœud, et les occurrences déclarées. Les hommes-poissons d'Arlong sont sur
 * la page dès le 69 et le graphe les fait entrer au 73 ou au 75 ; Baggy entre en
 * scène au 9 et son retour au 98 était lu comme une première apparition, faute
 * d'une apparition déclarée avant.
 *
 * Le libellé suit le nœud, et c'est le point qui demande d'être dit. La
 * publication datait le nom et le corps du même chapitre — c'est le défaut que
 * `repair:chapitre-1` a nommé — donc un nom révélé au 73 pour un corps entré au
 * 73 n'est pas une révélation datée, c'est la même date écrite deux fois. Le
 * script ne déplace donc un libellé que lorsqu'il porte exactement l'ancienne
 * date d'entrée : un nom que la bibliothèque a daté *autrement* est une
 * révélation que quelqu'un a tranchée, et il n'y touche pas.
 *
 * Si un chapitre entre 69 et l'ancienne date est celui qui donne réellement le
 * nom, c'est le mécanisme de `repair:chapitre-1` qu'il faut : une description au
 * chapitre de l'entrée, le nom à sa date. Le dry-run imprime ce qu'il déplace,
 * ce qui est exactement ce qu'il faut pour le voir.
 */
const ENTRÉES: ReadonlyArray<{ labels: string[]; chapter: number; why: string }> = [
  { labels: ['Hatchan', 'Octo', 'Hachi'], chapter: 69, why: 'sur la page dès le 69' },
  { labels: ['Kuroobi', 'Kuroubi'], chapter: 69, why: 'sur la page dès le 69' },
  { labels: ['Chew', 'Chu'], chapter: 69, why: 'sur la page dès le 69' },
  {
    labels: ['Pirates d’Arlong', 'Équipage d’Arlong', 'Arlong Pirates'],
    chapter: 69,
    why: 'sur la page dès le 69',
  },
  {
    labels: ['Baggy'],
    chapter: 9,
    why: 'son apparition au 98 est un retour, pas une entrée',
  },
]

/**
 * Une question refermée par la mauvaise scène — ou pas refermée du tout.
 *
 * Trois gestes, et un seul mécanisme. Refermer une question, c'est une relation
 * « résout le mystère » d'une scène vers elle, plus l'état de la question :
 * `close-mysteries.ts` n'écrit rien d'autre, et défaire se fait donc en rejetant
 * la relation et en rouvrant la ligne.
 *
 *   * `answer: null` défait sans refaire — la réponse placée là n'avait aucun
 *     rapport (Chouchou), ou la question n'est pas encore tranchée (Yasopp).
 *     L'état revient à « open » et non à « reopened » : l'histoire n'a rien
 *     rouvert, c'est le lien qui était faux.
 *
 *   * `answer` renseigné déplace : la relation fautive est rejetée, et une
 *     nouvelle est écrite depuis une scène du bon chapitre. `chapters` est une
 *     liste parce que la relecture dit parfois « au 49 ou au 50 » ; le premier
 *     chapitre qui contient une scène désignée gagne.
 *
 *   * `wrong: null` écrit sans défaire : la question du chapitre 8 n'a jamais
 *     reçu de réponse.
 *
 * Si la scène du bon chapitre reste introuvable, la relation fautive est retirée
 * quand même et la question reste ouverte. C'est volontaire, et c'est le moindre
 * des deux maux : une question ouverte est un état honnête, une question
 * refermée par la mauvaise scène ne l'est pas. Une seconde exécution, une fois
 * les mots resserrés, écrira le lien manquant.
 */
const RÉPONSES: ReadonlyArray<{
  openedIn: number
  question: string[]
  wrong: number | null
  answer: { chapters: number[]; terms: string[] } | null
  why: string
}> = [
  {
    openedIn: 13,
    question: ['Chouchou'],
    wrong: 87,
    answer: null,
    why: 'la scène du 87 n’a aucun rapport avec l’animalerie',
  },
  {
    openedIn: 23,
    question: ['Kaya', 'navire'],
    wrong: 34,
    answer: { chapters: [41], terms: ['Merry'] },
    why: 'l’équipage n’obtient le Vogue Merry qu’au 41',
  },
  {
    openedIn: 25,
    question: ['Yasopp'],
    wrong: 41,
    answer: null,
    why: 'où est Yasopp reste sans réponse',
  },
  {
    openedIn: 25,
    question: ['Jango'],
    wrong: 37,
    answer: { chapters: [39], terms: ['Kuro'] },
    why: 'le complot n’est mis en échec qu’au 39',
  },
  {
    openedIn: 28,
    question: ['plan'],
    wrong: 33,
    answer: { chapters: [39], terms: ['Kuro'] },
    why: 'au 33 le combat et le plan continuent',
  },
  {
    openedIn: 31,
    question: ['sabres'],
    wrong: 32,
    answer: { chapters: [33], terms: ['sabres'] },
    why: 'Nami ne rend les sabres qu’au 33',
  },
  {
    openedIn: 56,
    question: ['Zeff'],
    wrong: 57,
    answer: { chapters: [58], terms: ['jambe'] },
    why: 'la vérité sur la nourriture et la jambe est au 58',
  },
  {
    openedIn: 75,
    question: ['Arlong'],
    wrong: 79,
    answer: { chapters: [81], terms: ['Arlong'] },
    why: 'la trahison d’Arlong n’est révélée qu’aux 80–81',
  },
  {
    openedIn: 8,
    question: ['Zoro'],
    wrong: null,
    answer: { chapters: [49, 50], terms: ['Mihawk'] },
    why: 'l’homme que Zoro cherche est nommé aux 49–50',
  },
]

const NOTE =
  'Relecture des chapitres 1 à 100 : correction saisie à la main, ' +
  'voir scripts/repair-chapitres-1-100.ts.'

interface Work {
  id: string
  user_id: string
}

interface Counters {
  [key: string]: number
}

/** Une scène : un événement, avec le texte par lequel on le désigne. */
interface Scene {
  entity_id: string
  text: string
  chapter: number
  node_type: string
}

type Bump = (key: string, by?: number) => number

async function main(): Promise<void> {
  Object.assign(process.env, testDb ? { TEST_DATABASE_URL: url } : { DIRECT_URL: url })
  const sql = postgres(url, { max: 2, onnotice: () => {} })
  const done: Counters = {}
  const bump: Bump = (key, by = 1) => (done[key] = (done[key] ?? 0) + by)

  try {
    const [work] = await sql<Work[]>`
      SELECT id, user_id FROM works ORDER BY created_at LIMIT 1
    `
    if (!work) {
      console.log('Aucune œuvre dans cette base : rien à réparer.')
      return
    }

    console.log(dryRun ? '— dry-run : rien ne sera écrit —\n' : '')

    console.log('ENTITÉS EN DOUBLE')
    for (const fusion of FUSIONS) await mergeNamed(sql, work, fusion, bump)

    console.log('\nCE QU’UN NOM EST')
    for (const entry of RECLASSEMENTS) await reclassify(sql, work, entry, bump)

    console.log('\nNOMS DANS LA PROSE')
    for (const term of TERMES) await rewriteTerm(sql, work, term, bump)

    console.log('\nRÉSUMÉS')
    for (const rewrite of RÉSUMÉS) await rewriteSummary(sql, work, rewrite, bump)

    console.log('\nSCÈNES EN DOUBLE, PAR RESSEMBLANCE')
    for (const doublon of DOUBLONS) await mergeDouble(sql, work, doublon, bump)

    console.log('\nSCÈNES EN DOUBLE, NOMMÉMENT')
    for (const pair of SCÈNES_NOMMÉES) await mergePair(sql, work, pair, bump)

    console.log('\nSCÈNES EN DOUBLE (détectées)')
    await mergeEchoes(sql, work, bump)

    console.log('\nSCÈNES DÉPLACÉES')
    for (const move of DÉPLACEMENTS) await moveScene(sql, work, move, bump)

    console.log('\nENTRÉES EN SCÈNE')
    for (const entry of ENTRÉES) await fixEntrance(sql, work, entry, bump)

    console.log('\nRÉPONSES AUX QUESTIONS')
    for (const answer of RÉPONSES) await relinkAnswer(sql, work, answer, bump)

    console.log('\n' + (dryRun ? '[dry-run] Rien écrit. ' : '') + summarise(done))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// ---------------------------------------------------------------------------
// Désigner une scène par des mots
// ---------------------------------------------------------------------------

/**
 * Les scènes acceptées de ces chapitres.
 *
 * Le filtrage par mots se fait ensuite en JavaScript, avec la normalisation du
 * domaine — celle qui produit `normalized_label` — plutôt qu'en SQL avec une
 * clause par mot. Un chapitre porte quelques dizaines de scènes ; la différence
 * de coût est nulle et la différence de lisibilité ne l'est pas.
 */
async function scenesIn(sql: postgres.Sql, work: Work, chapters: number[]): Promise<Scene[]> {
  if (chapters.length === 0) return []
  return await sql<Scene[]>`
    SELECT e.entity_id, coalesce(e.summary, '') AS text,
           coalesce(e.shown_in_chapter, e.told_in_chapter) AS chapter,
           en.node_type
      FROM events e
      JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id}
       AND en.review_status = 'accepted'
       AND coalesce(e.shown_in_chapter, e.told_in_chapter) IN ${sql(chapters)}
     ORDER BY chapter
  `
}

/** Toutes les scènes contenant tous les mots, accents, casse et apostrophes mis à part. */
function matching(scenes: readonly Scene[], terms: readonly string[]): Scene[] {
  const needles = terms.map((term) => normalizeText(term))
  return scenes.filter((scene) => {
    if (scene.text === '') return false
    const hay = normalizeText(scene.text)
    return needles.every((needle) => hay.includes(needle))
  })
}

/**
 * La ponctuation ôtée avant de compter les mots.
 *
 * `tokens()` garde la ponctuation collée au mot, ce qui est sans conséquence
 * pour les noms qu'il a été écrit pour comparer et qui ne l'est pas pour une
 * phrase : « humain. » ne vaut pas « humain », et l'écart coûtait un dixième du
 * score sur la paire même que ce script replie. `echoes.ts` fait ce nettoyage
 * pour la même raison, chez lui, avant d'appeler la même fonction.
 */
function asSentence(value: string): string {
  return value.replace(/[.,;:!?«»"()[\]…]/g, ' ')
}

/** « ch63 · Luffy esquive le canon d'épaule… » */
function quote(scene: Scene): string {
  return `ch${scene.chapter} · ${scene.text.slice(0, 66)}…`
}

/** La liste imprimée quand une désignation ne tranche pas. */
function listCandidates(scenes: readonly Scene[]): void {
  for (const scene of scenes) console.log(`      · ${quote(scene)}`)
}

// ---------------------------------------------------------------------------
// 1. Deux nœuds pour une personne
// ---------------------------------------------------------------------------

/**
 * Deux nœuds repliés, le plus ancien gardé.
 *
 * Le sens de la fusion est vérifié plutôt que cru. Replier consiste à rejeter
 * l'un des deux, et rejeter celui que le lecteur rencontre en premier le ferait
 * disparaître des chapitres où il est déjà là — la silhouette du 96 s'effacerait
 * au profit d'un Tashigi qui n'existe qu'à partir du 97. Quand la table et la
 * bibliothèque ne sont pas d'accord sur les dates, c'est la bibliothèque qui a
 * raison et le script le dit en inversant.
 */
async function mergeNamed(
  sql: postgres.Sql,
  work: Work,
  fusion: { keep: string; drop: string; chapter: number; why: string },
  bump: Bump,
): Promise<void> {
  const keep = await entityByLabel(sql, work, fusion.keep)
  const drop = await entityByLabel(sql, work, fusion.drop)

  if (!keep || !drop) {
    console.log(
      `  = « ${keep ? fusion.drop : fusion.keep} » introuvable (déjà fusionné ?)`,
    )
    return
  }
  if (keep.entity_id === drop.entity_id) {
    console.log(`  = « ${fusion.drop} » est déjà un nom de « ${fusion.keep} »`)
    return
  }

  const swap = drop.first_seen_chapter < keep.first_seen_chapter
  const [survivor, hidden] = swap ? [drop, keep] : [keep, drop]
  if (swap) {
    console.log(
      `  ! « ${fusion.drop} » entre au ch${drop.first_seen_chapter}, avant ` +
        `« ${fusion.keep} » au ch${keep.first_seen_chapter} : c’est lui qu’on garde`,
    )
  }

  console.log(
    `  → « ${swap ? fusion.keep : fusion.drop} » rejoint ` +
      `« ${swap ? fusion.drop : fusion.keep} » au ch${fusion.chapter} — ${fusion.why}`,
  )
  if (dryRun) return
  await fold(sql, work, survivor.entity_id, hidden.entity_id, fusion.chapter)
  bump('entités')
}

/** Un nœud accepté portant ce libellé, avec le chapitre où le lecteur le rencontre. */
async function entityByLabel(
  sql: postgres.Sql,
  work: Work,
  label: string,
): Promise<{ entity_id: string; first_seen_chapter: number } | null> {
  const [row] = await sql<Array<{ entity_id: string; first_seen_chapter: number }>>`
    SELECT l.entity_id, en.first_seen_chapter
      FROM entity_labels l
      JOIN entities en ON en.id = l.entity_id
     WHERE l.user_id = ${work.user_id} AND l.label = ${label}
       AND en.review_status = 'accepted'
     ORDER BY en.first_seen_chapter
     LIMIT 1
  `
  return row ?? null
}

// ---------------------------------------------------------------------------
// 2. Ce qu'un nom est
// ---------------------------------------------------------------------------

async function reclassify(
  sql: postgres.Sql,
  work: Work,
  entry: { label: string; kind: string; precedence: number; why: string },
  bump: Bump,
): Promise<void> {
  const rows = await sql<Array<{ id: string; kind: string; precedence: number }>>`
    SELECT id, kind::text AS kind, precedence FROM entity_labels
     WHERE user_id = ${work.user_id} AND label = ${entry.label}
  `
  if (rows.length === 0) {
    console.log(`  ! « ${entry.label} » introuvable`)
    return
  }

  const wrong = rows.filter(
    (row) => row.kind !== entry.kind || row.precedence !== entry.precedence,
  )
  if (wrong.length === 0) {
    console.log(`  = « ${entry.label} » déjà ${entry.kind} (${entry.precedence})`)
    return
  }

  console.log(`  → « ${entry.label} » → ${entry.kind} (${entry.precedence}) — ${entry.why}`)
  if (dryRun) return
  for (const row of wrong) {
    await sql`
      UPDATE entity_labels
         SET kind = ${entry.kind}::label_kind, precedence = ${entry.precedence}
       WHERE id = ${row.id}
    `
  }
  bump('noms', wrong.length)
}

// ---------------------------------------------------------------------------
// 3. Un mot pour un autre
// ---------------------------------------------------------------------------

/**
 * Un mot remplacé dans les résumés **et** dans les questions.
 *
 * Les deux tables : la relecture des 1–42 ne lisait que `events`, et c'est ce
 * qui a laissé « Kuro » s'afficher dans les questions deux chapitres avant sa
 * révélation. Un événement porte aussi son texte dans son libellé d'entité, que
 * lisent la recherche et le fil ; réécrire l'un sans l'autre laisserait deux
 * versions de la même phrase.
 */
async function rewriteTerm(
  sql: postgres.Sql,
  work: Work,
  term: { from: string; to: string; why: string },
  bump: Bump,
): Promise<void> {
  const pattern = '\\y' + term.from.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&') + '\\y'

  const events = await sql<Array<{ entity_id: string; text: string }>>`
    SELECT entity_id, summary AS text FROM events
     WHERE user_id = ${work.user_id} AND summary ~ ${pattern}
  `
  const questions = await sql<Array<{ entity_id: string; text: string }>>`
    SELECT entity_id, question AS text FROM mysteries
     WHERE user_id = ${work.user_id} AND question ~ ${pattern}
  `

  const total = events.length + questions.length
  console.log(
    `  ${term.from} → ${term.to} (${term.why}) : ` +
      `${events.length} scène(s), ${questions.length} question(s)`,
  )
  if (dryRun || total === 0) return

  const swap = (text: string): string =>
    text.replace(new RegExp(`\\b${term.from}\\b`, 'g'), term.to)

  for (const row of events) {
    await rewriteEvent(sql, work, row.entity_id, swap(row.text))
  }
  for (const row of questions) {
    const next = swap(row.text)
    await sql`UPDATE mysteries SET question = ${next} WHERE entity_id = ${row.entity_id}`
    await mirrorLabel(sql, work, row.entity_id, next)
  }
  bump('prose', total)
}

// ---------------------------------------------------------------------------
// 4. Un résumé qui dit autre chose
// ---------------------------------------------------------------------------

async function rewriteSummary(
  sql: postgres.Sql,
  work: Work,
  rewrite: { chapter: number; terms: string[]; to: string; why: string },
  bump: Bump,
): Promise<void> {
  const found = matching(await scenesIn(sql, work, [rewrite.chapter]), rewrite.terms)
  const label = `ch${rewrite.chapter} « ${rewrite.terms.join(' + ')} »`

  if (found.length === 0) {
    const [already] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM events
       WHERE user_id = ${work.user_id} AND summary = ${rewrite.to}
    `
    console.log(
      already && already.n !== '0'
        ? `  = ${label} déjà réécrit`
        : `  ! ${label} introuvable`,
    )
    return
  }
  if (found.length > 1) {
    console.log(`  ! ${label} désigne ${found.length} scènes — aucune réécrite :`)
    listCandidates(found)
    return
  }
  /*
   * Le texte corrigé contient souvent le mot qui désignait le fautif — « MH5 »,
   * « tatouage », « chapeau » sont ce que la scène raconte, pas ce qu'elle
   * disait de travers. Sans cette égalité, une seconde exécution retrouve sa
   * propre phrase et la réécrit à l'identique en la comptant comme un
   * changement : rejouable au sens des données, bavard au sens du rapport.
   */
  if (found[0]!.text === rewrite.to) {
    console.log(`  = ${label} déjà réécrit`)
    return
  }

  console.log(`  → ${quote(found[0]!)} — ${rewrite.why}`)
  if (dryRun) return
  await rewriteEvent(sql, work, found[0]!.entity_id, rewrite.to)
  bump('résumés')
}

/**
 * Un événement porte son texte à deux endroits : la ligne `events`, que lisent
 * la chronologie et le mode récit, et son libellé d'entité, que lisent la
 * recherche et toute vue qui nomme un nœud. Réécrire l'un sans l'autre laisse la
 * bibliothèque avec deux versions de la même phrase.
 */
async function rewriteEvent(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  summary: string,
): Promise<void> {
  await sql`UPDATE events SET summary = ${summary} WHERE entity_id = ${entityId}`
  await mirrorLabel(sql, work, entityId, summary)
}

/** Une scène est nommée par sa propre phrase : le libellé suit le texte. */
async function mirrorLabel(
  sql: postgres.Sql,
  work: Work,
  entityId: string,
  text: string,
): Promise<void> {
  await sql`
    UPDATE entity_labels
       SET label = ${text.slice(0, 200)},
           normalized_label = app.normalize_text(${text.slice(0, 200)})
     WHERE entity_id = ${entityId} AND user_id = ${work.user_id}
  `
}

// ---------------------------------------------------------------------------
// 5. La même scène écrite deux fois
// ---------------------------------------------------------------------------

/**
 * La paire la plus ressemblante parmi les scènes désignées.
 *
 * Les mots désignent le voisinage, la ressemblance tranche. C'est ce qui permet
 * d'écrire « Krieg » pour un chapitre qui en parle quatre fois sans risquer de
 * replier deux scènes distinctes : sous `ECHO_WORTH_SHOWING`, le script imprime
 * la paire et ne fait rien — le seuil sous lequel `echoes.ts` tient une
 * ressemblance pour une coïncidence de vocabulaire.
 */
async function mergeDouble(
  sql: postgres.Sql,
  work: Work,
  doublon: { chapters: number[]; terms: string[]; keep: 'la plus longue' | 'la première'; why: string },
  bump: Bump,
): Promise<void> {
  const { ECHO_WORTH_SHOWING } = await import('../src/domains/review/echoes.ts')
  const where = doublon.chapters.map((n) => `ch${n}`).join('/')
  const label = `${where} « ${doublon.terms.join(' + ')} »`

  const found = matching(await scenesIn(sql, work, doublon.chapters), doublon.terms)
  if (found.length < 2) {
    console.log(`  = ${label} : une seule scène ou aucune (déjà fusionnée ?)`)
    return
  }

  let best: { a: Scene; b: Scene; overlap: number } | null = null
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const overlap = tokenOverlap(asSentence(found[i]!.text), asSentence(found[j]!.text))
      if (best === null || overlap > best.overlap) {
        best = { a: found[i]!, b: found[j]!, overlap }
      }
    }
  }

  if (!best || best.overlap < ECHO_WORTH_SHOWING) {
    console.log(
      `  ! ${label} : la meilleure paire ne se ressemble qu’à ` +
        `${Math.round((best?.overlap ?? 0) * 100)} % — rien fusionné :`,
    )
    listCandidates(found)
    return
  }

  const [keep, drop] =
    doublon.keep === 'la première'
      ? best.a.chapter <= best.b.chapter
        ? [best.a, best.b]
        : [best.b, best.a]
      : best.a.text.length >= best.b.text.length
        ? [best.a, best.b]
        : [best.b, best.a]

  console.log(`  → ${label} ${Math.round(best.overlap * 100)} % — ${doublon.why}`)
  console.log(`      gardée  : ${quote(keep)}`)
  console.log(`      repliée : ${quote(drop)}`)
  if (dryRun) return
  // Datée du plus tardif des deux : c'est le chapitre où le lecteur a les deux
  // scènes sous les yeux, donc le premier où « c'est la même » se lit.
  await fold(sql, work, keep.entity_id, drop.entity_id, Math.max(keep.chapter, drop.chapter))
  bump('scènes')
}

/** Deux scènes désignées chacune par ses mots, la première gardée. */
async function mergePair(
  sql: postgres.Sql,
  work: Work,
  pair: {
    keep: { chapter: number; terms: string[] }
    drop: { chapter: number; terms: string[] }
    why: string
  },
  bump: Bump,
): Promise<void> {
  const keep = await oneScene(sql, work, pair.keep)
  const drop = await oneScene(sql, work, pair.drop)
  if (!keep || !drop) return
  if (keep.entity_id === drop.entity_id) {
    console.log(
      `  ! ch${pair.keep.chapter} : les deux désignations tombent sur la même scène — rien fait`,
    )
    return
  }

  console.log(`  → ${pair.why}`)
  console.log(`      gardée  : ${quote(keep)}`)
  console.log(`      repliée : ${quote(drop)}`)
  if (dryRun) return
  await fold(sql, work, keep.entity_id, drop.entity_id, Math.max(keep.chapter, drop.chapter))
  bump('scènes')
}

/** La scène unique que ces mots désignent, ou rien — en le disant. */
async function oneScene(
  sql: postgres.Sql,
  work: Work,
  target: { chapter: number; terms: string[] },
): Promise<Scene | null> {
  const label = `ch${target.chapter} « ${target.terms.join(' + ')} »`
  const found = matching(await scenesIn(sql, work, [target.chapter]), target.terms)
  if (found.length === 0) {
    console.log(`  = ${label} introuvable (déjà fusionnée ?)`)
    return null
  }
  if (found.length > 1) {
    console.log(`  ! ${label} désigne ${found.length} scènes — rien fait :`)
    listCandidates(found)
    return null
  }
  return found[0]!
}

/**
 * Deux fois la même scène, retrouvées comme la publication les retrouverait.
 *
 * `findEcho` est la fonction qui empêche aujourd'hui une scène d'être écrite
 * deux fois ; l'employer ici donne à la réparation et à la prévention la même
 * définition de « c'est la même scène ». Bornée aux chapitres 43 à 100 : la
 * relecture des 1–42 a déjà balayé les siens, et repasser dessus ne ferait que
 * relire une bibliothèque déjà propre.
 */
async function mergeEchoes(sql: postgres.Sql, work: Work, bump: Bump): Promise<void> {
  const { withIngest } = await import('../src/db/boundary.ts')
  const { findEcho, ECHO_TOO_CLOSE } = await import('../src/domains/review/echoes.ts')

  const scenes = await sql<Scene[]>`
    SELECT e.entity_id, coalesce(e.summary, '') AS text,
           e.shown_in_chapter AS chapter, en.node_type
      FROM events e JOIN entities en ON en.id = e.entity_id
     WHERE e.user_id = ${work.user_id} AND en.review_status = 'accepted'
       AND e.shown_in_chapter BETWEEN ${ECHO_FROM} AND ${ECHO_TO}
    UNION ALL
    SELECT m.entity_id, m.question, m.opened_in_chapter, en.node_type
      FROM mysteries m JOIN entities en ON en.id = m.entity_id
     WHERE m.user_id = ${work.user_id} AND en.review_status = 'accepted'
       AND m.opened_in_chapter BETWEEN ${ECHO_FROM} AND ${ECHO_TO}
  `

  const merged = new Set<string>()
  for (const scene of scenes) {
    if (merged.has(scene.entity_id) || !scene.text) continue

    const echo = await withIngest((db) =>
      findEcho(db, {
        workId: work.id,
        userId: work.user_id,
        nodeTypes:
          scene.node_type === 'mystery' ? ['mystery'] : ['event', 'battle', 'voyage'],
        text: scene.text,
        chapterNumber: scene.chapter,
        excludeEntityIds: [scene.entity_id, ...merged],
      }),
    )

    if (!echo || echo.overlap < ECHO_TOO_CLOSE) continue
    // Une scène qui ressemble à une scène d'un autre chapitre est un rappel,
    // pas un doublon.
    if (echo.chapterNumber !== scene.chapter) continue

    console.log(
      `  → ch${scene.chapter} ${Math.round(echo.overlap * 100)} % : ${scene.text.slice(0, 58)}…`,
    )
    if (!dryRun) await fold(sql, work, echo.entityId, scene.entity_id, scene.chapter)
    merged.add(scene.entity_id)
    bump('scènes')
  }
  if (merged.size === 0) console.log('  = aucune scène en double')
}

/**
 * Une scène ou une entité rejointe à sa jumelle, et une seule des deux montrée.
 *
 * Deux écritures, parce qu'elles répondent à deux questions. Le `same_as` dit
 * *pourquoi* — daté du chapitre, écrit comme la parole du lecteur (`user`,
 * verrouillé, donc à l'abri d'une proposition ultérieure de l'IA), et c'est le
 * mécanisme que le dépôt emploie déjà pour unifier deux nœuds. Le
 * `review_status` dit *ce qui se voit* : la politique des entités n'admet que
 * « accepted », donc rejeter la copie la retire de la fiche, du graphe, de la
 * recherche et du fil du chapitre d'un seul coup.
 *
 * Le `same_as` seul n'aurait pas suffi, et c'est le piège de cette réparation :
 * il replie bien les deux nœuds sur la fiche, mais le fil d'un chapitre liste
 * les lignes de `events`, où la scène en double reste une ligne.
 *
 * Rien n'est supprimé : une ligne remise à « accepted » revient telle quelle.
 */
async function fold(
  sql: postgres.Sql,
  work: Work,
  a: string,
  b: string,
  chapter: number,
): Promise<void> {
  const [existing] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM assertions
     WHERE predicate = 'same_as' AND review_status = 'accepted'
       AND ((subject_entity_id = ${a} AND object_entity_id = ${b})
         OR (subject_entity_id = ${b} AND object_entity_id = ${a}))
  `
  if (!existing || existing.n === '0') {
    await sql`
      INSERT INTO assertions (
        work_id, user_id, subject_entity_id, predicate, object_entity_id,
        knowledge_from_chapter, observed_in_chapter, confidence,
        epistemic_status, review_status, proposed_by, locked
      ) VALUES (
        ${work.id}, ${work.user_id}, ${a}, 'same_as', ${b},
        ${chapter}, ${chapter}, 1,
        'user_validated', 'accepted', 'user', true
      )
    `
  }
  await sql`
    UPDATE entities SET review_status = 'rejected'
     WHERE id = ${b} AND user_id = ${work.user_id}
  `
  await sql`
    INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
    VALUES (${work.user_id}, 'entities_joined', 'entity', ${a},
            ${sql.json({ hidden: b, chapter, note: NOTE })})
  `
}

// ---------------------------------------------------------------------------
// 6. Une scène rangée dans le mauvais chapitre
// ---------------------------------------------------------------------------

async function moveScene(
  sql: postgres.Sql,
  work: Work,
  move: { from: number; to: number; terms: string[]; why: string },
  bump: Bump,
): Promise<void> {
  const label = `« ${move.terms.join(' + ')} » ch${move.from} → ch${move.to}`
  const found = matching(await scenesIn(sql, work, [move.from]), move.terms)

  if (found.length === 0) {
    const already = matching(await scenesIn(sql, work, [move.to]), move.terms)
    console.log(
      already.length > 0 ? `  = ${label} déjà au ch${move.to}` : `  ! ${label} introuvable`,
    )
    return
  }
  if (found.length > 1) {
    console.log(`  ! ${label} désigne ${found.length} scènes — aucune déplacée :`)
    listCandidates(found)
    return
  }

  console.log(`  → ${quote(found[0]!)} — ${move.why}`)
  if (dryRun) return

  const id = found[0]!.entity_id
  /*
   * Les deux colonnes séparément, et seulement celle qui est déjà renseignée.
   * « montré au » et « raconté au » sont deux axes que la table garde exprès
   * distincts ; une scène qui n'a que le premier ne doit pas repartir avec les
   * deux, ce qui ferait dire à un flash-back qu'il a été raconté là où il se
   * déroule.
   */
  await sql`
    UPDATE events SET shown_in_chapter = ${move.to}
     WHERE entity_id = ${id} AND shown_in_chapter IS NOT NULL
  `
  await sql`
    UPDATE events SET told_in_chapter = ${move.to}
     WHERE entity_id = ${id} AND told_in_chapter IS NOT NULL
  `
  await sql`UPDATE entities SET first_seen_chapter = ${move.to} WHERE id = ${id}`
  await sql`
    UPDATE entity_labels SET revealed_in_chapter = ${move.to}
     WHERE entity_id = ${id} AND revealed_in_chapter IS NOT NULL
  `
  bump('scènes déplacées')
}

// ---------------------------------------------------------------------------
// 7. Le chapitre où quelqu'un entre dans la case
// ---------------------------------------------------------------------------

async function fixEntrance(
  sql: postgres.Sql,
  work: Work,
  entry: { labels: string[]; chapter: number; why: string },
  bump: Bump,
): Promise<void> {
  let found: { entity_id: string; first_seen_chapter: number; label: string } | null = null
  for (const label of entry.labels) {
    const row = await entityByLabel(sql, work, label)
    if (row) {
      found = { ...row, label }
      break
    }
  }
  if (!found) {
    console.log(`  ! « ${entry.labels.join(' / ')} » introuvable`)
    return
  }

  const [chapterRow] = await sql<Array<{ id: string }>>`
    SELECT id FROM chapters WHERE work_id = ${work.id} AND number = ${entry.chapter}
  `
  if (!chapterRow) {
    console.log(`  ! le chapitre ${entry.chapter} n’est pas dans cette bibliothèque`)
    return
  }

  const [stated] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM occurrences
     WHERE entity_id = ${found.entity_id} AND chapter_number = ${entry.chapter}
       AND stated AND kind = 'appearance'
  `
  const seen = stated !== undefined && stated.n !== '0'
  const late = found.first_seen_chapter > entry.chapter

  if (seen && !late) {
    console.log(`  = ${found.label} entre au ch${entry.chapter} : déjà tranché`)
    return
  }

  console.log(
    `  → ${found.label} : ` +
      (late ? `entrée ch${found.first_seen_chapter} → ch${entry.chapter}, ` : '') +
      `vu au ch${entry.chapter} — ${entry.why}`,
  )
  if (dryRun) return

  if (late) {
    /*
     * Le libellé suit le nœud, mais seulement celui que la publication avait
     * daté du même chapitre. Un nom daté autrement est une révélation que
     * quelqu'un a tranchée, et la déplacer effacerait ce jugement.
     */
    const moved = await sql<Array<{ label: string }>>`
      UPDATE entity_labels SET revealed_in_chapter = ${entry.chapter}
       WHERE entity_id = ${found.entity_id}
         AND revealed_in_chapter = ${found.first_seen_chapter}
      RETURNING label
    `
    for (const row of moved) {
      console.log(`      « ${row.label} » ch${found.first_seen_chapter} → ch${entry.chapter}`)
    }
    await sql`
      UPDATE entities SET first_seen_chapter = ${entry.chapter} WHERE id = ${found.entity_id}
    `
  }

  if (!seen) {
    await sql`
      INSERT INTO occurrences (entity_id, user_id, chapter_id, kind, stated, chapter_number)
      VALUES (${found.entity_id}, ${work.user_id}, ${chapterRow.id},
              'appearance', true, ${entry.chapter})
    `
  }
  bump('entrées')
}

// ---------------------------------------------------------------------------
// 8. Une question refermée par la mauvaise scène
// ---------------------------------------------------------------------------

async function relinkAnswer(
  sql: postgres.Sql,
  work: Work,
  entry: {
    openedIn: number
    question: string[]
    wrong: number | null
    answer: { chapters: number[]; terms: string[] } | null
    why: string
  },
  bump: Bump,
): Promise<void> {
  const label = `ch${entry.openedIn} « ${entry.question.join(' + ')} »`

  const rows = await sql<
    Array<{ entity_id: string; question: string; resolved_in_chapter: number | null }>
  >`
    SELECT m.entity_id, m.question, m.resolved_in_chapter
      FROM mysteries m JOIN entities en ON en.id = m.entity_id
     WHERE m.user_id = ${work.user_id} AND m.opened_in_chapter = ${entry.openedIn}
       AND en.review_status = 'accepted'
  `
  const needles = entry.question.map((term) => normalizeText(term))
  const found = rows.filter((row) => {
    const hay = normalizeText(row.question)
    return needles.every((needle) => hay.includes(needle))
  })

  if (found.length === 0) {
    console.log(`  ! ${label} introuvable`)
    return
  }
  if (found.length > 1) {
    console.log(`  ! ${label} désigne ${found.length} questions — aucune touchée :`)
    for (const row of found) console.log(`      · ${row.question.slice(0, 70)}…`)
    return
  }

  const mystery = found[0]!
  const wanted = entry.answer
  const alreadyRight =
    wanted !== null &&
    mystery.resolved_in_chapter !== null &&
    wanted.chapters.includes(mystery.resolved_in_chapter)
  const alreadyOpen = wanted === null && mystery.resolved_in_chapter === null

  if (alreadyRight || alreadyOpen) {
    console.log(`  = ${label} : déjà ${wanted === null ? 'ouverte' : 'refermée au bon chapitre'}`)
    return
  }

  console.log(`  → ${mystery.question.slice(0, 66)}… — ${entry.why}`)
  if (entry.wrong !== null && mystery.resolved_in_chapter !== entry.wrong) {
    // Dit, pas corrigé : la relecture attendait le lien fautif à un chapitre, la
    // bibliothèque le porte à un autre. Ce qui suit retire ce qui est là, quel
    // qu'il soit — mais l'écart mérite d'être lu avant d'appliquer.
    console.log(
      `      ! la relecture le disait au ch${entry.wrong}, la base au ` +
        `ch${mystery.resolved_in_chapter ?? '—'}`,
    )
  }

  /*
   * Le lien fautif s'en va d'abord, et sans condition.
   *
   * Une question ouverte est un état honnête ; refermée par la mauvaise scène,
   * non — donc le retrait ne dépend jamais de la réussite de ce qui suit. Une
   * exécution qui n'aurait pas trouvé la bonne scène laisse la question ouverte,
   * et la suivante, une fois les mots resserrés, n'a plus qu'à écrire le lien.
   */
  const stale = await sql<Array<{ id: string; observed_in_chapter: number }>>`
    SELECT id, observed_in_chapter FROM assertions
     WHERE user_id = ${work.user_id} AND predicate = 'resolves_mystery'
       AND object_entity_id = ${mystery.entity_id} AND review_status = 'accepted'
  `
  if (stale.length > 0 || mystery.resolved_in_chapter !== null) {
    console.log(
      stale.length === 0
        ? `      − rouverte (refermée au ch${mystery.resolved_in_chapter}, sans lien)`
        : `      − ${stale.length} lien(s) retiré(s) : ch${stale
            .map((row) => row.observed_in_chapter)
            .join(', ch')}`,
    )
    if (!dryRun) {
      for (const row of stale) {
        await sql`UPDATE assertions SET review_status = 'rejected' WHERE id = ${row.id}`
      }
      await sql`
        UPDATE mysteries SET state = 'open', resolved_in_chapter = NULL
         WHERE entity_id = ${mystery.entity_id}
      `
      await sql`
        INSERT INTO audit_log (user_id, action, subject_kind, subject_id, detail)
        VALUES (${work.user_id}, 'mystery_reopened', 'entity', ${mystery.entity_id},
                ${sql.json({ was: mystery.resolved_in_chapter, note: NOTE })})
      `
    }
    bump('réponses')
  }

  if (wanted === null) return

  // Le premier chapitre de la liste qui contient une scène désignée. « au 49 ou
  // au 50 » est une vraie indétermination de la relecture, pas une paresse.
  let scene: Scene | null = null
  for (const chapter of wanted.chapters) {
    const candidates = matching(await scenesIn(sql, work, [chapter]), wanted.terms)
    if (candidates.length === 1) {
      scene = candidates[0]!
      break
    }
    if (candidates.length > 1) {
      console.log(
        `      ! ch${chapter} « ${wanted.terms.join(' + ')} » désigne ${candidates.length} scènes :`,
      )
      listCandidates(candidates)
      return
    }
  }

  if (!scene) {
    console.log(
      `      ! aucune scène « ${wanted.terms.join(' + ')} » aux ` +
        `ch${wanted.chapters.join('/')} : la question reste ouverte`,
    )
    return
  }

  console.log(`      + refermée par ${quote(scene)}`)
  if (dryRun) return

  await sql`
    INSERT INTO assertions (
      work_id, user_id, subject_entity_id, predicate, object_entity_id,
      knowledge_from_chapter, observed_in_chapter, confidence,
      epistemic_status, review_status, proposed_by, locked
    ) VALUES (
      ${work.id}, ${work.user_id}, ${scene.entity_id}, 'resolves_mystery',
      ${mystery.entity_id}, ${scene.chapter}, ${scene.chapter}, 1,
      'user_validated', 'accepted', 'user', true
    )
  `
  await sql`
    UPDATE mysteries SET state = 'resolved', resolved_in_chapter = ${scene.chapter}
     WHERE entity_id = ${mystery.entity_id}
  `
  bump('réponses')
}

function summarise(done: Counters): string {
  const parts = Object.entries(done).map(([key, count]) => `${count} ${key}`)
  return parts.length === 0 ? 'Rien à corriger.' : parts.join(' · ')
}

await main()
process.exit(0)
