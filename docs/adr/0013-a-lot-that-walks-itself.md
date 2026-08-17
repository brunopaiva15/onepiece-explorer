# ADR 0013 — Un lot qui se déroule tout seul, et s'arrête là où une question se pose

**Statut :** accepté · **Date :** 2026-08-17 · **Prolonge :** l'ADR 0010.

## Contexte

L'ADR 0010 a fait du lot une file : tout s'importe d'un coup, un chapitre se
traite à la fois, et **chacun démarre à la publication du précédent** — le
moment exact où les entités qu'il devra reconnaître entrent dans le graphe.
Cette décision n'est pas remise en cause ici ; elle est la raison d'être de tout
ce qui suit.

Ce que l'ADR 0010 n'a pas dit, c'est **qui publie**. La réponse était : vous, à
chaque fois, à travers quatre-vingt-six cartes de revue par chapitre. Un lot de
vingt importé en un clic traitait donc un chapitre et s'arrêtait, en attendant un
événement qui demandait l'après-midi pour être produit dix-neuf fois. Le
« coût humain inchangé » que l'ADR 0010 annonçait comme un coût acceptable était
en réalité le facteur qui rendait le lot inutile : il supprimait les allers-
retours de récupération, c'est-à-dire la seule partie qui ne coûtait rien.

La passe automatique existait déjà (`domains/review/auto.ts`) : elle accepte ce
qui ne dépend d'aucun nom et rend les questions qu'un modèle ne peut pas
trancher. Elle était derrière `AUTO_REVIEW_NAMES_ONLY`, une variable
d'environnement — c'est-à-dire tout ou rien pour toute la bibliothèque, sans
rapport avec l'import qu'on est en train de faire.

## Décision

**La publication qui libère le chapitre suivant peut être celle du traitement
lui-même.** Un chapitre importé avec `chapters.auto_review` (migration 0029)
accepte les propositions qui ne demandent personne, garde celles qui demandent
quelqu'un — un nom dont le modèle dit ne pas être sûr, un rapprochement
d'identité, une contradiction, une relation que l'ontologie refuse — et s'ouvre
quand il ne reste plus rien de proposé. Ouvrir un chapitre est précisément
l'événement que la file attend. L'ordre de l'ADR 0010 est intact : un chapitre à
la fois, dans l'ordre, chacun contre le graphe écrit par le précédent.

**La demande est portée par l'import, pas par l'environnement.** Une colonne sur
le chapitre plutôt qu'une variable : « rattraper cent chapitres » et « lire celui
de cette semaine » ne sont pas le même acte et ne doivent pas être le même
réglage. Le chapitre collé demain arrive toujours comme une file de propositions.
`AUTO_REVIEW_NAMES_ONLY` reste, et veut dire ce qu'il a toujours voulu dire :
toute l'instance.

**La chaîne s'arrête au chapitre qui pose une vraie question, et le dit.** Ce
n'est pas une limitation à corriger plus tard : le chapitre suivant serait
comparé à un graphe où manque exactement l'entité dont on discute. `batchStatus`
distingue les quatre états — en cours, interrompu, bloqué, prêt — parce qu'une
chaîne arrêtée exprès et une chaîne cassée sont identiques vues de l'extérieur.
Le panneau nomme le chapitre et lie la page qui débloque.

**Un chapitre qui ne propose rien s'ouvre quand même.** Une extraction peut
n'alimenter aucune file : tout ce qu'elle proposait avait déjà été tranché sous
la même empreinte, donc les décisions sont réappliquées et il ne reste rien à
revoir. « Plus rien de proposé » est la définition d'un chapitre lu jusqu'au
bout ; sans cela il restait en revue pour toujours et la chaîne mourait dessus
sans que rien ne l'explique.

**Le chapitre qui s'ouvre lance le suivant, dans une fenêtre de temps.** C'est le
chaînage lui-même, et il vit dans le traitement : une ouverture est exactement
l'événement que la file attend, qu'elle vienne d'un humain ou de la passe
automatique. La première version faisait dépendre ce pas d'un tic envoyé par
`/admin/import`, ce qui l'a rendu inutile à la première utilisation réelle — on
importe un lot, on va regarder la page des chapitres, et la chaîne s'arrête. Le
chapitre 151 s'était publié tout seul comme prévu ; le 152 attendait une page que
personne ne regardait.

