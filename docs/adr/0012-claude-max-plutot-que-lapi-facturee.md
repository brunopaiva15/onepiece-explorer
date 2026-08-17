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
| `inline` | sous-processus de ce processus | machine de développement |
| `sandbox` | microVM Vercel Sandbox | déploiement serverless |

`CLAUDE_AGENT_RUNTIME=auto` choisit d'après l'hôte. Le payload envoyé est
construit au même endroit pour les deux (`agentPayload`) : les deux runtimes ne
peuvent pas diverger sur ce qui est demandé, seulement sur l'endroit où c'est
exécuté.

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

## Alternatives écartées

**Tout faire tourner dans une fonction Vercel.** Le SDK a besoin de forker et
d'écrire ; `/tmp` et le traçage de fichiers rendent la chose possible, pas
fiable. Le mode `inline` existe et est configurable pour qui veut essayer ; ce
n'est pas le défaut en déploiement.

**Un bac à sable par appel.** Une minute d'installation multipliée par trente
appels, contre huit à dix minutes de traitement utile.

**Un serveur HTTP dans le bac à sable.** Plus rapide pour les gros payloads
d'images, et il faudrait publier une URL joignable qui parle à Claude. Voir
ci-dessus.

**Garder l'API facturée en secours automatique.** C'est la demande explicite à
laquelle cet ADR répond par la négative : un échec bruyant est préférable à une
facture silencieuse.
