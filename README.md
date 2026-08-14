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

> **Un atelier privé, un site public.** L'application ne récupère un résumé que
> si vous le demandez, chapitre par chapitre, auprès de l'API publique d'un seul
> wiki dont l'adresse est codée en dur ; elle ne contourne aucune protection. Le
> récit détaillé d'un chapitre — récupéré ou écrit par vous — est la seule
> source : ce qui n'y est pas écrit n'entre pas dans le graphe, même si le
> modèle le sait par ailleurs. Ce qui est publié, c'est le graphe : des faits,
> des relations et des références de chapitre, sourcés (One Piece Wiki / Fandom,
> CC BY-SA 3.0) et attribués en pied de page. Jamais les planches — le dépôt ne
> contient aucune page de manga, et le site n'en sert aucune.

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

**Et un nom se corrige après coup.** Helmeppo s'appelle Hermep en français :
aucun chapitre ne le dit, c'est une convention que vous tenez, et le seul moment
pour la dire était la revue de l'entité — manquée là, la mauvaise forme était
définitive, sur la fiche comme sur chaque arête. La fiche porte donc un bouton
« Renommer », et ce qu'il fait tient en trois refus. Le **chapitre de révélation
ne bouge pas** : c'est le même nom, mieux écrit, et le dater d'aujourd'hui
ouvrirait dans le curseur un trou où le personnage n'aurait pas eu de nom.
L'ancienne graphie **reste trouvable sans jamais s'afficher** — les catalogues
d'illustrations et les scans sont en anglais, et c'est par « Helmeppo » que le
portrait a été rapproché. Et la correction **entre au glossaire**, pour la
formulation source du même nœud aussi, qui est ce qu'un chapitre suivant
contiendra : la question ne se repose pas, et les deux formes ne finissent pas
en deux entités. Enfin la correction **ne s'arrête pas au libellé** : un
événement est nommé par son propre résumé et un mystère par sa question — de la
prose où le nom est écrit en toutes lettres —, donc les phrases suivent, mots
entiers seulement. Le texte du chapitre, lui, n'est jamais retouché : c'est ce
que la source dit, et c'est ce à quoi les preuves s'ancrent.

Et quand un chapitre ultérieur a reproposé l'ancienne graphie comme second nom,
la corriger à son tour **réunit les deux lignes** au lieu d'objecter qu'un nom
identique existe déjà : la survivante garde la plus forte précédence de la paire
— un affichage que vous avez choisi n'est pas rétrogradé par une fusion — et la
plus ancienne révélation, parce que l'entité portait bien ce nom à ce
chapitre-là, mal orthographié.

**Apparaître n'est pas être nommé.** Le chapitre 1 montre trois pirates de
l'équipage du Roux sans en nommer un seul : deux ne le sont que dans le SBS du
tome 5, le troisième au chapitre 25, et le maire du village jamais — son nom
vient d'un databook, que rien ne rattache à un chapitre. Le graphe datait déjà
un nom ; ce qu'il ne savait pas dire, c'est qu'un nom puisse n'avoir **aucune
date**, et le seul moyen de le ranger était de lui en inventer une. Un libellé
porte donc aussi sa **provenance** — « SBS du tome 5 », « databook » — et son
chapitre de révélation peut être vide, ce qui ne veut pas dire « on ne sait pas
quand » mais « aucun chapitre ne le donne » : la politique de frontière le
retient alors partout, et la fiche s'en tient à la désignation que le lecteur a,
« Maire du village de Fuchsia », jusqu'au jour où le manga le nomme lui-même. Le
nœud, lui, ne bouge pas, et les liens continuent de pointer vers la même entité
— c'est le texte affiché qui dépend du chapitre. La relecture du chapitre 1 est
dans `pnpm repair:chapitre-1` ; comme les autres scripts de réparation, elle se
lance d'abord en `--dry-run`, qui dit tout et n'écrit rien.

