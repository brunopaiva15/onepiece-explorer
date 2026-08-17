# ADR 0012 — L'abonnement plutôt que l'API facturée

**Statut :** accepté · **Date :** 2026-08-17

## Contexte

Le traitement des chapitres passait par l'API Anthropic, facturée au token via
`ANTHROPIC_API_KEY`. L'ADR 0006 a organisé cette dépense — routage par palier,
mise en cache du préfixe, lots à moitié prix, escalade conditionnelle — et elle
reste réelle : environ mille cent chapitres, une centaine d'appels portant une
image pour un chapitre dessiné.

Or personne d'autre que le propriétaire de l'installation n'appelle jamais le
modèle. Le traitement se déclenche depuis `/admin`, derrière une session
vérifiée ; le site public lit un graphe déjà construit et ne peut pas provoquer
un appel. C'est exactement la forme d'usage qu'un abonnement Claude Max couvre
déjà — et payer deux fois la même chose, une fois par mois et une fois au token,
n'a pas d'autre justification que l'inertie.

Le Claude Agent SDK sait s'authentifier avec un jeton d'abonnement
(`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`). Ce qu'il ne sait pas faire,
c'est tourner dans une fonction serverless : il lance Claude Code en
sous-processus, ce qui demande un système de fichiers inscriptible et le droit
de forker.

## Décision — un fournisseur de plus, rien d'autre ne bouge

`ClaudeAgentProvider` implémente `ModelProvider` comme les quatre autres. Il
pose les mêmes questions : mêmes prompts, mêmes blocs de contenu dans le même
ordre, mêmes schémas Zod, même validation. L'ancrage des preuves, la frontière
anti-spoiler, la quarantaine et la revue sont en aval de tout fournisseur et
n'ont pas été touchés — c'est précisément la propriété de l'architecture qui
rend cette migration petite.

Deux choses de l'implémentation Anthropic n'ont pas d'équivalent et sont donc
absentes plutôt que simulées : le réchauffage explicite du cache de prompt (le
SDK gère son cache lui-même) et le coût. Un abonnement ne se facture pas au
token, donc `costCents` vaut zéro, exactement comme pour un modèle auto-hébergé.
Les tokens, eux, restent comptés : ce sont eux qui disent ce qu'un chapitre a
consommé de l'allocation mensuelle.

## Décision — deux exécutions pour une seule question

| Runtime | Où tourne Claude | Pour |
|---|---|---|
| `inline` | sous-processus de ce processus | machine de développement, runner CI |
| `sandbox` | microVM Vercel Sandbox | déploiement serverless |

`CLAUDE_AGENT_RUNTIME=auto` choisit d'après l'hôte. Le payload envoyé est
construit au même endroit pour les deux (`agentPayload`) : les deux runtimes ne
peuvent pas diverger sur ce qui est demandé, seulement sur l'endroit où c'est
exécuté.

Le choix explicite est honoré dans un sens seulement. `sandbox` est acceptée
partout, y compris sur une machine — c'est la dorsale du déploiement, et pouvoir
l'exercer localement est la seule façon de savoir qu'elle marche encore.
`inline` sur un déploiement Vercel est en revanche ignorée : voir les
alternatives écartées, ce n'est pas une préférence mais une impossibilité
mesurée.

Le bac à sable est créé au premier appel d'un traitement et réutilisé par tous
les suivants, puis arrêté après trois minutes d'inactivité. Un chapitre dessiné
fait vingt à trente appels : payer une minute de démarrage par appel serait
indéfendable, la payer une fois par chapitre ne l'est pas.

Aucun port n'est exposé et rien n'écoute dans le bac à sable. Chaque appel écrit
sa requête dans un fichier, lance le script, relit la réponse. Une URL publique
qui atteint Claude sur cet abonnement, protégée par un en-tête, serait un
affaiblissement de « aucun chemin public vers Claude » que quelques centaines de
millisecondes ne paient pas.

## Décision — aucun repli payant, jamais

Quota Claude Max atteint : le traitement échoue avec un message qui le dit.
Il ne bascule pas sur `ANTHROPIC_API_KEY`.

C'est la décision structurante et elle a une conséquence de conception : le
choix du fournisseur se fait **à la construction**, en lisant l'environnement,
jamais **à l'échec**, en rattrapant une erreur. Un repli au moment de l'erreur
serait, par construction, une facture déclenchée par la seule circonstance où
personne ne regarde — un import de nuit qui dépasse l'allocation.

`ANTHROPIC_API_KEY` reste supportée et n'est plus le défaut : `MODEL_PROVIDER=anthropic`
la choisit explicitement, ce qui laisse la comparaison des deux possible. Ce qui
a disparu, c'est qu'elle soit atteinte sans avoir été demandée.

