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

**Un tic depuis la page ouverte, un chapitre par invocation.** Le pipeline
s'exécute dans l'invocation qui l'a lancé, sous le `maxDuration` de la route.
Enchaîner vingt chapitres dans une seule invocation mettrait le plafond au milieu
de celui qui tourne quand les cinq minutes tombent, le tuant sans qu'aucun échec
soit enregistré — la panne que `run-progress` décrit déjà comme « plus rien ne
bouge ». Un tic depuis `/admin/import` achète à chaque chapitre son invocation.
Toutes les décisions restent côté serveur (`queueTickAction`) : un client laissé
ouvert une heure ne peut rien déclencher que le serveur n'aurait pas décidé.

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

**Fermer la page met le lot en pause.** Entre deux chapitres, jamais au milieu
d'un : rien n'est perdu et rouvrir `/admin/import` reprend. Mais quelqu'un qui
attendait cinquante chapitres et en retrouve sept doit l'avoir lu avant, pas
l'avoir déduit — le panneau le dit.

**Un rapprochement arrête la chaîne.** Sur un lot où beaucoup de personnages sont
nouveaux, cela peut arriver souvent. C'est le comportement voulu : personne
d'autre que vous ne décide d'une identité, et c'est la question dont l'ADR 0010
dit qu'aucune étape ultérieure ne la rattrape.

## Alternatives écartées

**Tout publier, rapprochements compris.** Ce serait la seule version réellement
« sans arrêt », et elle perd exactement ce que la file avait été construite pour
sauver. Un score qui ferait passer une identité devant un humain annulerait la
raison d'être de l'étape de résolution.

**Enchaîner les chapitres dans la même invocation.** Écrit d'abord, écarté après
lecture de la documentation de `after()` : la durée reste celle de la route.
Le plafond ne disparaît pas, il se déplace au milieu d'un chapitre.

**Un worker, ou un cron.** C'est la réponse correcte à « sans garder d'onglet
ouvert », et c'est la pièce mobile que l'ADR sur `startChapterRun` a
délibérément supprimée : quand elle ne tourne pas, le symptôme est un chapitre
qui attend sans explication. À reprendre le jour où un lot doit tourner sans
personne devant, pas avant.

**Garder `AUTO_REVIEW_NAMES_ONLY` comme seul interrupteur.** Une variable
d'environnement ne peut pas répondre à la question « pour ce lot-ci ». L'allumer
pour rattraper cent chapitres changerait silencieusement la revue du chapitre
unique importé trois mois plus tard.