**Et un type se corrige aussi.** Le Bara Bara no Mi est un fruit : il se mange,
il se vole, il se transporte — et le graphe le rangeait en « Pouvoir », juste à
côté du Bara Bara no Hou, qui est la technique qu'il donne. L'ontologie le
disait elle-même, dans la description remise au modèle ; elle dit désormais
qu'un fruit du démon est un objet et qu'un pouvoir est ce qu'il confère. Pour ce
qui est déjà publié, la fiche porte un bouton « Changer le type », et les
réglages reclassent d'un coup toutes les entités dont le nom finit par « no Mi ».
Le type est une propriété de la chose, donc le changement suit toute la
composante d'identité quel que soit le curseur : deux moitiés d'une même entité
ne peuvent pas être en désaccord sur ce qu'elle est. Ce qu'il ne fait jamais,
c'est trancher à votre place. L'ontologie type les deux bouts de chaque relation
et la base ne le vérifie qu'à l'insertion, donc un changement de type peut
laisser derrière lui des faits qu'elle n'aurait jamais acceptés : ils sont
cherchés, montrés, et **rien n'est écrit tant que vous ne les avez pas lus** ;
confirmés, ils sont rejetés plutôt que supprimés, lignes et preuves intactes. Et
un nœud qui porte un résumé d'événement ou la question d'un mystère est refusé
plutôt que cascadé — personne n'a demandé la suppression d'une phrase.

**Et un fait se corrige, ou se retire.** « Baggy appartient à l'Équipage du
Roux », affirmé au chapitre 19, sur cette preuve : « He has a flashback about
their time as fellow pirates ». Les deux étaient mousses sur le navire de
Roger ; l'équipage de Shanks n'existe pas encore et Baggy n'en sera jamais.
Aucun garde-fou n'avait de prise — le prédicat prend un groupe, l'objet est un
groupe, l'extrait est ancré mot pour mot — et la fiche l'imprimait dans la même
typographie que tout ce qui est vrai. Chaque fait du relevé porte donc un bouton
« Corriger », qui offre les trois façons dont un fait est faux : **la relation**,
choisie parmi les seules que l'ontologie accepte entre ces deux types ; **l'autre
bout**, cherché — jamais tapé — parmi ce que vous avez lu jusqu'au curseur ; et
**le texte**, pour un fait qui porte une valeur plutôt qu'un nœud. Rien n'est
modifié sur place : la correction est une **nouvelle ligne** qui reprend la
preuve et le chapitre de révélation de l'ancienne — corriger ce qu'un fait dit
ne déplace pas le moment où vous pouviez l'apprendre — pendant que l'ancienne
survit, marquée remplacée, et disparaît de toutes les lectures d'un seul coup.
Elle est écrite comme vôtre et **verrouillée** : un réimport du chapitre ne peut
pas la défaire, et la décision est classée sous l'empreinte de la proposition
d'origine, donc la question ne se repose pas.

Et quand rien n'est presque juste — au chapitre 19 l'Équipage de Roger n'est pas
encore un nœud, il n'y a aucune bonne cible — la réponse est « ce fait est
faux ». Il est **rejeté, pas supprimé** : la ligne, sa preuve et sa provenance
restent en base, avec son identifiant au journal d'audit, et la phrase cesse
simplement d'être affirmée partout à la fois — fiche, graphe, recherche,
chronologie. Le bouton demande deux fois, parce que la fiche n'a ensuite plus
rien à vous reproposer.

**Et une fiche se lit par ce qu'elle est.** Elle ouvrait sur « Ce que l'on
sait » : tous les faits, dans l'ordre des chapitres, la famille entre un
déplacement et une mention. Personne ne lit un personnage comme ça — on demande
sa famille, son équipage, qui il a affronté, où il est passé. Les mêmes faits
sont donc rangés en sections **qui dépendent du type du nœud** : un équipage
ouvre sur ses membres et son capitaine, un lieu sur la mer dont il fait partie
et sur qui s'y trouve, un fruit sur le pouvoir qu'il confère, un mystère sur ce
qui l'a ouvert. Une section vide n'a pas de titre, et un fait qu'aucune section
ne réclame tombe dans « Autres faits » plutôt que de disparaître — un test
énumère toutes les relations que l'ontologie autorise, type par type, pour
qu'aucune n'y échoue par oubli.