L'environnement remis au sous-processus est purgé de `ANTHROPIC_API_KEY` et de
tout ce qui pourrait rediriger l'appel vers un endpoint facturé. La promesse
n'est pas tenue par une convention d'appel, elle est tenue parce que le procédé
n'a pas la clé.

## Ce qui reste vrai

`settingSources: []` — le SDK charge sinon les réglages du disque, y compris le
`CLAUDE.md` et l'`AGENTS.md` de ce dépôt. Des instructions écrites pour qui
modifie ce code n'ont rien à faire dans le contexte d'un modèle à qui l'on
demande ce qui se passe au chapitre 47.

`tools: []`, aucun serveur MCP — repris inchangé de l'implémentation Anthropic.
Les pages sont un document non fiable ; un agent capable de suivre une URL
trouvée dedans transformerait un téléversement en falsification de requête
côté serveur.

## Corrigé depuis — la sortie d'erreur du CLI n'est plus jetée

Les deux dorsales passaient `stderr: () => {}` au SDK : les diagnostics du CLI
hors du journal du serveur, ce qui est juste pour cent appels qui réussissent et
ruineux pour celui qui échoue. Un CLI qui refuse de démarrer sort en code 1, le
SDK lève « Claude Code process exited with code 1 », et *pourquoi* n'existait que
sur cette sortie d'erreur — que l'on jetait avant de l'avoir lue. Ce qui
remontait à l'utilisateur était un code de sortie et une invitation à deviner.

Elle est désormais gardée par la fin, deux mille caractères, et n'est écrite
qu'en cas d'échec. Dans le bac à sable elle traverse le fichier de réponse : la
machine meurt avec ce qu'elle sait, et l'hôte n'a aucun moyen d'aller le chercher
après coup.

Le verdict se rend sur l'hôte, pas dans la machine, parce que ce qui distingue un
jeton refusé au démarrage d'une panne du CLI est dans cette sortie et non dans
l'exception. `api_retry` ne voyait qu'une moitié du problème — un 401 pendant une
session, quand le CLI a démarré et parle à l'API. L'autre moitié, un jeton rejeté
avant qu'il n'y ait de session, est probablement la plus fréquente et était la
moins bien dite. Elle rend maintenant une erreur d'authentification, avec la
phrase actionnable, et n'est pas retentée sur une machine neuve où le jeton
serait tout aussi refusé.

Le jeton est masqué avant écriture. Rien ne garantit qu'un CLI n'imprime jamais
son environnement dans une trace, et ce message finit dans une interface, un
journal, et probablement un rapport de bogue.

## Alternatives écartées

**Tout faire tourner dans une fonction Vercel.** Le SDK a besoin de forker et
d'écrire ; `/tmp` et le traçage de fichiers rendaient la chose possible, pas
fiable. Essayé depuis, et ce n'est plus une question de fiabilité mais de
taille : le CLI n'est pas du JavaScript dans le paquet du SDK, c'est un
exécutable natif de trois cent dix mégaoctets livré par un paquet optionnel
propre à la plateforme. Trois limites s'y opposent — 250 Mo par fonction, 12
fonctions par déploiement en Hobby (les vingt-cinq routes de ce dépôt ne tiennent
qu'en étant fusionnées, ce que le binaire empêche), cinq minutes d'exécution — et
la tentative a fait refuser le déploiement entier, le site avec.

`inline` est donc **ignoré** en déploiement, et non seulement déconseillé.
`agentRuntime` le refuse et les diagnostics le disent. La différence a été payée
comptant : le message d'échec d'un bac à sable refusé recommandait `inline`, le
conseil a été suivi dans les réglages du projet, et les cent trente et une
questions du balayage suivant ont échoué sur « Native CLI binary for linux-x64
not found » sans qu'aucune n'atteigne un modèle. Un réglage qui ne peut mener
qu'à cela n'est pas un réglage. Depuis un déploiement, la voie pour un balayage
est le bouton « Réparations (production) » des Actions GitHub, qui tourne sur un
runner où aucune de ces limites n'existe.

**Un bac à sable par appel.** Une minute d'installation multipliée par trente
appels, contre huit à dix minutes de traitement utile.

**Un serveur HTTP dans le bac à sable.** Plus rapide pour les gros payloads
d'images, et il faudrait publier une URL joignable qui parle à Claude. Voir
ci-dessus.

**Garder l'API facturée en secours automatique.** C'est la demande explicite à
laquelle cet ADR répond par la négative : un échec bruyant est préférable à une
facture silencieuse.
