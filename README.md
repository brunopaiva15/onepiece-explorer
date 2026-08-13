# One Piece Explorer

[![CI](https://github.com/brunopaiva15/onepiece-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/brunopaiva15/onepiece-explorer/actions/workflows/ci.yml)

Un seul grand graphe de connaissances **interconnecté et sourcé**, construit à
partir des chapitres de One Piece que vous racontez vous-même : personnages,
groupes, lieux, objets, événements, promesses, mystères. C'est là qu'on trouve
les liens auxquels on n'avait pas pensé — un chemin entre deux personnages, une
récurrence, un recoupement à trois cents chapitres d'écart.

Chaque fait sait aussi **à quel chapitre vous avez pu l'apprendre**. Par défaut
vous voyez tout ce que vous avez importé ; le curseur sert à revenir en arrière
quand vous le voulez. Là, le graphe redevient ce que vous saviez alors : un
alias reste un alias tant que le vrai nom n'est pas révélé, deux silhouettes
restent deux nœuds tant que le chapitre qui les identifie n'est pas atteint,
une croyance réfutée reste visible dans le passé où elle était tenue pour vraie.

C'est ce qui rend le grand graphe sûr à construire pendant qu'on lit encore :
rien ne vous gâche la lecture, et rien n'est perdu non plus.

> **Outil privé.** L'application ne récupère un résumé que si vous le demandez,
> chapitre par chapitre, auprès de l'API publique d'un seul wiki dont l'adresse
> est codée en dur ; elle ne contourne aucune protection et ne publie rien. Le
> récit détaillé d'un chapitre — récupéré ou écrit par vous — est la seule
> source : ce qui n'y est pas écrit n'entre pas dans le graphe, même si le
> modèle le sait par ailleurs. Le dépôt ne contient aucune page de manga.

---

## Ce qui rend ce projet différent

**La frontière de chapitre est appliquée par la base de données, pas par le
code applicatif.** Une politique PostgreSQL de sécurité au niveau ligne filtre
chaque lecture selon `app.boundary_chapter`, posé par transaction. Un endpoint
oublié, une jointure trop large ou une requête écrite dans six mois ne *peuvent
pas* laisser fuir un fait futur — la base refuse. Voir
[ADR 0001](docs/adr/0001-chapter-boundary-in-the-database.md).

**Rien n'est écrasé.** Les connaissances sont des assertions en ajout seul,
avec deux axes temporels distincts : quand le fait est vrai dans l'histoire, et
quand le lecteur peut le savoir. Une correction insère une ligne et renseigne
`superseded_by`. Un déclencheur refuse toute autre modification.
Voir [ADR 0002](docs/adr/0002-append-only-assertions.md).

**Le modèle ne peut pas répondre de mémoire.** Un modèle entraîné connaît déjà
One Piece et compléterait volontiers les trous. Toute proposition doit citer un
passage de la liste fournie, et l'extrait cité doit réellement s'y trouver —
vérifié dans le code, puis à nouveau par un déclencheur de base de données. Ce
qui échoue part en quarantaine, visible dans le centre de revue. Voir
[ADR 0003](docs/adr/0003-evidence-anchoring.md).

**Un chapitre est un texte que vous écrivez.** Le pipeline lisait des fichiers :
découpe en cases, transcription, une description de modèle par case. Cent vingt
appels porteurs d'image et quatre dollars pour un chapitre, avec mille à faire.
Les pixels n'ont jamais été l'objet — ce dont l'extraction a besoin, c'est de
prose. Vous la fournissez directement, et l'ancrage se resserre au passage : la
comparaison ne porte plus sur de l'OCR approximatif mais sur exactement les
caractères que vous avez tapés. Voir
[ADR 0008](docs/adr/0008-the-chapter-is-a-text-you-write.md).

**Quand il ne sait pas, il demande.** La source peut être en anglais alors que
le graphe se lit en français. Tout ce que le modèle rédige est français ; seul
l'extrait cité garde la langue de la source, parce qu'une citation est une copie
vérifiée caractère par caractère. Et quand traduire un nom relève de la
convention plutôt que du texte — « Straw Hat Pirates » oui, « Going Merry »
peut-être pas — le modèle le déclare au lieu de trancher, l'entité part en revue
avec un champ modifiable, et votre réponse sert à tous les chapitres suivants.

Le chapitre peut être **récupéré depuis le One Piece Fandom** par son numéro :
les deux versions arrivent d'un coup, l'anglaise comme texte citable — c'est la
plus détaillée, et un graphe ne contient que ce que sa source affirme — et la
française en regard pour la forme française des noms
([ADR 0009](docs/adr/0009-fetching-the-chapter-from-the-wiki.md)).
Le champ accepte une URL par confort, mais aucune requête n'en est construite —
seuls ses chiffres sont lus, et les points d'entrée sont des constantes. Le texte
récupéré reste modifiable avant l'import, et l'écrire soi-même reste possible.

**Jusqu'à vingt chapitres d'un coup, traités un par un.** Un intervalle est
récupéré en une fois et vous le relisez en une fois ; en revanche le premier
chapitre seul démarre son traitement, et **chacun des suivants démarre à la
publication du précédent**. Ce n'est pas de la prudence : le rapprochement des
entités ne compare une proposition qu'à ce qui est déjà dans le graphe, et seule
une publication y met quelque chose. Les noms identiques se rejoindraient de
toute façon à la publication ; ce qu'un lot traité en parallèle perd, c'est tout
ce qui est plus faible qu'un nom exact — « l'homme au tablier de cuir » au
chapitre 12 et « Kaelo Renn » au 13 deviendraient deux entités, et la question
ne serait jamais posée. La file est visible sur `/import`, avec de quoi la
forcer ou l'abandonner ([ADR 0010](docs/adr/0010-a-batch-is-a-queue.md)).

Si vous avez le chapitre dans les deux langues, collez la seconde version au
même endroit : elle est fournie au modèle **pour les noms seulement**. La mise
en regard contient la réponse que ni l'un ni l'autre texte ne donne seul, donc
le modèle la lit au lieu de la deviner. Elle n'est jamais citable — un fait
qu'elle seule énoncerait n'entre pas dans le graphe, et une preuve qui la
citerait est mise en quarantaine comme n'importe quelle référence inventée.

---

## Installation

**Prérequis** : Node 22+, pnpm 10+, et un projet [Supabase](https://supabase.com)
(gratuit suffit).

```bash
pnpm install
cp .env.example .env.local   # puis renseignez les valeurs, voir ci-dessous
pnpm db:push                 # migrations, rôles, politiques RLS, ontologie
pnpm doctor                  # vérifie que tout répond vraiment
```

`pnpm doctor` se connecte réellement à chaque service et rapporte ce qu'il
obtient : les deux connexions Postgres, l'état des migrations, les rôles SQL,
la présence de pgvector, la confidentialité du bucket, et la joignabilité de
l'API Anthropic (par un comptage de tokens, gratuit). Deux contrôles y valident
une promesse plutôt qu'une connexion : que la RLS bloque effectivement une
lecture sans frontière, et que le bucket n'est pas public. Ces deux-là échouent
en silence autrement — l'application marcherait parfaitement tout en fuyant.
Aucun secret n'est affiché.

### Variables à renseigner

| Variable | Où la trouver |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | idem. Sert **uniquement** à l'authentification et aux URLs signées |
| `SUPABASE_SERVICE_ROLE_KEY` | idem. Serveur uniquement, jamais exposé au navigateur |
| `DATABASE_URL` | Connection string **Transaction pooler** (port 6543) |
| `DIRECT_URL` | Connection string **Direct** (port 5432) |
| `ANTHROPIC_API_KEY` | [console Anthropic](https://console.anthropic.com) |

Les deux connexions ne sont pas interchangeables. Les lectures applicatives
passent par le pooler en mode transaction (`prepare: false` obligatoire) ; les
migrations et le pipeline exigent la connexion directe.

**Où les mettre.** Dans `.env.local`, à la racine — ignoré par Git. Tout les
lit : l'application et les scripts (`db:push`, `doctor`, `demo`,
`images:enrich`…). L'ordre de priorité est celui de Next.js :

```
variable d'environnement réelle  >  .env.local  >  .env
```

Une variable déjà posée dans le shell gagne toujours, ce qui permet à
`TEST_DB=1 pnpm demo` de passer outre votre fichier, et à un hébergeur ou à la
CI de fournir les leurs sans fichier du tout. `.env` sert aux valeurs partagées
et sans secret ; `.env.local` aux secrets.

`pnpm doctor` dit lesquelles sont vues, et ne montre jamais une valeur.

### Bucket de stockage

Créez un bucket **privé** nommé `chapters` dans Supabase Storage. S'il est
public, les pages importées deviennent accessibles à quiconque devine une URL.

### Sans clé Anthropic

L'application démarre et le parcours reste exécutable : le pipeline bascule sur
un fournisseur synthétique et l'affiche par une bannière explicite. L'extraction
montrée est alors générée, pas réelle. C'est un mode de repli, pas le mode
nominal.

---

## Lancement

```bash
pnpm dev      # interface → http://localhost:3000
```

**Un seul processus.** L'import lance le traitement lui-même : vous collez le
chapitre, vous validez, et `/runs/[id]` montre les étapes défiler. Le travail
continue après le départ de la réponse, sur la même invocation, via `after()`.
Il n'y a ni file de jobs ni worker à penser à démarrer.

### Pourquoi c'était deux processus, et pourquoi ça ne l'est plus

Un chapitre lu à partir de pages dessinées, c'était environ cent vingt appels de
modèle porteurs d'image et huit à dix minutes — impossible dans un gestionnaire
de requête, donc une file de jobs et un worker. Un chapitre écrit, c'est une ou
deux extractions et quelques comparaisons d'identité : sous la minute le plus
souvent. La file coûtait alors plus qu'elle ne rapportait, et son absence
ressemblait à un bug applicatif.

Ce que ça abandonne, dit franchement : une invocation tuée au plafond de durée
de la plate-forme emporte le run, et rien ne le relance tout seul. C'est tenable
parce que `run_checkpoints` existe — une relance rejoue les tranches déjà payées
au lieu de les racheter, donc le prix du retry manquant est un clic, pas une
seconde facture.

---

## Le parcours, de l'import au graphe

```
/import          →  /runs/[id]        →  /review/[runId]   →  graphe
importer            suivre le pipeline    trancher            interroger
                    étape par étape       chaque proposition
```

**Rien n'entre dans le graphe sans votre accord.** Un traitement réussi laisse
le chapitre en état « à revoir », jamais « publié » : le pipeline produit des
propositions, pas du canon. C'est une contrainte du code, pas une convention —
un test vérifie que la table des assertions est encore vide après un traitement
réussi.

### Les deux garde-fous mécaniques

**Ancrage des preuves.** Toute proposition doit citer une référence de case ou
de bloc issue d'une liste blanche, et son extrait doit se retrouver dans le
texte réel de ce bloc. Sinon : quarantaine, jamais la file de revue. C'est ce
qui empêche le modèle de répondre depuis ce qu'il sait déjà de One Piece plutôt
que depuis vos pages. Ce que ce garde-fou arrête n'est pas un fait faux, c'est
un fait *plausible* : bien formé, citant une case d'apparence réelle, décrivant
quelque chose que vous n'avez pas encore lu.

**Texte du document = donnée.** Une page peut contenir une pancarte qui
ressemble à une consigne. Le texte des pages passe dans une enveloppe
`<untrusted_document_text>`, les appels d'extraction se font **sans outils**,
aucune URL trouvée dans un document n'est suivie — et de toute façon une
affirmation produite par une telle consigne n'aurait rien à quoi s'ancrer.

### La quarantaine est un diagnostic, pas une poubelle

Sa répartition se lit : trente rejets `unknown_ref` signalent un découpage en
cases qui a mal tourné ; trente `excerpt_not_in_source` signalent une
transcription trop dégradée pour que quoi que ce soit s'ancre. Les éléments en
quarantaine ne sont **jamais** proposables — les mettre devant quelqu'un en fin
de session de revue, avec une étiquette plausible et une citation d'apparence
réelle, est exactement la façon dont un fait fabriqué entre dans un graphe.

### Sans clé Anthropic

Le parcours complet reste exécutable. Le fournisseur synthétique ne réorganise
que ce qu'on lui donne : les noms propres de la couche texte du PDF, cités au
bloc dont ils viennent, en `related_to` et en `hypothetical` — la force exacte
de ce qu'il peut affirmer. Il refuse de lire une image plutôt que d'inventer un
dialogue, et répond « données insuffisantes » plutôt que de composer une prose
qu'il ne peut pas soutenir. L'interface le dit.

---

## Les visages

Un graphe de plusieurs centaines de nœuds où tout est du texte se lit mal : on
reconnaît un visage bien plus vite qu'on ne lit une étiquette. Trois catalogues
publics et gratuits fournissent les illustrations — onepieceapi.com,
api-onepiece.com et AniList — rapprochées de vos entités par leur nom.

```bash
pnpm images:catalogue   # récupère les ~1 000 illustrations disponibles, une fois
pnpm images:enrich      # rapproche, télécharge, range dans votre bucket privé
```

Ou le bouton dans `/reglages`, qui montre d'abord la couverture par type. En
temps normal vous n'aurez ni l'un ni l'autre à lancer : chaque chapitre ouvert
à la lecture illustre une quinzaine d'entités au passage, après la réponse. Une
illustration n'est pas une connaissance — elle ne demande pas de décision,
seulement un moment, et le moment évident est celui où le chapitre devient
lisible.

**Ce que les trois catalogues ne couvrent pas, le wiki le couvre.** Ils
connaissent les personnages célèbres, les Fruits du Démon répertoriés, seize
navires et trente et une îles — et rien d'autre. Le graphe, lui, est plein de
bars, de villages, d'équipages, d'espèces et de titres. Ceux-là sont demandés à
l'API du One Piece Fandom, un titre à la fois, **uniquement** pour ce que les
catalogues n'ont pas su placer : d'abord le wiki anglais, puis le français,
puisque le graphe est écrit en français et que beaucoup de noms propres
s'écrivent pareil des deux côtés.

Une fiche doit réellement exister sous ce titre — après redirection de page,
jamais une redirection vers une *section*. Une redirection vers une section est
le wiki qui dit qu'il n'a pas d'article pour cette chose, et MediaWiki
renverrait alors l'image de la page qui l'englobe : une photo d'autre chose,
légendée comme si c'était celle-ci. La branche « prendre quand même l'image
anglaise » existe dans la plupart des implémentations, augmente le taux de
réussite, et est exactement le signal faible que ce dépôt refuse partout
ailleurs.

Trois choses à savoir, et elles ne sont pas des détails.

**Une image n'est pas une source.** Elle ne prouve rien, aucune assertion ne
peut la citer, et elle vit dans sa propre table pour que la ligne ne s'efface
pas. La règle du projet — seul ce que vous avez importé fait foi — vaut toujours.

**Une image n'apparaît pas avant le nom qui l'a trouvée.** Au chapitre 1 un
personnage s'appelle « l'homme au tablier de cuir » et ne correspond à rien ; au
chapitre 3 l'histoire le nomme et il correspond. Le portrait apparaît au
chapitre 3, pas avant : sinon vous regarderiez un visage trouvé grâce à un nom
que vous n'avez pas encore. C'est la base qui l'applique, comme le reste.

**Un mauvais portrait serait pire que pas de portrait.** Une absence se lit
« pas trouvé » ; une erreur se lit « trouvé », et personne ne revérifie un visage
qu'il a accepté. Le rapprochement refuse donc tout signal faible, et la légende
dit toujours quel nom a trouvé l'image et dans quel catalogue.

Les fichiers sont recopiés dans votre bucket privé plutôt que chargés depuis
chez eux : trois tiers n'ont pas à savoir quels personnages vous consultez, et
une image ne doit pas casser le jour où un projet de fans déplace un bucket.

---

## Le mode histoire

```
/histoire   un fil, du chapitre 1 à celui où vous en êtes
```

Le reste de l'application vous demande où vous en êtes et vous montre ce
moment-là. Le mode histoire part du premier chapitre et avance quand vous
défilez — ce qui ressemble à une autre fonctionnalité et qui est exactement la
même : **le défilement est le curseur**, en train d'avancer.

C'est un fil, pas une suite de pages. Une ligne descend l'écran et se dessine
au fil du défilement ; dessus, une **perle** par chose qui arrive et une
**encoche** par chapitre :

```
│
●  ENTRE EN SCÈNE    l'homme au tablier de cuir · Personnage
│
●  SOUVENIR          La promesse du chapeau — environ dix ans plus tôt
│
├─ 3 ── LE CORBEAU
│
◉  UN NOM            l'homme au tablier de cuir → Kaelo Renn
│
●  ON NE CROIT PLUS  Kaelo Renn se trouve à Fuchsia · cru depuis le chapitre 1
│
◌  QUESTION          Qui a laissé la marque sur la coque ?
│
```

Un chapitre publié qui n'a rien produit est **une encoche et aucune perle**.
Aucun cas particulier n'a été écrit pour ça : c'est exactement ce que ça fait
de lire un chapitre de transition. Et il n'y a pas d'indicateur de progression,
parce que le fil en est un — la partie dessinée dit où vous en êtes.

Chaque chapitre y est lu **à sa propre frontière**, pas à la vôtre. Une fenêtre
qui couvre les chapitres 1 à 6 ouvre six frontières, une par chapitre, parce
qu'un nom révélé au chapitre 5 n'a rien à faire à côté du chapitre 1. La lire
une seule fois au chapitre 6 puis trier les perles en TypeScript coûterait six
fois moins cher et remettrait la seule garantie que ce produit vend dans du
code applicatif — l'inversion exacte que l'[ADR 0001](docs/adr/0001-chapter-boundary-in-the-database.md)
existe pour empêcher. La frontière reste donc dans la base, et le mode histoire
la paie : un aller-retour par chapitre, les chapitres d'une fenêtre étant lus
en parallèle puisqu'ils ne dépendent pas les uns des autres.

La seule chose qu'on ne peut pas lire au chapitre N, c'est ce que N **dément** :
une croyance fermée à N est invisible à N — c'est ce que la frontière veut dire
— donc les démentis viennent d'une seconde lecture, volontairement minuscule,
à N-1.

Les portraits n'ont besoin d'aucune logique supplémentaire : une illustration
porte le chapitre de révélation du **nom** qui l'a trouvée, donc elle apparaît
sur la perle où ce nom tombe et pas avant. Les visages arrivent en défilant
parce que la base refuse de les donner plus tôt.

**Rien n'est caché par défaut.** L'animation d'entrée vit dans un
`@supports (animation-timeline: view())`, et l'état non animé est l'état fini.
Un navigateur sans animations pilotées par le défilement, une feuille de style
qui ne charge pas, un lecteur qui a désactivé les animations : tous obtiennent
toute l'histoire, tout de suite. Un contenu qui commence à `opacity: 0` en
attendant un script est un contenu qui disparaît le jour où le script
disparaît.

Le curseur de la barre reste actif et veut dire ici quelque chose d'un peu
différent d'ailleurs : c'est là où le fil **s'arrête**. Posez-le sur 45 et
l'histoire court de 1 à 45.

---

## Ouvrir la lecture au public

Par défaut le site est privé : chaque page exige une connexion. Vous pouvez
ouvrir la **lecture** sans ouvrir l'écriture, en posant votre identifiant de
bibliothèque (affiché dans `/reglages`) :

```
PUBLIC_LIBRARY_OWNER_ID=<votre identifiant>
```

Ce qui devient public : le graphe, la chronologie, le mode histoire, les fiches
d'entité, la recherche, les mystères, les extraits de dialogue cités et leurs
références de chapitre, page et case. Un visiteur dispose du **curseur**, librement — c'est
tout l'intérêt de rendre ça public plutôt que de renvoyer vers un wiki : il le
pose où il en est de sa lecture et explore sans se faire gâcher la suite.

Ce qui ne le devient pas, et ne le deviendra pas : **les images de pages et de
cases**. Elles restent servies par une route authentifiée, à URL signée courte,
sous le préfixe de leur propriétaire. Publier le graphe, c'est ce que fait un
wiki de fans ; publier les scans serait de la redistribution, et le projet le
refuse depuis sa première ligne. Un visiteur voit la référence de la case et
l'extrait — de quoi vérifier dans son propre exemplaire.

Restent également à vous seul : l'import, la revue, la publication, la
suppression, l'export, l'enrichissement d'images et l'assistant — ce dernier
parce qu'un visiteur y dépenserait votre argent à la question.

Un identifiant absent ou mal formé est traité comme absent. Une faute de frappe
rend le site privé ; elle ne l'ouvre jamais à moitié.

---

## Chercher, et poser des questions

```
/recherche   plein texte · orthographe approchante · voisinage · sens
/ask         une question, une réponse sourcée — ou « données insuffisantes »
```

### La recherche dit comment elle a trouvé

Quatre modes, fusionnés par rang réciproque plutôt que par score : `ts_rank_cd`
et la similarité trigramme sont des grandeurs différentes sur des échelles
différentes, et les normaliser en un seul nombre produirait un classement qui a
l'air fondé et qui est arbitraire. Chaque résultat porte le mode qui l'a trouvé,
parce que « correspond à vos mots exacts » et « ressemble à ce que vous avez
tapé » ne méritent pas la même confiance.

Un mode qui n'a pas pu tourner le **dit**. La différence entre « votre
bibliothèque n'a pas la réponse » et « une façon de chercher n'a jamais eu lieu »
est toute la différence entre un résultat vide fiable et un résultat vide
trompeur.

### Le chemin entre deux entités

C'est ce qu'un graphe interconnecté permet et qu'un wiki ne permet pas : la
chaîne de relations la plus courte entre deux personnages, telle que vous la
connaissez à ce chapitre. Reculez le curseur et vous voyez à partir de quand le
lien existait.

Chaque relation compte pour un pas, sans pondération. La confiance serait le
choix tentant et il serait faux : une relation peu sûre n'est pas une connexion
plus *longue*, elle est moins certaine — confondre les deux ferait
silencieusement contourner au lecteur exactement les liens qu'il devrait
regarder.

### L'assistant est éteint par défaut

`/ask` se facture à la question, indéfiniment. Un explorateur de graphe n'a pas
besoin de ça, et une clé Anthropic posée pour que le pipeline lise vos pages ne
doit pas ouvrir en silence une boîte à compteur. L'interrupteur est donc
distinct : `ASSISTANT_ENABLED=1`, et rien d'autre ne l'allume.

La recherche cherche dans exactement les mêmes données, gratuitement, et vous
montre les extraits sans les reformuler.

### L'assistant ne peut pas répondre de mémoire

Trois mécanismes, dans cet ordre :

1. **Le contexte est filtré avant d'être assemblé.** Récupérer puis filtrer est
   l'ordre inverse et c'est ainsi que ces systèmes fuient. Ici tout passe par
   `withBoundary` : le modèle ne voit jamais une ligne qu'il pourrait divulguer.
2. **Sans contexte, aucun appel.** Demander à un modèle de répondre à partir de
   rien, c'est lui demander de répondre depuis son entraînement — et il le fera,
   avec aisance, sur des chapitres que vous n'avez pas ouverts.
3. **Chaque citation est vérifiée** contre ce qui était réellement dans le
   contexte, par identifiant. Une citation qui ne correspond à rien est retirée
   et signalée ; une réponse dont toutes les citations tombent devient « données
   insuffisantes », jamais une affirmation nue.

L'extrait affiché vient du contexte, pas de la réponse du modèle : citer un vrai
identifiant en paraphrasant la citation est l'échec le plus subtil ici, et le
lecteur doit voir ce que la page dit vraiment.

```bash
TEST_DB=1 pnpm eval:assistant
```

Trois scores : citations inventées, franchissements de frontière, réponses
malhonnêtes. Les questions du jeu incluent « Qui est le père de Luffy ? » — le
piège de connaissance externe le plus direct qui soit.

### Recherche sémantique

Anthropic n'expose pas d'endpoint d'embeddings. La recherche plein texte,
approchante et par graphe fonctionne sans aucune clé ni dépendance
supplémentaire ; la couche sémantique est enfichable derrière `VectorStore`.
Sans fournisseur, le magasin vectoriel **déclare** son indisponibilité au lieu
de renvoyer une liste vide — une liste vide affirmerait que rien ne correspond,
ce qui est une affirmation sur votre bibliothèque, et elle serait fausse.

---

## Quand ça ne démarre pas

`/etat` répond même quand tout le reste renvoie une erreur serveur : elle ne
dépend ni de la configuration validée, ni d'une session, ni du client Supabase,
et elle dit quelle variable manque sans jamais afficher une valeur.

Le piège du premier déploiement : `NEXT_PUBLIC_SUPABASE_URL` et
`NEXT_PUBLIC_SUPABASE_ANON_KEY` sont insérées dans le bundle **à la
compilation**. Les enregistrer chez l'hébergeur après coup ne suffit pas — il
faut redéployer.

---

## Tests

La suite tourne sur un PostgreSQL local et sur des réponses de modèle
enregistrées — hermétique, gratuite, déterministe. C'est ce qui permet aux
tests anti-spoiler d'être **bloquants** plutôt que « parfois rouges ».

```bash
# une seule fois : base de test locale
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/onepiece_explorer_test"
pnpm db:push:test

pnpm test              # unitaires + intégration
pnpm test:antispoiler  # les scénarios bloquants
pnpm test:perf         # 8 000 nœuds / 60 000 arêtes
pnpm typecheck && pnpm lint
```

Tout cela tourne sur GitHub Actions à chaque push sur `main` et à chaque pull
request — sans secret, sans clé API, sans réseau. C'est possible parce que la
suite a été construite hermétique dès le départ : PostgreSQL local plutôt que
Supabase, réponses de modèle enregistrées plutôt que l'API Anthropic, catalogue
d'images en fixture plutôt que trois services communautaires. Les scénarios
anti-spoiler tournent en premier et dans une étape à part : quand l'un d'eux
casse, ça doit se voir en haut du journal.

La base y est créée vide à chaque exécution, ce qui fait de la CI le contrôle
permanent que les migrations s'appliquent à partir de zéro — rôles, politiques
RLS et ontologie compris.

`pnpm db:push:test` crée la base si elle n'existe pas. pgvector n'étant pas
packagé pour PostgreSQL local, les embeddings basculent automatiquement sur
`real[]` avec cosinus en SQL ; sur Supabase, pgvector est utilisé.

Le parcours complet, sans navigateur et sans clé API :

```bash
pnpm demo
```

Trois chapitres synthétiques : import, pipeline, publication, puis le même
graphe lu depuis trois endroits de l'histoire. Si la frontière casse, les trois
lectures deviennent identiques et cela se voit dans la sortie. Le script vise
toujours la base de test — il importe des chapitres inventés et accepte tout
sans revue, ce qu'on ne veut pas voir arriver à sa vraie bibliothèque.

Il n'y a **pas** de tests de navigateur. Le parcours est couvert par `pnpm demo`
et par les tests d'intégration ; un harnais Playwright exigerait un projet
Supabase joignable, ce qui retirerait à la suite l'hermétisme qui permet aux
tests anti-spoiler d'être bloquants.

---

## Structure

```
drizzle/            migrations SQL écrites à la main (rôles, RLS, déclencheurs)
docs/adr/           décisions d'architecture et leurs raisons
src/db/             client, schéma Drizzle, et withBoundary()
src/domains/        ingestion · documents · knowledge · resolution · review
                    temporal · search · assistant · viz · auth · storage · ai
tests/antispoiler/  les scénarios bloquants
scripts/            migrations, fixtures, démonstration
```

### La règle à ne pas contourner

Toute lecture de connaissance passe par `withBoundary()`. Rien d'autre
n'obtient de connexion à la base. Une règle ESLint le vérifie, et
`tests/antispoiler/boundary-guards.test.ts` le vérifie aussi — parce qu'une
règle de lint peut être désactivée en ligne, et que ce mécanisme est la
garantie centrale du produit.

```ts
const graphe = await withBoundary(
  { userId, boundaryChapter: 42 },
  (db) => db.select().from(assertions),
)
// Ce qui a été révélé au chapitre 43 n'est pas dans le résultat.
// Pas filtré ensuite : absent.
```

---

## Documentation

- [Décisions d'architecture](docs/adr/) — pourquoi la frontière est en base,
  pourquoi les assertions sont immuables, pourquoi l'ontologie est une donnée,
  comment le coût IA est maîtrisé
- [Illustrations externes](docs/adr/0007-external-illustrations.md) — pourquoi
  une image n'est jamais une source, et pourquoi elle attend son nom
- [Un lot est une file](docs/adr/0010-a-batch-is-a-queue.md) — pourquoi dix
  chapitres s'importent ensemble et se traitent un par un
- [Importer depuis votre machine](docs/importer-en-local.md) — la marche à
  suivre complète quand l'application est hébergée ailleurs
- [Exploitation](docs/operations.md) — déployer, surveiller, sauvegarder,
  purger, et le tableau des pannes courantes avec leur diagnostic
- [Critères d'acceptation](docs/acceptance-criteria.md) — dont les huit
  scénarios anti-spoiler bloquants, et ce qui reste explicitement non fait
- [Ontologie v0](src/domains/knowledge/ontology.ts) — types de nœuds et
  prédicats, source de vérité du seed