**Une ligne par personne, pas par fait.** L'unité d'une section est de qui elle
parle : « a rencontré Zoro », « protège Zoro » et « connaît Zoro » étaient trois
lignes qui comptaient trois et disaient une chose, et une fiche un peu fournie
affichait quarante-deux lignes pour une quinzaine de personnes. Les rôles se
rassemblent donc sous le nom, chacun avec **son** chapitre — rencontré au 3,
protégé au 11 sont deux moments — et **son** statut : le trait de couleur prend
le plus fort des rôles, donc c'est à chaque rôle de dire s'il n'est qu'une
déduction. Une certitude ne se prête pas d'un fait à l'autre.

Ce n'est qu'un résumé, et il ne se permet d'être court que parce que le relevé
est sur la même page, replié dessous : chaque fait, son chapitre, son statut et
la case qui le prouve, exactement comme avant. Chaque rôle y renvoie, au fait
qui le prouve, et le déplie au passage. Deux relations manquaient pour
que tout cela ait un sens : un lieu **fait partie d'un lieu** — un village dans
une île, une île dans une mer — et un objet **confère un pouvoir**, ce que
l'ontologie distinguait déjà sans pouvoir le relier.

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
ne serait jamais posée. La file est visible sur `/admin/import`, avec de quoi la
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
chapitre, vous validez, et `/admin/runs/[id]` montre les étapes défiler. Le travail
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
/admin/import  →  /admin/runs/[id]  →  /admin/review/[runId]  →  graphe public
importer          suivre le pipeline   trancher                  interroger
                  étape par étape      chaque proposition
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

Ou le bouton dans `/admin/reglages`, qui montre d'abord la couverture par type. En
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

**Et pas un visage d'après l'ellipse.** Entre la fin du chapitre 597 et le début
du 598 il se passe deux ans, et ce qui revient n'est pas un relookage : c'est la
conséquence de l'arc précédent. Or l'image en haut d'une fiche de wiki est
toujours la plus récente — pour Nami, Luffy, Zoro, Vivi ou Koby, c'est celle
d'après. Une image porte donc désormais la période qu'elle montre, lue dans le
nom de fichier du wiki (`Nami_Manga_Pre_Timeskip_Infobox.png`), et la base
refuse un visage d'après l'ellipse tant que vous n'avez pas atteint le
chapitre 598. Une image sans date — c'est le cas de tout ce qui vient des trois
catalogues — reste servie des deux côtés : « inconnu » n'est pas « après », et
masquer par précaution viderait le graphe de ses visages sur une supposition.
Voir `docs/adr/0011-a-portrait-carries-the-period-it-shows.md`.

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

### Le fil se regarde aussi

**« Voir en animation »**, au-dessus du fil, le déroule tout seul : un carton
de chapitre, puis les perles de ce chapitre une par une, plein écran, les
visages en grand et la ligne dessous. Les mêmes perles, dans le même ordre, à
la même frontière — c'est le fil, joué.

```
 ┌──────┐ ┌──────┐ ┌──────┐     trois visages, parce que la phrase
 │      │ │      │ │      │     en nomme trois
 └──────┘ └──────┘ └──────┘
 ╭──────────────────────────╮
 │        IL ARRIVE         │
 │  Shanks sauve Luffy et   │
 │  perd son bras gauche.   │
 │  onepieceapi.com · « Shanks », « Luffy »
 ╰──────────────────────────╯
 ▁▁▁▁▁▁▁▁▁▁░░░░░░░░░░░░░░░░░░
 CHAPITRE 1   ◀ ⏸ ▶   lent normal rapide   fermer
```

Une phrase d'événement porte jusqu'à **trois** visages : ceux que le fil
marque déjà en vignette dans la ligne. C'est ce qui rapproche le film d'une
planche — « Shanks sauve Luffy » se joue comme deux portraits et cette phrase,
au lieu d'un mur de texte entre deux noms.