La raison qui avait fait choisir le tic reste vraie et devient une **borne** au
lieu d'une architecture : le pipeline s'exécute dans l'invocation qui l'a lancé,
`after()` prolonge cette invocation sans en créer une nouvelle, et le
`maxDuration` de la route plafonne l'ensemble. Enchaîner sans limite mettrait le
plafond au milieu du chapitre en cours, le tuant sans qu'aucun échec soit
enregistré — la panne que `run-progress` décrit déjà comme « plus rien ne bouge ».
L'invocation porte donc une fenêtre (`pipeline/chain.ts`, 210 s sous les 300 s
déclarées) : quand elle est épuisée, la chaîne s'arrête **entre deux chapitres**.
S'arrêter là ne coûte rien ; être tué à l'intérieur d'un chapitre coûte une
relance.

**Le tic reste, comme reprise, et depuis n'importe quelle page de l'atelier.** Il
ramasse la file là où la fenêtre l'a laissée. Il est dans le layout `/admin` et
non sur une page : le mettre sur la page d'import, c'était le mettre sur la seule
page où personne ne reste. Toutes les décisions restent côté serveur
(`queueTickAction`) — un client laissé ouvert une heure ne peut rien déclencher
que le serveur n'aurait pas décidé — et sur un atelier où rien ne tourne, il coûte
une requête au chargement puis s'arrête.

**Cinquante chapitres par lot, et soixante traitements par heure.** La limite de
vingt disait qu'au-delà personne ne relit la prose avant de la stocker. C'était
vrai du seul mode qui existait. Un lot qui se publie tout seul est un autre acte
— rattraper cinq tomes, la lecture ayant lieu ensuite, sur les chapitres qui
posent une question. Le plafond horaire suit : soixante laisse un lot de
cinquante s'enchaîner avec de la marge pour les relances.

## Ce que cela coûte

**Ce qui entre dans le graphe sans lecture humaine.** C'est le coût principal et
il est exactement celui que `domains/review/auto.ts` énonce déjà : les
propositions qui ne posent pas de question de nom ni d'identité entrent sans que
personne les lise. Rien n'est destructif — chaque assertion garde ses preuves, la
frontière les date toujours par révélation, et une erreur est visible sur la
fiche de l'entité et réversible depuis elle — mais ce n'est plus « l'IA propose,
l'humain décide » au sens strict. C'est pourquoi la case existe, pourquoi elle
est par import, et pourquoi la décocher rend exactement l'ancien comportement.

**Un lot plus long qu'une invocation demande une page ouverte quelque part.** La
chaîne va aussi loin que sa fenêtre — quelques chapitres —, puis attend un tic.
Avec l'atelier ouvert sur n'importe quelle page, c'est invisible. Sans aucune
page ouverte, le lot est en pause entre deux chapitres : rien n'est perdu, et
rouvrir l'atelier reprend. C'est la conséquence directe de n'avoir ni worker ni
cron, et c'est écrit à l'écran plutôt que laissé à déduire.

**Un rapprochement arrête la chaîne.** Sur un lot où beaucoup de personnages sont
nouveaux, cela peut arriver souvent. C'est le comportement voulu : personne
d'autre que vous ne décide d'une identité, et c'est la question dont l'ADR 0010
dit qu'aucune étape ultérieure ne la rattrape.

## Alternatives écartées

**Tout publier, rapprochements compris.** Ce serait la seule version réellement
« sans arrêt », et elle perd exactement ce que la file avait été construite pour
sauver. Un score qui ferait passer une identité devant un humain annulerait la
raison d'être de l'étape de résolution.

**Ne chaîner que depuis un tic du client, un chapitre par invocation.** C'était la
première version : elle évite le plafond par construction, et elle fait dépendre
la chaîne de la page sur laquelle on se trouve. À la première utilisation réelle,
la chaîne s'est arrêtée au deuxième chapitre. Une garantie qui demande de ne pas
changer de page n'en est pas une.

**Un worker, ou un cron.** C'est la réponse correcte à « sans garder d'onglet
ouvert », et c'est la pièce mobile que l'ADR sur `startChapterRun` a
délibérément supprimée : quand elle ne tourne pas, le symptôme est un chapitre
qui attend sans explication. À reprendre le jour où un lot doit tourner sans
personne devant, pas avant.

**Garder `AUTO_REVIEW_NAMES_ONLY` comme seul interrupteur.** Une variable
d'environnement ne peut pas répondre à la question « pour ce lot-ci ». L'allumer
pour rattraper cent chapitres changerait silencieusement la revue du chapitre
unique importé trois mois plus tard.
