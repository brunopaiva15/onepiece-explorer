# ADR 0010 — Un import en lot est une file, pas un lancement groupé

**Statut :** accepté · **Date :** 2026-08-13 · **Prolonge :** l'ADR 0009.

## Contexte

L'ADR 0009 a supprimé le collage manuel : un chapitre se récupère par son
numéro. Il reste que la boucle se fait un chapitre à la fois, et qu'il y en a
plus de mille. Récupérer dix chapitres d'un coup est la suite évidente, et la
partie récupération l'est effectivement : dix appels à une API publique, sans
aucune conséquence sur le graphe.

C'est la partie **traitement** qui ne se groupe pas.

`runResolve` ne compare une entité proposée qu'à ce qui est **déjà dans le
graphe** au chapitre courant (`blockByTrigram`), et la seule chose qui met une
entité dans le graphe est une publication humaine. Dix traitements lancés
ensemble voient donc tous le graphe tel qu'il était avant le lot.

La conséquence n'est pas celle qu'on attend, et celle qu'on attend est déjà
traitée : la publication rejoint une entité acceptée portant **exactement** le
même nom normalisé (`exactTwin` dans `review/publish.ts`), donc un personnage
reproposé sous un nom identique aux chapitres 12 à 21 atterrit quand même sur un
seul nœud. Cette protection existe précisément parce qu'importer loin devant la
revue est l'usage normal de cet outil.

Ce qu'aucune étape ultérieure ne rattrape, c'est tout ce qui est **plus faible
qu'un nom exact**. « L'homme au tablier de cuir » au chapitre 12 et « Kaelo
Renn » au 13 sont la même personne et ne partagent aucun caractère. Seul
`runResolve` peut poser cette question, seulement contre ce qui est déjà dans le
graphe, et elle n'est jamais reposée ensuite. Un lot traité en parallèle produit
donc deux entités et **aucun rapprochement à trancher** — sans rien signaler, ce
qui est la partie qui compte. Les alias, les variantes d'orthographe et les
formes traduites sont exactement les cas d'identité sur lesquels ce produit est
prudent partout ailleurs.

Coût secondaire : l'extraction reçoit les entités déjà acceptées comme
« connues » ; un traitement aveugle repropose ce que vous avez déjà tranché, et
la file de revue se remplit de copies de questions répondues.

## Décision

**Le lot importe tout d'un coup et traite un chapitre à la fois.** Le premier
chapitre démarre à l'import ; chacun des suivants démarre à la **publication**
du précédent — le moment exact où les entités qu'il devra reconnaître entrent
dans le graphe.

L'attente est une donnée, pas une déduction : `chapters.queued_for_run`
(migration 0021). « Le prochain chapitre sans traitement » aurait ramassé un
chapitre importé avec « lancer le traitement » décoché, transformant des heures
plus tard un choix explicite de ne pas dépenser en dépense déclenchée par autre
chose. Un chapitre est dans la file parce qu'on l'y a mis.

**Le chaînage vit dans l'action de revue, pas dans `publishDecisions`.** Cette
fonction est la seule porte du graphe, tient une transaction, et écrit ce qu'un
humain a accepté — rien d'autre. Lancer un pipeline depuis l'intérieur mettrait
un appel de modèle dans le même souffle qu'un commit. L'action de revue le fait
déjà pour les illustrations, dans le même `after()`, pour la même raison.

**La réclamation est un `UPDATE` conditionnel qui renvoie la ligne.** Deux
publications simultanées — deux onglets, un double clic — ne peuvent pas prendre
le même chapitre : le second `UPDATE` ne correspond à aucune ligne, le drapeau
qu'il filtre étant déjà retombé. Une lecture puis une écriture laisserait
exactement la fenêtre qui paie deux fois le même traitement.

**Un traitement refusé remet le chapitre dans la file.** Le refus réaliste est
la limite horaire, qui veut dire « plus tard », pas « jamais ». Laisser le
chapitre réclamé arrêterait silencieusement la file au chapitre qui a touché le
plafond.

## Ce que cela coûte

**La file dépend d'un événement que vous seul produisez.** Si vous ne publiez
jamais le chapitre en cours, rien ne libère la suite. C'est pourquoi la file est
visible sur `/import` avec ses deux issues : traiter le suivant maintenant, ou
vider la file. Vider ne supprime rien — les textes restent importés.

**Vingt chapitres au maximum par lot.** Ce n'est pas une limite de performance :
c'est une limite sur la quantité de prose que quelqu'un accepte de stocker sans
l'avoir lue. Un champ qui accepterait « 1 à 1100 » transformerait une faute de
frappe en bibliothèque.

**Le lot n'accélère pas la revue.** Il supprime les allers-retours de
récupération, qui étaient le coût machine ; le coût humain — trancher chaque
proposition — est inchangé, et c'était déjà le facteur limitant.

## Alternatives écartées

**Tout lancer en parallèle.** C'est la lecture littérale de « importer dix
chapitres à la fois », et c'est la seule version qui perde des données de
manière invisible : pas de rapprochement proposé, donc rien à voir dans le
centre de revue, donc aucun signal. Un échec bruyant aurait été préférable.

**Enchaîner sur la fin du *traitement* plutôt que sur la publication.** Plus
rapide et faux pour la même raison que le parallèle : un traitement terminé n'a
rien mis dans le graphe. Seule la publication le fait.

**Tout importer sans rien traiter, et lancer à la main.** C'était l'option
minimale, et elle reste accessible (décocher, ou vider la file). Elle demande un
clic par chapitre au moment exact où vous venez de publier le précédent — ce
qui est précisément ce que le chaînage automatise, sans rien changer à l'ordre.

**Bloquer le lot tant qu'un chapitre antérieur n'est pas publié.** Séduisant et
piégeux : un vieux brouillon jamais revu bloquerait la file pour toujours, sans
que rien ne l'explique. La file démarre, et c'est au lecteur de décider quoi
publier.