Il n'y a **pas de second chemin vers les données** : le film rejoue le tableau
de perles que le défilement a chargé, et redemande la fenêtre suivante par le
même chargeur. Il ne peut donc pas atteindre une perle que le défilement
n'atteindrait pas, et la frontière n'a rien de neuf à garder. Ce qu'il coupe
est écrit : la queue repliée d'un chapitre — cinq événements sont ce dont le
chapitre parle, la suite est un relevé — et une perle dont la ligne est vide.

Le mouvement n'est jamais porteur. Le panoramique est une décoration sur une
image déjà affichée, il dure exactement le temps du plan, et
`prefers-reduced-motion` le supprime sans rien changer aux durées. La barre du
bas ne se cache jamais : pause, pas à pas, vitesse, Échap. Et la provenance
monte en plein écran avec le reste — un visage montré grand est ce qui
ressemble le plus à un résultat du pipeline, alors qu'il vient d'un catalogue
et d'un nom.

---

## La chronologie, ou l'autre axe

Le mode histoire répond à « qu'ai-je appris, et dans quel ordre ». La
chronologie répond à « quand est-ce arrivé ». Un souvenir remonte donc à sa
place, loin du chapitre qui le montre.

Cette page a longtemps affiché « aucun événement n'a de position connue dans le
temps de l'histoire », et bouger le curseur n'y changeait rien : elle triait sur
`events.story_time`, une colonne présente depuis la première migration **que
rien n'écrivait jamais**. Aucun champ d'extraction ne demandait quand une scène
se passe, donc la colonne était vide dans toutes les bibliothèques. La page
disait la vérité sur un champ qui n'existait pas en pratique.

L'extraction pose la question maintenant, et n'accepte la réponse que si le
chapitre peut être **cité** pour elle. Une datation porte la phrase du chapitre
qui la donne, et cette phrase doit se retrouver dans l'un des blocs que la scène
cite déjà en preuve — même règle que n'importe quelle autre citation
([ADR 0003](docs/adr/0003-evidence-anchoring.md)). C'est indispensable et pas
décoratif : un modèle à qui l'on demande quand Ohara a brûlé le sait, et
répondrait de mémoire. Une bonne réponse obtenue de la mauvaise manière est
exactement l'échec que ce projet existe pour empêcher. Une datation non prouvée
est refusée **et la scène reste** : c'est la date qui n'est pas établie, pas
l'événement, et le refus part en quarantaine plutôt que d'être effacé.

Ne convertissez rien, ne calculez rien : « il y a longtemps » reste « il y a
longtemps ». Aucun calendrier n'est importé d'ailleurs pour transformer ça en
année, parce qu'il n'y en a pas dans vos chapitres.

L'axe repose donc sur trois signaux, et pas seulement sur le premier :

1. **une distance datée**, quand un chapitre en donne une ;
2. **`is_flashback`**, enregistré depuis toujours, qui dit *avant maintenant*
   sans dire de combien ;
3. **le chapitre qui le raconte**, qui ordonne tout le reste.

Le deuxième est celui qui rend la page utile tout de suite : un souvenir dont
personne n'a chiffré la distance est quand même avant le présent, et le dire est
plus vrai que le jeter dans « position inconnue ».

**Le curseur ne s'y applique pas**, et c'est le seul endroit du site où c'est le
cas. La frontière n'est pas contournée — elle est interrogée au plafond de la
bibliothèque au lieu de la position du lecteur, ce qui est la même politique avec
un autre argument. Rien qui ne soit pas dans vos chapitres importés ne peut
apparaître, à aucun plafond. La raison est structurelle : c'est presque toujours
un chapitre tardif qui date une scène ancienne, donc une chronologie tronquée à
votre curseur est une chronologie amputée de précisément ce pour quoi elle
existe.

Les chapitres publiés avant que l'extraction ne pose la question n'ont pas de
datation. Les retraiter en ajoute ; sans cela ils restent classés par les deux
autres signaux.

---

## Le site public et l'atelier

Une seule règle, portée par l'URL : **tout ce qui est sous `/admin` est à vous,
tout le reste est public.**

