# ADR 0011 — Une illustration porte la période qu'elle montre

**Statut** : accepté · **Date** : 2026-08-13

## Contexte

L'ADR 0007 a réglé *quand* un portrait peut apparaître : au chapitre qui révèle
le libellé l'ayant trouvé. C'est la bonne colonne, et elle ne dit rien de
*quel* portrait.

Entre la dernière page du chapitre 597 et la première du 598, il se passe deux
ans. Tout le monde revient changé, et les changements ne sont pas cosmétiques :
la cicatrice en travers du torse de Luffy, l'œil perdu de Zoro, Franky
reconstruit. Ce sont les conséquences de l'arc qui les précède.

Or « Nami » est nommée au chapitre 8, donc son image est visible dès le
chapitre 8 — et l'image que le wiki renvoie pour ce nom est celle qui est en
haut de la fiche aujourd'hui. Mesuré le 2026-08-13 : pour Nami, Luffy, Zoro,
Vivi, Koby, Buggy, Smoker, Sengoku et Rob Lucci, cette image est **sans
exception** celle d'après l'ellipse. Un lecteur au chapitre 40 regardait donc
la femme que Nami devient six cents chapitres plus loin, servie par la
fonctionnalité dont le seul métier est d'empêcher exactement cela.

Les trois catalogues ne sont pas mieux lotis : ils livrent un portrait par
personnage et ne disent rien de la période qu'il montre.

## Décision

**Une image porte la période qu'elle montre**, `pre_timeskip`,
`post_timeskip` ou `unknown`, et la frontière la vérifie — dans la base, par la
politique qui vérifiait déjà le chapitre. Voir
`drizzle/0022_a_face_from_before_the_ellipsis.sql`.

**Le wiki date ses fichiers, et c'est la seule source qui le fasse.** La
convention est `<Nom> <Manga|Anime> <Pre|Post> Timeskip Infobox.png`. Une seule
requête MediaWiki rend l'image de tête *et* la liste des fichiers de la fiche —
`prop=pageimages|images` — donc dater un personnage coûte ce que coûtait déjà le
repli, plus une requête pour l'adresse des fichiers retenus.

**Un personnage que les catalogues ont su placer est quand même porté au
wiki**, non pour l'identifier à nouveau mais pour le dater, et avec le nom
anglais du catalogue plutôt que le libellé français du graphe : « Barbe
Blanche » ne trouve rien, « Edward Newgate » trouve tout. Seules les images
datées sont conservées de ce passage ; l'image de tête serait un second
portrait sans date d'un sujet qui en a déjà un.

**On exige le mot du wiki pour un portrait de référence** — `infobox` ou
`portrait` — et un mot du titre de la fiche. Le premier écarte les rendus de
jeux vidéo, qui sont datés, à l'effigie du personnage, et ne sont pas des
portraits ; sans lui il faudrait tenir la liste de tous les jeux de la
franchise. Le second écarte ce que les modèles de page traînent avec eux : la
fiche de Koby contient réellement `153rd Branch Infobox.png`.

**Le manga plutôt que l'anime**, à égalité par ailleurs. C'est un compagnon de
lecture d'un manga ; les planches sont ce que vous venez de tourner. Le wiki
nomme les deux séparément, la préférence ne coûte rien.

**`unknown` est une valeur, pas un trou.** Lire le silence des catalogues comme
« c'est le dessin actuel, donc d'après l'ellipse » et masquer ces images
viderait le graphe de ses visages sur la foi d'une supposition — le signal
faible que ce domaine refuse partout. Une image sans date reste visible à toutes
les positions ; seule une image **que sa source nomme** d'après l'ellipse est
retenue avant le chapitre 598.

**Les deux règles se composent.** Un portrait d'avant l'ellipse reste invisible
tant que le nom qui l'a trouvé n'est pas révélé. La période ne relâche jamais la
frontière ; elle s'y ajoute.

## Conséquences

Une entité peut désormais tenir plusieurs images — le portrait sans date du
catalogue, et celui du wiki de chaque côté de l'ellipse. Le choix se fait à la
lecture, par position de lecteur : sa propre période d'abord, puis le sans-date,
puis l'autre période — cette dernière n'étant atteignable qu'après le chapitre
598, où un portrait d'avant est démodé et non révélateur.

Mesuré sur les articles réels : les neuf membres de l'équipage, Vivi, Law,
Teach, Perona, Koby, Buggy, Smoker, Sengoku, Rob Lucci, Kaya et Makino sont
datés des deux côtés. Ace, Bellemere, Kuina, Shanks, Mihawk et Jinbe ne le sont
pas — leur fiche ne porte qu'une image sans marqueur, ce qui est correct pour
ceux que l'ellipse n'a pas changés et une limite acceptée pour les autres : ils
gardent une illustration sans date, comme avant.

Une bibliothèque déjà illustrée ne bénéficie de rien tant qu'on ne le demande
pas : la passe d'enrichissement saute ce qui a déjà un visage. `/reglages` porte
donc un second bouton, « Redater les portraits déjà trouvés », qui ajoute sans
remplacer.

Le coût réseau : une requête MediaWiki de plus par personnage rapproché, plus
une pour les adresses. Sur la passe automatique de quinze entités par chapitre,
quelques secondes.

## Alternatives écartées

**Masquer toute image sans date avant le 598.** Le plus sûr, et faux : la
quasi-totalité des portraits viennent des catalogues et sont sans date. Le
graphe perdrait ses visages jusqu'au chapitre 598 pour se prémunir contre une
supposition, alors que la majorité des personnages ne changent pas d'apparence.

**Choisir la bonne image au moment de l'enrichissement.** L'enrichissement
parcourt toute la bibliothèque d'un coup et le lecteur se déplace ensuite ;
choisir là reviendrait à faire dépendre le visage affiché du moment où la passe
a tourné.

**Deviner la période depuis le chapitre de première apparition de l'entité.** Un
personnage introduit au chapitre 3 apparaît aussi au chapitre 900. La période
est une propriété de l'image, pas de l'entité.

**La sous-page `/Gallery` du wiki.** Testée : elle existe pour une petite
minorité des personnages — Shanks, Buggy, Crocodile, Koby n'en ont pas — et
compte jusqu'à 337 fichiers là où elle existe. La fiche elle-même en liste
quelques dizaines et porte les images d'infobox, qui sont précisément celles
qu'on cherche.
