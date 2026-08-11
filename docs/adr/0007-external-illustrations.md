# ADR 0007 — Les illustrations viennent de l'extérieur, la connaissance non

**Statut** : accepté · **Date** : 2026-08-11

## Contexte

Un graphe de plusieurs centaines de nœuds où tout est du texte est difficile à
lire. On reconnaît un visage bien plus vite qu'on ne lit une étiquette, et
« l'homme au tablier de cuir » ne se distingue pas de « la silhouette au
foulard » d'un coup d'œil.

Mais ce projet repose sur une règle : **seul ce que vous avez importé fait
foi**. Tout le reste de l'architecture existe pour la tenir — l'ancrage des
preuves, la revue humaine, la frontière appliquée par la base. Aller chercher
des images chez des tiers est la première chose que cette application fait qui
ne vient pas de vos pages.

Trois API gratuites couvrent le besoin, mesurées le 2026-08-11 :

| Source | Contenu | Images |
|---|---|---|
| onepieceapi.com | 369 personnages, 94 fruits, 16 navires, 31 îles, 188 primes | toutes, plus le chapitre de première apparition sur 353 entrées |
| api-onepiece.com | 786 personnages, 213 fruits, 149 équipages, 128 lieux, 50 arcs | 23 fruits seulement — le champ existe sur 213 lignes, la valeur sur 23 |
| AniList | 500 personnages One Piece | toutes |

## Décision

**Une image est une illustration, jamais une source.** Elle vit dans sa propre
table, `entity_images`, et non dans une colonne d'`entities`. Aucune assertion
ne peut la citer, aucun fait ne repose dessus, et un test le vérifie :
l'enrichissement n'écrit ni assertion ni preuve.

**La frontière s'applique — sur la colonne qui n'est pas l'évidente.** Le
réflexe serait de filtrer sur `first_seen_chapter` de l'entité, ce que la
politique d'`entities` fait déjà. La vraie fuite est ailleurs : une image est
trouvée en rapprochant un **libellé** d'un catalogue. Au chapitre 1 un
personnage s'appelle « l'homme au tablier de cuir » et ne correspond à rien ; au
chapitre 3 l'histoire le nomme et il correspond soudain. Afficher ce portrait
dès le chapitre 1 mettrait sous les yeux du lecteur un visage trouvé *grâce à*
un nom qu'il n'a pas encore.

Donc `revealed_in_chapter` porte le chapitre de révélation du **libellé qui a
fait le rapprochement**. L'image apparaît exactement quand le nom qui la trouve
apparaît.

**Aucun rapprochement silencieux sur un signal faible.** Nom identique, mêmes
mots dans un autre ordre, nom partiel non ambigu, orthographe proche avec une
marge sur le deuxième candidat — et rien en dessous. Un mauvais portrait est
pire qu'aucun portrait : une absence se lit comme « pas trouvé », une erreur se
lit comme « trouvé », et personne ne revérifie un visage qu'il a accepté. Le
catalogue contient réellement un « Faux Zoro » ; c'est le cas d'école.

**Les fichiers sont recopiés, pas pointés.** Le lien direct serait plus simple
et faux trois fois : trois tiers apprendraient quels personnages vous consultez,
les images casseraient le jour où un projet déplace un bucket, et elles
arriveraient par des URLs que cette application ne peut pas faire expirer. Les
octets sont téléchargés une fois, convertis en WebP, débarrassés de leurs
métadonnées, et écrits dans le même bucket privé que vos pages — accessibles
uniquement par la route authentifiée, par URL signée de courte durée.

**La légende dit d'où vient l'image et quel nom l'a trouvée.** Un rapprochement
par nom est une supposition, très bonne à 1,0, raisonnable à 0,7. Un visage
affiché sans le dire se lirait comme un résultat du pipeline. Il ne l'est pas.

## Conséquences

Le graphe devient lisible d'un coup d'œil, et la fiche d'entité s'ouvre sur un
portrait. Le taux de rapprochement mesuré sur cinquante personnages
emblématiques est de 50/50, 10/10 sur les fruits, 5/5 sur les navires, 12/14 sur
les lieux — les deux manques sont des trous du catalogue, pas du rapprochement.

Une entité sans image reste parfaitement utilisable : rien dans l'interface ne
dépend d'un portrait.

Sur le droit : ce sont des visuels One Piece hébergés par des projets de fans.
L'outil est privé, mono-compte, sans redistribution, et les images ne quittent
jamais un bucket privé ni ne passent par une URL publique permanente — les mêmes
règles que vos scans. L'URL d'origine et l'attribution sont conservées avec
chaque image, et l'export les emporte en métadonnées sans emporter les octets.

## Alternatives écartées

**Peupler le graphe depuis les API.** Elles savent bien plus que les images :
équipages, arcs, primes, relations. Le prendre reviendrait à abandonner la règle
fondatrice pour un gain de contenu, et à mettre dans le graphe des faits que
personne n'a lus dans un chapitre. Les API illustrent ; elles n'enseignent pas.

**Le wiki Fandom via son API MediaWiki.** Couverture bien supérieure. Écarté :
pas de champ image structuré, du parsing HTML fragile, et des conditions
d'utilisation nettement moins claires que celles de trois API JSON publiques.

**Rendre les images sur les nœuds du graphe** (`@sigma/node-image`). Une
dépendance de plus et un coût de rendu proportionnel au nombre de nœuds, pour
8 000 d'entre eux. Remplacé par une carte au survol, qui montre le visage sans
rien changer au budget de rendu mesuré en phase 5.