```
public                       /admin (connexion requise)
──────────────────────       ───────────────────────────
/                accueil     /admin            poste de commandement
/histoire        le fil      /admin/connexion  entrer
/graph           le réseau   /admin/import     importer un chapitre
/chronologie     quand       /admin/chapitres  la bibliothèque, brute
/mysteres        ouvert /    /admin/runs/[id]  suivre un traitement
                 résolu      /admin/review/…   trancher les propositions
/recherche       chercher    /admin/reglages   coûts, santé, export
/entite/[id]     une fiche   /admin/ask        l'assistant, à la question
/delta/[n]       un chapitre /admin/etat       diagnostic de déploiement
/mentions-legales sources
```

Ce qui est public : le graphe, la chronologie, le mode histoire, les fiches
d'entité, la recherche, les mystères, les extraits de dialogue cités et leurs
références de chapitre, page et case. Un visiteur dispose du **curseur**,
librement — c'est tout l'intérêt de publier ça plutôt que de renvoyer vers un
wiki : il le pose où il en est de sa lecture et explore sans se faire gâcher la
suite.

Ce qui ne l'est pas, et ne le deviendra pas : **les images de pages et de
cases**. Elles restent servies par une route authentifiée, à URL signée courte,
sous le préfixe de leur propriétaire. Publier le graphe, c'est ce que fait un
wiki de fans ; publier les scans serait de la redistribution, et le projet le
refuse depuis sa première ligne. Un visiteur voit la référence de la case et
l'extrait — de quoi vérifier dans son propre exemplaire.

Restent également à vous seul : l'import, la revue, la publication, la
suppression, l'export, l'enrichissement d'images et l'assistant — ce dernier
parce qu'un visiteur y dépenserait votre argent à la question.

Une route ajoutée sous `/admin` est privée sans que personne ait à y penser ;
une page ajoutée ailleurs est privée aussi, jusqu'à être inscrite explicitement
dans la liste de lecture de `src/proxy.ts`. Les deux défauts vont dans le sens
sûr.

### Quelle bibliothèque le site public montre-t-il ?

Celle de l'installation, résolue toute seule tant qu'il n'y en a qu'une — le cas
de presque tous les déploiements, et rien à configurer. Dès qu'il existe
plusieurs comptes, désignez celle à publier :

```
PUBLIC_LIBRARY_OWNER_ID=<votre identifiant>   # affiché dans /admin/reglages
```

Plusieurs bibliothèques et aucune variable : rien n'est publié. Deviner laquelle
reviendrait à publier la lecture de quelqu'un d'autre. Une valeur mal formée est
traitée comme absente, et un identifiant qui ne correspond à rien donne un site
vide plutôt qu'un repli sur la première venue.

### Sources et droits

Le pied de page porte l'attribution sur **toutes** les pages, et
`/mentions-legales` en donne la version longue : le contenu textuel s'appuie sur
le One Piece Wiki (Fandom), sous licence CC BY-SA 3.0 ; les éléments visuels
issus de ONE PIECE appartiennent à leurs ayants droit (© Eiichiro Oda/Shueisha,
Toei Animation) ; et le projet est non officiel, sans lien avec Eiichiro Oda,
Shueisha ou Toei Animation.

---

## Chercher, et poser des questions

```
/recherche     plein texte · orthographe approchante · voisinage · sens
/admin/ask     une question, une réponse sourcée — ou « données insuffisantes »
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

`/admin/ask` se facture à la question, indéfiniment. Un explorateur de graphe n'a pas
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

`/admin/etat` répond même quand tout le reste renvoie une erreur serveur : elle ne
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
- [Une illustration porte sa période](docs/adr/0011-a-portrait-carries-the-period-it-shows.md)
  — pourquoi le visage d'après l'ellipse attend le chapitre 598
- [Importer depuis votre machine](docs/importer-en-local.md) — la marche à
  suivre complète quand l'application est hébergée ailleurs
- [Exploitation](docs/operations.md) — déployer, surveiller, sauvegarder,
  purger, et le tableau des pannes courantes avec leur diagnostic
- [Critères d'acceptation](docs/acceptance-criteria.md) — dont les huit
  scénarios anti-spoiler bloquants, et ce qui reste explicitement non fait
- [Ontologie v0](src/domains/knowledge/ontology.ts) — types de nœuds et
  prédicats, source de vérité du seed
