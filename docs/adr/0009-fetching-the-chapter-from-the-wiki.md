# ADR 0009 — Récupérer le chapitre depuis le wiki

**Statut :** accepté · **Date :** 2026-08-12 · **Renverse :** une alternative
écartée de l'ADR 0008.

## Contexte

L'ADR 0008 a fait du chapitre « un texte que vous écrivez », et a écarté
explicitement une alternative : « Récupérer les résumés automatiquement en
ligne — exclu par la contrainte du projet : aucun scraping, rien de téléchargé
automatiquement. L'utilisateur colle ce qu'il a lu. »

Cette contrainte a tenu jusqu'à la rencontre avec l'échelle réelle. Le pipeline
demande un récit détaillé par chapitre, et depuis la migration 0017 il en veut
deux — un par langue, pour que la forme française des noms se lise au lieu de se
deviner. Il y a plus de mille chapitres. Deux collages manuels par chapitre,
c'est le coût dominant du produit, et c'est un coût qui ne produit rien : le
texte existe déjà, écrit par d'autres, sous une API publique.

## Décision

**Un chapitre peut être récupéré depuis le One Piece Fandom, par son numéro.**
Les deux versions sont demandées à l'API MediaWiki — section « Long Summary » sur
le wiki anglais, « Résumé approfondi » sur le français. **L'anglaise devient les
passages citables, la française le texte parallèle** (0017). Écrire soi-même
reste possible, replié dans le formulaire.

Cet ordre est l'inverse de l'intuition pour un graphe qui se lit en français, et
il tient à ce que chacun des deux textes est réellement. Le « Long Summary »
anglais est le récit détaillé ; le « Résumé approfondi » français est plus court
là où il existe, et un graphe ne contient jamais que ce que son texte citable
affirme — une source plus maigre donne un graphe plus maigre, chapitre après
chapitre, et aucune revue ne rattrape un fait que la source n'a pas mentionné.
Le texte français vaut davantage comme aide au nommage : ce qu'il porte
d'unique, c'est la **convention** — comment un lecteur français rend « Straw Hat
Pirates » — et c'est précisément la question qu'un texte anglais ne peut pas
trancher. Les citations sont donc en anglais, ce que l'ADR 0008 avait déjà
accepté : une citation est une copie vérifiée caractère par caractère, la
traduire la ferait ne correspondre à rien. Tout ce que le modèle rédige reste
français.

## Les notes de chapitre, ajoutées au texte citable

Une page de chapitre porte une seconde chose que le récit détaillé ne contient
pas : « Quick Reference → Chapter Notes », « Informations → Notes ». Une dizaine
de lignes plates — qui apparaît pour la première fois, ce qu'une scène établit,
et surtout ce que le récit dilue en trois phrases de drame. « Arlong kills
Bell-mère » est une ligne des notes du chapitre 78 ; aucune phrase de son « Long
Summary » ne le dit aussi nettement.

**Elles sont ajoutées au texte citable, à la suite du récit.** C'est la
conséquence directe de la règle qui gouverne tout le reste : un graphe ne
contient que ce que son texte citable affirme. Stockées ailleurs — une colonne à
part, un contexte donné au modèle —, elles seraient des faits que le relecteur
peut lire et que le pipeline ne peut pas proposer, ce qui est la pire des deux
places. Elles sont découpées en passages comme le reste, et une proposition
devra en citer une mot pour mot.

**Aucune ligne de notre invention ne les précède.** Pas de « Notes du
chapitre : » inséré entre les deux sections, parce qu'une citation doit toujours
tomber sur du texte que le wiki a écrit ; ce qu'un intertitre aurait apporté —
savoir où commencent les notes — est apporté par le formulaire, qui les compte
avant l'import.

**La section est facultative, et son titre est exact.** Des chapitres n'en ont
pas ; l'absence n'est pas une erreur et ne coûte aucune requête de plus, l'index
des sections étant déjà en main. Le repli approximatif qui sert aux résumés est
refusé ici : en français, « Notes » est un mot assez commun pour qu'une page
portant « Notes et références » y réponde, et une bibliographie stockée comme un
récit serait un passage de citations auquel un fait pourrait s'ancrer.

## Ce qui ne change pas, et pourquoi la règle tenait ailleurs

**Aucune requête n'est construite depuis une adresse fournie.** C'était cela, le
fond de l'interdiction : une URL trouvée dans un document et suivie par le
serveur transforme un import en falsification de requête côté serveur. Le champ
accepte une URL par confort, `chapterNumberFrom` en extrait les chiffres et jette
le reste, et les deux points d'entrée sont des constantes du module. Un chapitre
est un entier ; il ne peut désigner aucun hôte.

**L'ancrage des preuves est intact.** Ce qui est stocké est découpé par
`splitPassages` comme n'importe quel texte, et toute proposition devra citer un
passage mot pour mot. Le texte vient d'ailleurs ; il n'entre pas plus facilement.

**La frontière est intacte.** Un résumé récupéré pour le chapitre N porte
`chapter_number = N`, comme un résumé écrit.

## Ce que cela coûte

**Le wiki en sait plus que le lecteur.** Une page de chapitre est rédigée après
coup, par des gens qui connaissent la suite, et sa section « Long Summary » peut
nommer un personnage par un nom révélé bien plus tard. Le pipeline ne corrige
pas cela : il extrait ce que le texte dit. C'est le seul endroit où cette
fonctionnalité peut introduire un spoiler — pas par le modèle, par la source. Le
remède est le même que pour un résumé mal écrit : relire ce qui a été récupéré,
qui reste modifiable avant l'import.

**Le wiki français est en retard.** Des centaines de chapitres n'ont pas de
« Résumé approfondi ». L'absence n'est pas une erreur : l'anglais devient alors
le texte citable et il n'y a pas d'aide au nommage. Ce qui serait une faute
serait de ne pas le dire, donc chaque manque revient avec sa raison.

**Le contenu est celui de Fandom, sous CC BY-SA.** Stocké dans une bibliothèque
privée pour un lecteur, ce qui est l'usage de cet outil. Toute publication
tirée de ce graphe devrait l'attribution au wiki.

## Alternatives écartées

**Analyser le HTML avec une dépendance.** L'entrée n'est pas du HTML arbitraire :
c'est la sortie d'un seul moteur de rendu, dont les meubles — liens d'édition,
appels de note, tableaux de navigation — se reconnaissent par balise ou par
classe. Un convertisseur de trente lignes, testé, contre une dépendance de plus.

**Récupérer aussi les infobox pour en tirer des relations.** Séduisant : les
champs « Affiliations », « Devil Fruit », « Owner » sont des relations
structurées, gratuites et sans modèle. Écarté ici parce qu'une infobox décrit
l'état du personnage **à la fin de l'œuvre**, sans date : injectée telle quelle,
elle donne au chapitre 1 des affiliations révélées au chapitre 900. Ce serait
le spoiler parfait, produit par le système bâti pour l'empêcher. À reprendre
seulement avec une réponse à « depuis quel chapitre ce champ est-il vrai ».
